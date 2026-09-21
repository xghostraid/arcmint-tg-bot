/**
 * Balances via Blockscout first (works when public Arc RPC is broken),
 * with short-timeout RPC fallback.
 */
import { formatUnits, hexToString, type Hex } from 'viem';
import { publicClient } from '../chain/client.js';
import { erc20Abi, erc20Bytes32MetaAbi, launchFactoryAbi } from '../chain/abis.js';
import { env } from '../config/env.js';
import { cacheGet, cacheSet } from './cache.js';

const RPC_MS = 6_000;
const HTTP_MS = 5_000;

function blockscoutBase(): string | null {
  const raw = (process.env.ARC_BLOCKSCOUT_URL || '').replace(/\/$/, '');
  if (!raw) return null;
  if (raw.includes('arc-mainnet.cloud.blockscout.com')) return null;
  return raw;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
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

async function fetchJson(url: string, ms = HTTP_MS): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Blockscout account tokenbalance (raw string). */
async function blockscoutTokenBalance(
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint | null> {
  try {
    const base = blockscoutBase();
    if (!base) return null;
    const url =
      `${base}/api?module=account&action=tokenbalance` +
      `&contractaddress=${token}&address=${owner}`;
    const data = (await fetchJson(url)) as { result?: string; status?: string };
    if (data.result == null || data.result === '') return null;
    return BigInt(data.result);
  } catch {
    return null;
  }
}

export async function getUsdcBalance(address: `0x${string}`): Promise<{
  raw: bigint;
  formatted: string;
}> {
  const key = `bal:usdc:${address.toLowerCase()}`;
  return cacheGetOrSet(key, 12_000, async () => {
    const usdc = env.usdc();
    // 1) Blockscout (fast when RPC is dead)
    const fromBs = await blockscoutTokenBalance(usdc, address);
    if (fromBs != null) {
      return { raw: fromBs, formatted: formatUnits(fromBs, 6) };
    }
    // 2) RPC with hard timeout
    try {
      const client = publicClient();
      const raw = (await withTimeout(
        client.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }) as Promise<bigint>,
        RPC_MS,
        'usdc balanceOf',
      )) as bigint;
      return { raw, formatted: formatUnits(raw, 6) };
    } catch {
      return { raw: 0n, formatted: '0' };
    }
  });
}

function cleanTicker(raw: unknown): string {
  if (raw == null) return '';
  let s = '';
  if (typeof raw === 'string') {
    if (raw.startsWith('0x') && raw.length === 66) {
      try {
        s = hexToString(raw as Hex, { size: 32 });
      } catch {
        s = raw;
      }
    } else {
      s = raw;
    }
  } else {
    s = String(raw);
  }
  s = s.replace(/\0/g, '').replace(/[^\w.\-$]/g, '').trim();
  if (!s || /^token$/i.test(s) || s === '?' || s === '???') return '';
  return s.slice(0, 24);
}

function shortTicker(token: string): string {
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function isPlaceholderSymbol(symbol: string): boolean {
  const s = (symbol || '').trim();
  return !s || /^token$/i.test(s) || s === '???' || s.includes('…');
}

export async function getTokenMeta(token: `0x${string}`): Promise<{
  symbol: string;
  name: string;
  decimals: number;
}> {
  const key = `meta:rpc:${token.toLowerCase()}`;
  const hit = cacheGet<{ symbol: string; name: string; decimals: number }>(key);
  if (hit && hit.symbol && !/^token$/i.test(hit.symbol) && !hit.symbol.includes('…')) {
    return hit;
  }

  const client = publicClient();
  let symbol = '';
  let name = '';
  let decimals = 18;

  try {
    const raw = await withTimeout(
      client.readContract({
        address: env.launchFactory(),
        abi: launchFactoryAbi,
        functionName: 'launches',
        args: [token],
      }) as Promise<readonly unknown[]>,
      4_000,
      'factory launches',
    );
    const arr = raw as readonly unknown[];
    name = cleanTicker(arr?.[4]) || name;
    symbol = cleanTicker(arr?.[5]) || symbol;
  } catch {
    /* not an ArcMint launch, or factory call failed */
  }

  try {
    const [sym, nm, dec] = await withTimeout(
      Promise.all([
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'symbol',
        }) as Promise<string>,
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'name',
        }) as Promise<string>,
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'decimals',
        }) as Promise<number>,
      ]),
      RPC_MS,
      'token meta',
    );
    symbol = cleanTicker(sym) || symbol;
    name = cleanTicker(nm) || name;
    decimals = Number(dec) || 18;
  } catch {
    try {
      const [sym32, nm32] = await withTimeout(
        Promise.all([
          client.readContract({
            address: token,
            abi: erc20Bytes32MetaAbi,
            functionName: 'symbol',
          }) as Promise<Hex>,
          client.readContract({
            address: token,
            abi: erc20Bytes32MetaAbi,
            functionName: 'name',
          }) as Promise<Hex>,
        ]),
        4_000,
        'token meta bytes32',
      );
      symbol = cleanTicker(sym32) || symbol;
      name = cleanTicker(nm32) || name;
    } catch {
      /* */
    }
  }

  if (!symbol) {
    try {
      const base = blockscoutBase();
      if (base) {
        const data = (await fetchJson(`${base}/api/v2/tokens/${token}`)) as {
          symbol?: string;
          name?: string;
          decimals?: string | number;
        };
        symbol = cleanTicker(data.symbol) || symbol;
        name = cleanTicker(data.name) || name;
        if (data.decimals != null) decimals = Number(data.decimals) || decimals;
      }
    } catch {
      /* */
    }
  }

  const meta = {
    symbol: symbol || shortTicker(token),
    name: name || symbol || shortTicker(token),
    decimals,
  };
  if (symbol) cacheSet(key, meta, 5 * 60_000);
  return meta;
}

export async function getTokenBalance(
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint> {
  const key = `bal:${token.toLowerCase()}:${owner.toLowerCase()}`;
  return cacheGetOrSet(key, 12_000, async () => {
    const fromBs = await blockscoutTokenBalance(token, owner);
    if (fromBs != null) return fromBs;
    try {
      return (await withTimeout(
        publicClient().readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner],
        }) as Promise<bigint>,
        RPC_MS,
        'token balanceOf',
      )) as bigint;
    } catch {
      return 0n;
    }
  });
}
