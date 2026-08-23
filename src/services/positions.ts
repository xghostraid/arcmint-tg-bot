import { formatUnits, type Hex } from 'viem';
import { env } from '../config/env.js';
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
import { cacheGetOrSet } from './cache.js';

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
            rememberToken(tgId, h.address, h.symbol, h.decimals);
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

  const known = tgId != null ? listKnownTokensForUser(tgId) : [];
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
};

async function fetchTokenMetaRemote(address: `0x${string}`): Promise<TokenMetaRemote | null> {
  const key = `meta:${address.toLowerCase()}`;
  return cacheGetOrSet(key, 60_000, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4_000);
    try {
      const base = blockscoutBase();
      if (!base) return null;
      const res = await fetch(`${base}/api/v2/tokens/${address}`, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const d = (await res.json()) as {
        name?: string;
        symbol?: string;
        decimals?: string;
        total_supply?: string;
        holders_count?: string | number;
      };
      let totalSupply: bigint | null = null;
      try {
        if (d.total_supply) totalSupply = BigInt(d.total_supply);
      } catch {
        totalSupply = null;
      }
      const holders =
        d.holders_count != null && d.holders_count !== ''
          ? Number(d.holders_count)
          : null;
      return {
        name: (d.name || d.symbol || 'Token').slice(0, 48),
        symbol: (d.symbol || '???').slice(0, 24),
        decimals: Number(d.decimals ?? 18) || 18,
        totalSupply,
        holders: Number.isFinite(holders as number) ? (holders as number) : null,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  });
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
        const pnl = getPositionPnl(tgId, h.address, h.raw, valueUsdc);
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

      let marketCapUsdc: number | null = null;
      let totalSupplyHuman: string | null = null;
      if (remote?.totalSupply != null && priceUsdc != null && priceUsdc > 0) {
        const supplyHuman = Number(formatUnits(remote.totalSupply, rDec));
        if (Number.isFinite(supplyHuman) && supplyHuman > 0) {
          marketCapUsdc = priceUsdc * supplyHuman;
          if (!Number.isFinite(marketCapUsdc) || marketCapUsdc > 1e15) {
            marketCapUsdc = null;
          }
          totalSupplyHuman = fmtAmount(remote.totalSupply, rDec);
        }
      }

      const pnl = getPositionPnl(tgId, h.address, h.raw, valueUsdc);

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
    getTokenMeta(token).catch(() => ({ symbol: 'TOKEN', decimals: 18 })),
    quoteUsdcToToken(token, sample, true, opts.feeExempt ?? false).catch(() => null),
    fetchTokenMetaRemote(token),
  ]);

  const symbol = remote?.symbol || meta.symbol || 'TOKEN';
  const decimals = remote?.decimals || meta.decimals || 18;
  const name = remote?.name || symbol;

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

  let marketCapUsdc: number | null = null;
  if (remote?.totalSupply != null && priceUsdc != null && priceUsdc > 0) {
    const supplyHuman = Number(formatUnits(remote.totalSupply, decimals));
    if (Number.isFinite(supplyHuman) && supplyHuman > 0) {
      marketCapUsdc = priceUsdc * supplyHuman;
      if (!Number.isFinite(marketCapUsdc) || marketCapUsdc > 1e15) marketCapUsdc = null;
    }
  }

  const pnl = getPositionPnl(tgId, token, raw, valueUsdc);
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
