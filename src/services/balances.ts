/**
 * Balances via Blockscout first (works when public Arc RPC is broken),
 * with short-timeout RPC fallback.
 */
import { formatUnits } from 'viem';
import { publicClient } from '../chain/client.js';
import { erc20Abi } from '../chain/abis.js';
import { env } from '../config/env.js';
import { cacheGetOrSet } from './cache.js';

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

export async function getTokenMeta(token: `0x${string}`): Promise<{
  symbol: string;
  decimals: number;
}> {
  const key = `meta:rpc:${token.toLowerCase()}`;
  return cacheGetOrSet(key, 60_000, async () => {
    // Optional explorer token API (skipped when host is down)
    try {
      const base = blockscoutBase();
      if (!base) throw new Error('no explorer api');
      const data = (await fetchJson(`${base}/api/v2/tokens/${token}`)) as {
        symbol?: string;
        decimals?: string | number;
      };
      if (data.symbol) {
        return {
          symbol: String(data.symbol).slice(0, 24),
          decimals: Number(data.decimals ?? 18) || 18,
        };
      }
    } catch {
      /* */
    }
    try {
      const client = publicClient();
      const [symbol, decimals] = await withTimeout(
        Promise.all([
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'symbol',
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
      return { symbol: String(symbol).slice(0, 24), decimals: Number(decimals) || 18 };
    } catch {
      return { symbol: 'TOKEN', decimals: 18 };
    }
  });
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
