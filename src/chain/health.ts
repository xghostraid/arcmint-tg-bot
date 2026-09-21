/**
 * Cached Arc RPC health. Public mainnet nodes are often stub/401;
 * never let a dead RPC freeze Telegram handlers.
 */
import { env } from '../config/env.js';
import { publicClient } from './client.js';

export type ArcHealth = {
  live: boolean;
  chainId: number | null;
  blockNumber: string | null;
  error: string | null;
  checkedAt: number;
  rpcHost: string;
};

const TIMEOUT_MS = 8_000;
const INTERVAL_MS = 30_000;

let last: ArcHealth = {
  live: false,
  chainId: null,
  blockNumber: null,
  error: 'not probed yet',
  checkedAt: 0,
  rpcHost: hostOf(env.rpcUrl()),
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/https?:\/\//, '').split('/')[0] || 'rpc';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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

export function getArcHealth(): ArcHealth {
  return last;
}

export function isArcLive(): boolean {
  return last.live && Date.now() - last.checkedAt < INTERVAL_MS * 4;
}

/** Probe if we have no fresh result (webhook lambdas never run the PM2 health loop). */
export async function ensureArcHealth(): Promise<ArcHealth> {
  if (last.checkedAt && Date.now() - last.checkedAt < INTERVAL_MS) return last;
  return probeArcHealth();
}

export async function probeArcHealth(): Promise<ArcHealth> {
  const rpcHost = hostOf(env.rpcUrl());
  try {
    const client = publicClient();
    const chainId = await withTimeout(client.getChainId(), TIMEOUT_MS, 'getChainId');
    const block = await withTimeout(client.getBlockNumber(), TIMEOUT_MS, 'getBlockNumber');
    last = {
      live: chainId === env.chainId && block > 0n,
      chainId,
      blockNumber: block.toString(),
      error: chainId === env.chainId ? null : `unexpected chainId ${chainId}`,
      checkedAt: Date.now(),
      rpcHost,
    };
  } catch (e) {
    last = {
      live: false,
      chainId: last.chainId,
      blockNumber: null,
      error: e instanceof Error ? e.message.slice(0, 180) : String(e).slice(0, 180),
      checkedAt: Date.now(),
      rpcHost,
    };
  }
  if (last.live) {
    console.log(`[arc] live chainId=${last.chainId} block=${last.blockNumber} rpc=${rpcHost}`);
  } else {
    console.warn(`[arc] down rpc=${rpcHost} err=${last.error}`);
  }
  return last;
}

export function startArcHealthLoop(): void {
  void probeArcHealth();
  setInterval(() => {
    void probeArcHealth();
  }, INTERVAL_MS);
}

export function formatArcStatus(opts?: { admin?: boolean }): string {
  const h = getArcHealth();
  const age = h.checkedAt ? Math.max(0, Math.round((Date.now() - h.checkedAt) / 1000)) : null;
  const lines = [
    `*Arc ${h.live ? 'LIVE' : 'OFFLINE'}*`,
    `Chain \`${env.chainId}\``,
    h.live && h.blockNumber ? `Block \`${h.blockNumber}\`` : `_No block from RPC_`,
    `Checked ${age == null ? 'never' : `${age}s ago`}`,
  ];
  if (!h.live) {
    lines.push('', '_Quotes, buys, and balances pause until a public Arc node answers._');
  }
  if (opts?.admin) {
    lines.push('', `_rpc_ \`${h.rpcHost}\``);
    if (h.error) lines.push(`_err_ \`${h.error.replace(/[`[\]]/g, '')}\``);
  }
  return lines.join('\n');
}
