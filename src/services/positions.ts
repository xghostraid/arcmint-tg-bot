import { formatUnits, parseAbiItem, type Hex } from 'viem';
import { env } from '../config/env.js';
import { publicClient } from '../chain/client.js';
import { erc20Abi, launchFactoryAbi } from '../chain/abis.js';
import { getTokenBalance, getTokenMeta, getUsdcBalance } from './balances.js';
import {
  formatPnlShort,
  getPositionPnl,
  listKnownTokensForUser,
  rememberToken,
  type PositionPnl,
} from '../db/store.js';
import {
  formatQuoteHuman,
  formatUsdc,
  quoteTokenToUsdc,
  quoteUsdcToToken,
} from './swap.js';
import { cacheGet, cacheGetOrSet, cacheSet } from './cache.js';

export type TokenHolding = {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  raw: bigint;
  formatted: string;
};

export type EnrichedPosition = TokenHolding & {
  isUsdc: boolean;
  valueUsdc: number;
  priceUsdc: number | null;
  marketCapUsdc: number | null;
  holders: number | null;
  totalSupplyHuman: string | null;
  pnl: PositionPnl | null;
};

function blockscoutBase(): string | null {
  const raw = (process.env.ARC_BLOCKSCOUT_URL || '').replace(/\/$/, '');
  if (!raw) return null;
  if (raw.includes('arc-mainnet.cloud.blockscout.com')) return null;
  return raw;
}

type BlockscoutTokenRow = {
  balance?: string;
  contractAddress?: string;
  decimals?: string | number;
  name?: string;
  symbol?: string;
  type?: string;
};

function fmtAmount(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(3)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(3)}K`;
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toPrecision(3);
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toPrecision(3)}`;
}

export async function fetchWalletHoldings(
  owner: `0x${string}`,
  tgId?: number,
): Promise<{ holdings: TokenHolding[]; source: string }> {
  try {
    const fromExplorer = await fetchFromBlockscout(owner);
    if (fromExplorer.length > 0) {
      if (tgId != null) {
        for (const h of fromExplorer) {
          if (h.address.toLowerCase() !== env.usdc().toLowerCase()) {
            await rememberToken(tgId, h.address, h.symbol, h.decimals);
          }
        }
      }
      return { holdings: fromExplorer, source: 'explorer' };
    }
  } catch (e) {
    console.warn('[positions] blockscout failed', e instanceof Error ? e.message : e);
  }

  const fallback = await fetchViaRpc(owner, tgId);
  return { holdings: fallback, source: 'rpc' };
}

async function fetchFromBlockscout(owner: `0x${string}`): Promise<TokenHolding[]> {
  const base = blockscoutBase();
  if (!base) return [];
  const url = `${base}/api?module=account&action=tokenlist&address=${owner}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      status?: string;
      message?: string;
      result?: BlockscoutTokenRow[] | string;
    };
    if (!Array.isArray(data.result)) return [];

    const holdings: TokenHolding[] = [];
    for (const row of data.result) {
      if (row.type && row.type !== 'ERC-20') continue;
      const addr = row.contractAddress;
      if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
      let decimals = Number(row.decimals ?? 18);
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) decimals = 18;
      let raw = 0n;
      try {
        raw = BigInt(row.balance || '0');
      } catch {
        continue;
      }
      if (raw <= 0n) continue;
      const symbol = (row.symbol || '???').slice(0, 24);
      const name = (row.name || symbol).slice(0, 48);
      holdings.push({
        address: addr as `0x${string}`,
        symbol,
        name,
        decimals,
        raw,
        formatted: fmtAmount(raw, decimals),
      });
    }

    const usdc = env.usdc().toLowerCase();
    holdings.sort((a, b) => {
      const aU = a.address.toLowerCase() === usdc ? 1 : 0;
      const bU = b.address.toLowerCase() === usdc ? 1 : 0;
      if (aU !== bU) return bU - aU;
      if (a.raw === b.raw) return a.symbol.localeCompare(b.symbol);
      return a.raw > b.raw ? -1 : 1;
    });
    return holdings;
  } finally {
    clearTimeout(t);
  }
}

async function fetchViaRpc(
  owner: `0x${string}`,
  tgId?: number,
): Promise<TokenHolding[]> {
  const holdings: TokenHolding[] = [];

  try {
    const usdc = await getUsdcBalance(owner);
    if (usdc.raw > 0n) {
      holdings.push({
        address: env.usdc(),
        symbol: 'USDC',
        name: 'USDC',
        decimals: 6,
        raw: usdc.raw,
        formatted: fmtAmount(usdc.raw, 6),
      });
    }
  } catch {
    /* skip */
  }

  const known = tgId != null ? await listKnownTokensForUser(tgId) : [];
  await Promise.all(
    known.map(async (t) => {
      try {
        const addr = t.address as `0x${string}`;
        if (addr.toLowerCase() === env.usdc().toLowerCase()) return;
        const raw = await getTokenBalance(addr, owner);
        if (raw <= 0n) return;
        let symbol = t.symbol;
        let decimals = t.decimals;
        try {
          const meta = await getTokenMeta(addr);
          symbol = meta.symbol;
          decimals = meta.decimals;
        } catch {
          /* use stored */
        }
        holdings.push({
          address: addr,
          symbol,
          name: symbol,
          decimals,
          raw,
          formatted: fmtAmount(raw, decimals),
        });
      } catch {
        /* skip */
      }
    }),
  );

  return holdings;
}

type TokenMetaRemote = {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint | null;
  holders: number | null;
  marketCapUsdc: number | null;
};

const ZERO = '0x0000000000000000000000000000000000000000';
const poolMcapAbi = [
  {
    type: 'function',
    name: 'marketCapUsdc',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

async function fetchJsonTimed(url: string, ms: number): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function dexScreenerStats(address: string): Promise<{
  name?: string;
  symbol?: string;
  marketCapUsdc?: number;
  priceUsd?: number;
} | null> {
  const d = (await fetchJsonTimed(
    `https://api.dexscreener.com/latest/dex/tokens/${address}`,
    4_000,
  )) as { pairs?: Array<Record<string, unknown>> } | null;
  const want = address.toLowerCase();
  const matching = (d?.pairs || []).filter((p) => {
    const base = p.baseToken as { address?: string } | undefined;
    return (base?.address || '').toLowerCase() === want;
  });
  const arc = matching.filter((p) => {
    const chain = String(p.chainId || '').toLowerCase();
    return chain === 'arc' || chain === '5042' || chain.includes('arc');
  });
  const pairs = arc.length ? arc : matching;
  if (!pairs.length) return null;
  pairs.sort(
    (a, b) =>
      Number((b.liquidity as { usd?: number } | undefined)?.usd || 0) -
      Number((a.liquidity as { usd?: number } | undefined)?.usd || 0),
  );
  const p = pairs[0];
  const base = p.baseToken as { name?: string; symbol?: string };
  const mc = Number(p.marketCap || p.fdv || 0);
  const price = Number(p.priceUsd || 0);
  return {
    name: base?.name,
    symbol: base?.symbol,
    marketCapUsdc: Number.isFinite(mc) && mc > 0 ? mc : undefined,
    priceUsd: Number.isFinite(price) && price > 0 ? price : undefined,
  };
}

async function geckoStats(address: string): Promise<{
  holders: number | null;
  marketCapUsdc: number | null;
  name?: string;
  symbol?: string;
}> {
  const addr = address.toLowerCase();
  const [info, token] = await Promise.all([
    fetchJsonTimed(
      `https://api.geckoterminal.com/api/v2/networks/arc/tokens/${addr}/info`,
      4_000,
    ) as Promise<{ data?: { attributes?: Record<string, unknown> } } | null>,
    fetchJsonTimed(
      `https://api.geckoterminal.com/api/v2/networks/arc/tokens/${addr}`,
      4_000,
    ) as Promise<{ data?: { attributes?: Record<string, unknown> } } | null>,
  ]);
  const infoA = info?.data?.attributes || {};
  const tokA = token?.data?.attributes || {};
  const holders = Number((infoA.holders as { count?: number } | undefined)?.count);
  const mc = Number(tokA.market_cap_usd || tokA.fdv_usd || 0);
  return {
    holders: Number.isFinite(holders) && holders > 0 ? holders : null,
    marketCapUsdc: Number.isFinite(mc) && mc > 0 ? mc : null,
    name: typeof tokA.name === 'string' ? tokA.name : undefined,
    symbol: typeof tokA.symbol === 'string' ? tokA.symbol : undefined,
  };
}

async function arcmintStats(address: string): Promise<{
  name?: string;
  symbol?: string;
  marketCapUsdc?: number;
  holders?: number;
} | null> {
  const d = (await fetchJsonTimed(
    `https://arcmint.fun/api/tokens/${address}`,
    4_000,
  )) as { token?: Record<string, unknown>; error?: string } | null;
  const t = d?.token;
  if (!t || typeof t !== 'object') return null;
  const rawMc = Number(t.mcapUsdc);
  // Indexer stores 6-decimal USDC integers ("750000" → $0.75)
  const mc =
    Number.isFinite(rawMc) && rawMc > 0 ? rawMc / 1e6 : null;
  const holders = Number(t.holderCount);
  return {
    name: typeof t.name === 'string' ? t.name : undefined,
    symbol: typeof t.symbol === 'string' ? t.symbol : undefined,
    marketCapUsdc: mc && mc > 0 ? mc : undefined,
    holders: Number.isFinite(holders) && holders > 0 ? holders : undefined,
  };
}

async function onChainSupply(token: `0x${string}`): Promise<bigint | null> {
  try {
    const v = (await withTimeout(
      publicClient().readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'totalSupply',
      }) as Promise<bigint>,
      5_000,
      'totalSupply',
    )) as bigint;
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
}

type FactoryLaunch = {
  pool: `0x${string}`;
  creator: `0x${string}`;
  createdAt: number;
  name: string;
  symbol: string;
  mcapUsdc: number | null;
};

async function factoryLaunch(token: `0x${string}`): Promise<FactoryLaunch | null> {
  try {
    const raw = (await withTimeout(
      publicClient().readContract({
        address: env.launchFactory(),
        abi: launchFactoryAbi,
        functionName: 'launches',
        args: [token],
      }) as Promise<readonly unknown[]>,
      4_000,
      'launches',
    )) as readonly unknown[];
    const pool = String(raw?.[1] || '');
    if (!pool.startsWith('0x') || pool.toLowerCase() === ZERO) return null;
    const creator = String(raw?.[2] || ZERO) as `0x${string}`;
    const createdAt = Number(raw?.[3] || 0);
    const name = String(raw?.[4] || '');
    const symbol = String(raw?.[5] || '');
    let mcapUsdc: number | null = null;
    try {
      const mcap = (await withTimeout(
        publicClient().readContract({
          address: pool as `0x${string}`,
          abi: poolMcapAbi,
          functionName: 'marketCapUsdc',
        }) as Promise<bigint>,
        4_000,
        'curve mcap',
      )) as bigint;
      const n = Number(formatUnits(mcap, 6));
      if (Number.isFinite(n) && n > 0) mcapUsdc = n;
    } catch {
      /* */
    }
    return { pool: pool as `0x${string}`, creator, createdAt, name, symbol, mcapUsdc };
  } catch {
    return null;
  }
}

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

const FACTORY_DEPLOY_BLOCK = 21_145_534n;

async function blockNearUnix(ts: number): Promise<bigint | null> {
  if (!ts || ts < 1_700_000_000) return null;
  try {
    const client = publicClient();
    const latest = await withTimeout(client.getBlockNumber(), 2_000, 'block');
    const [start, tip] = await Promise.all([
      withTimeout(client.getBlock({ blockNumber: FACTORY_DEPLOY_BLOCK }), 2_500, 'b0'),
      withTimeout(client.getBlock({ blockNumber: latest }), 2_500, 'b1'),
    ]);
    const t0 = Number(start.timestamp);
    const t1 = Number(tip.timestamp);
    if (!(t1 > t0)) return latest;
    const frac = Math.min(1, Math.max(0, (ts - t0) / (t1 - t0)));
    const est = Number(FACTORY_DEPLOY_BLOCK) + Math.floor(frac * Number(latest - FACTORY_DEPLOY_BLOCK));
    return BigInt(Math.max(Number(FACTORY_DEPLOY_BLOCK), est - 2_000));
  } catch {
    return null;
  }
}

/** Unique Transfer from/to. Needs a tight fromBlock — Arc RPC caps log range at ~9k. */
async function holdersFromTransfers(
  token: `0x${string}`,
  fromBlock: bigint | null,
): Promise<number | null> {
  if (fromBlock == null) return null;
  try {
    const client = publicClient();
    const latest = await withTimeout(client.getBlockNumber(), 2_000, 'block');
    let from = fromBlock;
    const maxSpan = 8_000n;
    if (latest > from && latest - from > maxSpan) {
      // Walk forward in 8k chunks from launch, cap 6 requests
      const set = new Set<string>();
      let cursor = from;
      for (let i = 0; i < 6 && cursor <= latest; i++) {
        const to = cursor + maxSpan > latest ? latest : cursor + maxSpan;
        try {
          const logs = await withTimeout(
            client.getLogs({
              address: token,
              event: TRANSFER_EVENT,
              fromBlock: cursor,
              toBlock: to,
            }),
            2_000,
            'transfer logs',
          );
          for (const log of logs) {
            const args = log.args as { from?: string; to?: string };
            if (args.from && args.from.toLowerCase() !== ZERO) set.add(args.from.toLowerCase());
            if (args.to && args.to.toLowerCase() !== ZERO) set.add(args.to.toLowerCase());
          }
        } catch {
          /* next chunk */
        }
        cursor = to + 1n;
      }
      return set.size > 0 ? set.size : null;
    }
    const logs = await withTimeout(
      client.getLogs({
        address: token,
        event: TRANSFER_EVENT,
        fromBlock: from,
        toBlock: 'latest',
      }),
      2_500,
      'transfer logs',
    );
    const set = new Set<string>();
    for (const log of logs) {
      const args = log.args as { from?: string; to?: string };
      if (args.from && args.from.toLowerCase() !== ZERO) set.add(args.from.toLowerCase());
      if (args.to && args.to.toLowerCase() !== ZERO) set.add(args.to.toLowerCase());
    }
    return set.size > 0 ? set.size : null;
  } catch {
    return null;
  }
}

async function fetchTokenMetaRemote(address: `0x${string}`): Promise<TokenMetaRemote | null> {
  const key = `meta:${address.toLowerCase()}`;
  const hit = cacheGet<TokenMetaRemote>(key);
  if (hit && (hit.marketCapUsdc || hit.holders || hit.totalSupply)) return hit;

  const [dex, gecko, mint, supply, launch] = await Promise.all([
    dexScreenerStats(address),
    geckoStats(address),
    arcmintStats(address),
    onChainSupply(address),
    factoryLaunch(address),
  ]);

  let holders = gecko.holders ?? mint?.holders ?? null;
  if (holders == null && launch?.createdAt) {
    const from = await blockNearUnix(launch.createdAt);
    holders = await holdersFromTransfers(address, from);
  }

  const totalSupply = supply;
  const marketCapUsdc =
    dex?.marketCapUsdc ??
    gecko.marketCapUsdc ??
    launch?.mcapUsdc ??
    mint?.marketCapUsdc ??
    null;
  const symbol = (dex?.symbol || gecko.symbol || mint?.symbol || launch?.symbol || '').slice(0, 24);
  const name = (dex?.name || gecko.name || mint?.name || launch?.name || symbol).slice(0, 48);
  if (!marketCapUsdc && holders == null && totalSupply == null && !symbol) return null;

  const meta: TokenMetaRemote = {
    name: name || 'Token',
    symbol: symbol || '',
    decimals: 18,
    totalSupply,
    holders,
    marketCapUsdc,
  };
  cacheSet(key, meta, marketCapUsdc || holders ? 45_000 : 10_000);
  return meta;
}

const ARC_USDC_DECIMALS = 6;

function usdcOutToNumber(amountOut: bigint): number {
  return Number(formatUnits(amountOut, ARC_USDC_DECIMALS));
}

async function spotPriceUsdc(
  token: `0x${string}`,
  decimals: number,
  balanceRaw: bigint,
): Promise<number | null> {
  const key = `spot:${token.toLowerCase()}`;
  return cacheGetOrSet(key, 20_000, async () => {
    const one = 10n ** BigInt(decimals);
    const candidates: bigint[] = [];
    if (balanceRaw > 0n && balanceRaw < one * 50_000n) candidates.push(balanceRaw);
    else if (balanceRaw > 0n) candidates.push(balanceRaw / 100n || balanceRaw);
    candidates.push(one * 1_000n, one);

    for (const sample of candidates) {
      if (sample <= 0n) continue;
      try {
        const q = await quoteTokenToUsdc(token, sample);
        if (!q || q.amountOut <= 0n) continue;
        const out = usdcOutToNumber(q.amountOut);
        const tokensIn = Number(formatUnits(sample, decimals));
        if (!(tokensIn > 0) || !(out > 0) || !Number.isFinite(out / tokensIn)) continue;
        return out / tokensIn;
      } catch {
        /* next */
      }
    }
    return null;
  });
}

async function markValueUsdc(
  token: `0x${string}`,
  decimals: number,
  balanceRaw: bigint,
  spot: number | null,
): Promise<number> {
  if (balanceRaw <= 0n) return 0;
  try {
    const q = await quoteTokenToUsdc(token, balanceRaw);
    if (q && q.amountOut > 0n) {
      const v = usdcOutToNumber(q.amountOut);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch {
    /* fall through */
  }
  if (spot != null && spot > 0) {
    const amt = Number(formatUnits(balanceRaw, decimals));
    if (Number.isFinite(amt) && amt > 0) return spot * amt;
  }
  return 0;
}

/**
 * Enrich holdings. `light: true` = list UIs only (1 quote, no Blockscout).
 */
export async function enrichPositions(
  holdings: TokenHolding[],
  tgId: number,
  opts?: { limit?: number; light?: boolean },
): Promise<EnrichedPosition[]> {
  const limit = opts?.limit ?? 12;
  const light = opts?.light === true;
  const usdcAddr = env.usdc().toLowerCase();
  const slice = holdings.slice(0, limit);

  const enriched = await Promise.all(
    slice.map(async (h): Promise<EnrichedPosition> => {
      const isUsdc = h.address.toLowerCase() === usdcAddr;
      if (isUsdc) {
        const dec = h.decimals === 18 ? 6 : h.decimals;
        const valueUsdc = Number(formatUnits(h.raw, dec === 6 ? 6 : h.decimals));
        const formatted = dec === 6 ? fmtAmount(h.raw, 6) : h.formatted;
        return {
          ...h,
          decimals: 6,
          formatted,
          isUsdc: true,
          valueUsdc: Number.isFinite(valueUsdc) ? valueUsdc : 0,
          priceUsdc: 1,
          marketCapUsdc: null,
          holders: null,
          totalSupplyHuman: null,
          pnl: null,
        };
      }

      const decimals = h.decimals || 18;

      if (light) {
        let valueUsdc = 0;
        let priceUsdc: number | null = null;
        if (h.raw > 0n) {
          try {
            const q = await quoteTokenToUsdc(h.address, h.raw);
            if (q && q.amountOut > 0n) {
              valueUsdc = usdcOutToNumber(q.amountOut);
              const amtHuman = Number(formatUnits(h.raw, decimals));
              if (amtHuman > 0 && valueUsdc > 0) priceUsdc = valueUsdc / amtHuman;
            }
          } catch {
            /* */
          }
        }
        const pnl = await getPositionPnl(tgId, h.address, h.raw, valueUsdc);
        return {
          ...h,
          name: h.name || h.symbol,
          symbol: h.symbol,
          decimals,
          formatted: fmtAmount(h.raw, decimals),
          isUsdc: false,
          valueUsdc,
          priceUsdc,
          marketCapUsdc: null,
          holders: null,
          totalSupplyHuman: null,
          pnl,
        };
      }

      const remote = await fetchTokenMetaRemote(h.address);
      const name = remote?.name || h.name;
      const symbol = remote?.symbol || h.symbol;
      const rDec = remote?.decimals || decimals;

      const spot = await spotPriceUsdc(h.address, rDec, h.raw);
      const valueUsdc =
        h.raw > 0n ? await markValueUsdc(h.address, rDec, h.raw, spot) : 0;

      let priceUsdc: number | null = spot;
      const amtHuman = Number(formatUnits(h.raw, rDec));
      if (valueUsdc > 0 && Number.isFinite(amtHuman) && amtHuman > 0) {
        const implied = valueUsdc / amtHuman;
        if (Number.isFinite(implied) && implied > 0) priceUsdc = implied;
      }

      let marketCapUsdc: number | null = remote?.marketCapUsdc ?? null;
      let totalSupplyHuman: string | null = null;
      if (remote?.totalSupply != null) {
        totalSupplyHuman = fmtAmount(remote.totalSupply, rDec);
        if (marketCapUsdc == null && priceUsdc != null && priceUsdc > 0) {
          const supplyHuman = Number(formatUnits(remote.totalSupply, rDec));
          if (Number.isFinite(supplyHuman) && supplyHuman > 0) {
            marketCapUsdc = priceUsdc * supplyHuman;
            if (!Number.isFinite(marketCapUsdc) || marketCapUsdc > 1e15) {
              marketCapUsdc = null;
            }
          }
        }
      }

      const pnl = await getPositionPnl(tgId, h.address, h.raw, valueUsdc);

      return {
        ...h,
        name,
        symbol,
        decimals: rDec,
        formatted: fmtAmount(h.raw, rDec),
        isUsdc: false,
        valueUsdc,
        priceUsdc,
        marketCapUsdc,
        holders: remote?.holders ?? null,
        totalSupplyHuman,
        pnl,
      };
    }),
  );

  enriched.sort((a, b) => {
    if (a.isUsdc !== b.isUsdc) return a.isUsdc ? -1 : 1;
    return b.valueUsdc - a.valueUsdc;
  });

  return enriched;
}

export function formatPnlCompact(pnl: PositionPnl | null | undefined): string {
  if (!pnl?.hasBasis) return '—';
  const up = pnl.unrealizedUsdc >= 0;
  const sign = up ? '+' : '-';
  const usd = Math.abs(pnl.unrealizedUsdc).toFixed(2);
  const pct =
    pnl.unrealizedPct == null
      ? ''
      : ` (${up ? '+' : ''}${pnl.unrealizedPct.toFixed(1)}%)`;
  return `${sign}$${usd}${pct}`;
}

export type PortfolioPnlCard = {
  tokensMarkUsdc: number;
  cashUsdc: number;
  totalUsdc: number;
  costUsdc: number;
  unrealizedUsdc: number;
  unrealizedPct: number | null;
  realizedUsdc: number;
  trackedCount: number;
};

export function buildPortfolioPnlCard(
  positions: EnrichedPosition[],
  lifetimeRealizedUsdc: number,
): PortfolioPnlCard {
  const cash = positions.filter((p) => p.isUsdc);
  const tokens = positions.filter((p) => !p.isUsdc);
  const cashUsdc = cash.reduce((s, p) => s + (p.valueUsdc || 0), 0);
  const tokensMarkUsdc = tokens.reduce((s, p) => s + (p.valueUsdc || 0), 0);
  let costUsdc = 0;
  let unrealizedUsdc = 0;
  let trackedCount = 0;
  for (const p of tokens) {
    if (p.pnl?.hasBasis) {
      trackedCount += 1;
      costUsdc += p.pnl.costUsdc;
      unrealizedUsdc += p.pnl.unrealizedUsdc;
    }
  }
  const unrealizedPct =
    costUsdc > 1e-9 ? (unrealizedUsdc / costUsdc) * 100 : null;
  return {
    tokensMarkUsdc,
    cashUsdc,
    totalUsdc: cashUsdc + tokensMarkUsdc,
    costUsdc,
    unrealizedUsdc,
    unrealizedPct,
    realizedUsdc: lifetimeRealizedUsdc,
    trackedCount,
  };
}

/** Positions list: totals + per-token rows (no text PnL box). */
export function formatPortfolioMessage(
  owner: string,
  positions: EnrichedPosition[],
  _source: string,
  _lifetimeRealizedUsdc = 0,
): string {
  let totalValue = 0;
  for (const p of positions) totalValue += p.valueUsdc || 0;

  const cash = positions.filter((p) => p.isUsdc);
  const tokens = positions.filter((p) => !p.isUsdc);
  const cashValue = cash.reduce((s, p) => s + (p.valueUsdc || 0), 0);

  const lines: string[] = [
    `*Positions*`,
    `\`${owner}\``,
    ``,
    `*Total*  \`${fmtUsd(totalValue)}\``,
    `USDC  \`${fmtUsd(cashValue)}\``,
  ];

  if (tokens.length === 0) {
    lines.push(``);
    lines.push(cash.length ? `_No open token positions_` : `_Empty_`);
    return lines.join('\n');
  }

  lines.push(``);

  for (const p of tokens) {
    const mc = p.marketCapUsdc != null ? fmtUsd(p.marketCapUsdc) : '—';
    const holders =
      p.holders != null ? p.holders.toLocaleString() : '—';
    const pnl = formatPnlCompact(p.pnl);
    const emoji =
      p.pnl?.hasBasis && p.pnl.unrealizedUsdc < 0
        ? '🔴'
        : p.pnl?.hasBasis
          ? '🟢'
          : '⚪';

    lines.push(`${emoji} ${tokenNameLink(p.symbol, p.address)}`);
    if (!p.isUsdc && (p.marketCapUsdc != null || p.holders != null)) {
      lines.push(`MC \`${mc}\`  ·  👥 \`${holders}\``);
    }
    lines.push(`\`${p.formatted}\`  ·  \`${fmtUsd(p.valueUsdc)}\``);
    lines.push(`PnL  \`${pnl}\``);
    lines.push(``);
  }

  lines.push(`_Tap a token name for full info_`);
  return lines.join('\n').trimEnd();
}

export function formatTokenDetail(p: EnrichedPosition): string {
  if (p.isUsdc) {
    return `*USDC*\n\`${p.formatted}\`  ·  \`${fmtUsd(p.valueUsdc)}\``;
  }
  const mc = p.marketCapUsdc != null ? fmtUsd(p.marketCapUsdc) : '—';
  const holders =
    p.holders != null ? p.holders.toLocaleString() : '—';
  const pnl = formatPnlCompact(p.pnl);
  const price =
    p.priceUsdc != null && p.priceUsdc > 0 ? fmtUsd(p.priceUsdc) : '—';
  return [
    tokenNameLink(p.symbol, p.address),
    ``,
    `Price  \`${price}\``,
    `MC  \`${mc}\``,
    `Holders  \`${holders}\``,
    `Have  \`${p.formatted}\`  ·  \`${fmtUsd(p.valueUsdc)}\``,
    `PnL  \`${pnl}\``,
  ].join('\n');
}

/**
 * Fast token card for paste/buy — no enrichPositions double-pass.
 * One parallel batch: balance + meta + buy quote + optional remote (short).
 */
export async function buildTokenCard(opts: {
  token: `0x${string}`;
  owner?: `0x${string}` | null;
  tgId: number;
  feeExempt?: boolean;
  sampleUsdc?: string;
  slippageBps?: number;
  feeLine?: string;
}): Promise<{
  text: string;
  symbol: string;
  decimals: number;
  hasBalance: boolean;
  priceUsdc: number | null;
  marketCapUsdc: number | null;
}> {
  const { token, tgId } = opts;
  const sample = opts.sampleUsdc || env.buyPresets()[0] || '10';

  const [raw, meta, buyQuote, remote] = await Promise.all([
    opts.owner
      ? getTokenBalance(token, opts.owner).catch(() => 0n)
      : Promise.resolve(0n),
    getTokenMeta(token).catch(() => ({ symbol: '', name: '', decimals: 18 })),
    quoteUsdcToToken(token, sample, true, opts.feeExempt ?? false).catch(() => null),
    fetchTokenMetaRemote(token),
  ]);

  const symbol =
    (remote?.symbol && remote.symbol !== '???') ? remote.symbol : meta.symbol || 'TOKEN';
  const decimals = meta.decimals || remote?.decimals || 18;
  const name =
    (remote?.name && remote.name !== 'Token') ? remote.name : meta.name || symbol;

  let valueUsdc = 0;
  let priceUsdc: number | null = null;

  // Derive price from buy quote sample (already fetched) — avoids extra RPC
  if (buyQuote && buyQuote.amountOut > 0n && buyQuote.amountIn > 0n) {
    const tokensOut = Number(formatUnits(buyQuote.amountOut, decimals));
    const usdcIn = Number(formatUnits(buyQuote.amountIn, 6));
    if (tokensOut > 0 && usdcIn > 0) {
      priceUsdc = usdcIn / tokensOut;
    }
  }

  if (raw > 0n && priceUsdc != null) {
    const amt = Number(formatUnits(raw, decimals));
    if (Number.isFinite(amt)) valueUsdc = amt * priceUsdc;
  } else if (raw > 0n) {
    // Only if we still have no price: one bag quote
    try {
      const q = await quoteTokenToUsdc(token, raw);
      if (q && q.amountOut > 0n) {
        valueUsdc = usdcOutToNumber(q.amountOut);
        const amt = Number(formatUnits(raw, decimals));
        if (amt > 0) priceUsdc = valueUsdc / amt;
      }
    } catch {
      /* */
    }
  }

  let marketCapUsdc: number | null = remote?.marketCapUsdc ?? null;
  if (marketCapUsdc == null && remote?.totalSupply != null && priceUsdc != null && priceUsdc > 0) {
    const supplyHuman = Number(formatUnits(remote.totalSupply, decimals));
    if (Number.isFinite(supplyHuman) && supplyHuman > 0) {
      marketCapUsdc = priceUsdc * supplyHuman;
      if (!Number.isFinite(marketCapUsdc) || marketCapUsdc > 1e15) marketCapUsdc = null;
    }
  }

  const pnl = await getPositionPnl(tgId, token, raw, valueUsdc);
  const holders =
    remote?.holders != null ? remote.holders.toLocaleString() : '—';
  const price = priceUsdc != null && priceUsdc > 0 ? fmtUsd(priceUsdc) : '—';
  const mc = marketCapUsdc != null ? fmtUsd(marketCapUsdc) : '—';
  const slip =
    opts.slippageBps != null ? `${(opts.slippageBps / 100).toFixed(1)}%` : null;

  let quoteLine = '_No USDC pool — try another size_';
  if (buyQuote) {
    quoteLine = formatQuoteHuman(buyQuote, symbol, decimals) + ` _($${sample})_`;
  }

  const lines = [
    tokenNameLink(symbol, token),
    name && name !== symbol ? `_${escapeMd(name)}_` : null,
    `\`${token}\``,
    ``,
    `💵 Price   \`${price}\``,
    `📊 MC      \`${mc}\``,
    `👥 Holders \`${holders}\``,
    ``,
    raw > 0n
      ? `🎒 You hold \`${fmtAmount(raw, decimals)}\`  ·  \`${fmtUsd(valueUsdc)}\`${
          pnl.hasBasis ? `\nPnL  \`${formatPnlCompact(pnl)}\`` : ''
        }`
      : `🎒 You hold \`0\``,
    ``,
    quoteLine,
    slip ? `Slippage: ${slip}` : null,
    opts.feeLine || null,
    ``,
    `_Pick a size to buy_`,
  ].filter((x) => x != null && x !== '') as string[];

  return {
    text: lines.join('\n'),
    symbol,
    decimals,
    hasBalance: raw > 0n,
    priceUsdc,
    marketCapUsdc,
  };
}

/** Home no longer uses full portfolio — kept for optional callers; light + cached. */
export async function getPortfolioTotalUsdc(
  owner: `0x${string}`,
  tgId: number,
): Promise<number> {
  const key = `pf:${tgId}:${owner.toLowerCase()}`;
  return cacheGetOrSet(key, 30_000, async () => {
    const { holdings } = await fetchWalletHoldings(owner, tgId);
    const positions = await enrichPositions(holdings, tgId, { limit: 6, light: true });
    return positions.reduce((s, p) => s + (p.valueUsdc || 0), 0);
  });
}

function escapeMd(s: string): string {
  return s.replace(/([_*`\[])/g, '\\$1');
}

export function tokenNameLink(symbol: string, address: string): string {
  const bot = env.botUsername().replace(/^@/, '');
  const safe = (symbol || 'TOKEN').replace(/[\[\]()]/g, '').slice(0, 24);
  let addr = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) addr = address;
  return `[$${safe}](https://t.me/${bot}?start=tok_${addr})`;
}

export { fmtUsd, formatPnlShort, escapeMd };
export type { Hex };
