#!/usr/bin/env node
/**
 * Configure Arc Mainnet RPC on Railway + local .env, validate eth_blockNumber, redeploy.
 *
 *   node scripts/set-arc-rpc.mjs "https://arc-mainnet.g.alchemy.com/v2/YOUR_KEY"
 *   node scripts/set-arc-rpc.mjs "https://…/v2/KEY" --fallback "https://other…"
 *   node scripts/set-arc-rpc.mjs --probe-only "https://…"
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const probeOnly = args.includes('--probe-only');
const noDeploy = args.includes('--no-deploy');
const fallbackIdx = args.indexOf('--fallback');
const fallback =
  fallbackIdx >= 0
    ? args[fallbackIdx + 1]
    : 'https://5042.rpc.thirdweb.com,https://arc-mainnet.cloud.blockscout.com/api/eth-rpc';
const primary = args.find((a) => a.startsWith('http'));

if (!primary) {
  console.error(`Usage:
  node scripts/set-arc-rpc.mjs "https://arc-mainnet.g.alchemy.com/v2/YOUR_KEY"

Get a free key:
  1. https://dashboard.alchemy.com/signup  (or log in)
  2. Create App → enable network "Arc Mainnet" (chain 5042)
  3. Copy HTTPS URL → paste as argument above
`);
  process.exit(1);
}

async function probe(url) {
  const headers = { 'Content-Type': 'application/json' };
  if (url.includes('alchemy.com')) {
    headers.Origin = 'https://dashboard.alchemy.com';
    headers.Referer = 'https://dashboard.alchemy.com/';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON: ${text.slice(0, 120)}`);
  }
  if (json.error) {
    throw new Error(`${json.error.message || JSON.stringify(json.error)}`);
  }
  if (!json.result) throw new Error(`no result: ${text.slice(0, 120)}`);
  const block = Number.parseInt(json.result, 16);
  return { block, raw: json.result };
}

console.log('Probing', primary.replace(/\/v2\/[^/]+/, '/v2/***'));
try {
  const { block } = await probe(primary);
  console.log('OK eth_blockNumber →', block);
} catch (e) {
  console.error('PROBE FAILED:', e.message);
  console.error('Fix: enable Arc Mainnet on your Alchemy app, or use another provider URL.');
  process.exit(2);
}

if (probeOnly) process.exit(0);

// Update local .env
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  let text = readFileSync(envPath, 'utf8');
  const set = (key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${val}`);
    else text += `\n${key}=${val}\n`;
  };
  set('ARC_RPC_URL', primary);
  set('ARC_RPC_FALLBACKS', fallback);
  writeFileSync(envPath, text);
  console.log('Updated local .env');
}

// Railway
const rv = spawnSync(
  'railway',
  ['variables', 'set', `ARC_RPC_URL=${primary}`, `ARC_RPC_FALLBACKS=${fallback}`],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
console.log(rv.stdout || '');
if (rv.status !== 0) {
  console.error(rv.stderr || 'railway variables set failed');
  process.exit(rv.status ?? 1);
}
console.log('Railway vars set');

if (!noDeploy) {
  console.log('Redeploying…');
  const up = spawnSync('railway', ['up', '--detach'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(up.status ?? 0);
}
