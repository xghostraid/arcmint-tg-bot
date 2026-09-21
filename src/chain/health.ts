/**
 * Cached Arc RPC health. Public mainnet nodes are often stub/401;
 * never let a dead RPC freeze Telegram handlers.
 */
import { env } from '../config/env.js';

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

async function rpcCall(url: string, method: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error?.message) throw new Error(body.error.message);
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

export async function probeArcHealth(): Promise<ArcHealth> {
  const urls = [...new Set([env.rpcUrl(), ...env.rpcFallbacks()].filter(Boolean))];
  const errors: string[] = [];
  for (const url of urls) {
    const rpcHost = hostOf(url);
    try {
      const chainHex = await rpcCall(url, 'eth_chainId');
      const blockHex = await rpcCall(url, 'eth_blockNumber');
      const chainId = Number(chainHex);
      const block = BigInt(String(blockHex ?? '0x0'));
      last = {
        live: chainId === env.chainId && block > 0n,
        chainId,
        blockNumber: block.toString(),
        error: chainId === env.chainId ? null : `unexpected chainId ${chainId}`,
        checkedAt: Date.now(),
        rpcHost,
      };
      if (last.live) {
        console.log(`[arc] live chainId=${last.chainId} block=${last.blockNumber} rpc=${rpcHost}`);
        return last;
      }
      errors.push(`${rpcHost}: chain ${chainId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80);
      errors.push(`${rpcHost}: ${msg}`);
    }
  }
  last = {
    live: false,
    chainId: last.chainId,
    blockNumber: null,
    error: errors.slice(0, 3).join(' | ') || 'all rpcs failed',
    checkedAt: Date.now(),
    rpcHost: hostOf(urls[0] || env.rpcUrl()),
  };
  console.warn(`[arc] down err=${last.error}`);
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
    lines.push(`_rpc_ \`${h.rpcHost}\``);
    if (h.error) lines.push(`_err_ \`${h.error.replace(/[`[\]]/g, '')}\``);
  } else if (opts?.admin) {
    lines.push('', `_rpc_ \`${h.rpcHost}\``);
  }
  return lines.join('\n');
}
