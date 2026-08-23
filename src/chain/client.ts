import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { env } from '../config/env.js';

/**
 * Arc Mainnet — chainId 5042 (0x13b2)
 *
 * Public free endpoints are broken/rate-limited (Aug 2026). Prefer a private key:
 *   Alchemy (enable Arc Mainnet) / QuickNode / dRPC / Chainstack
 *   node scripts/set-arc-rpc.mjs "https://arc-mainnet.g.alchemy.com/v2/KEY"
 */
export const arcMainnet: Chain = {
  id: env.chainId,
  name: 'Arc Mainnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: {
      http: [env.rpcUrl(), ...env.rpcFallbacks()],
    },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: env.explorer() },
  },
};

function makeHttp(url: string): Transport {
  const isAlchemy = url.includes('alchemy.com');
  return http(url, {
    timeout: 20_000,
    retryCount: 2,
    retryDelay: 400,
    fetchOptions: isAlchemy
      ? {
          headers: {
            Origin: 'https://dashboard.alchemy.com',
            Referer: 'https://dashboard.alchemy.com/',
          },
        }
      : undefined,
  });
}

const transport = () => {
  const urls = [env.rpcUrl(), ...env.rpcFallbacks()].filter(Boolean);
  const unique = [...new Set(urls)];
  const redacted = unique.map((u) => u.replace(/\/v2\/[^/?#]+/i, '/v2/***'));
  console.log(`[rpc] Arc transports: ${redacted.join(' | ')}`);
  return fallback(
    unique.map((u) => makeHttp(u)),
    { rank: true, retryCount: 2 },
  );
};

let _public: PublicClient | null = null;

export function publicClient(): PublicClient {
  if (!_public) {
    _public = createPublicClient({
      chain: arcMainnet,
      transport: transport(),
    });
  }
  return _public;
}

export function resetPublicClient(): void {
  _public = null;
}

export function walletClientFromPk(privateKey: Hex): {
  account: Account;
  client: WalletClient;
} {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain: arcMainnet,
    transport: transport(),
  });
  return { account, client };
}

export function txUrl(hash: string): string {
  return `${env.explorer()}/tx/${hash}`;
}

export function addressUrl(addr: string): string {
  return `${env.explorer()}/address/${addr}`;
}
