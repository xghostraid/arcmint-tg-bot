import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { env } from '../config/env.js';

/** Base mainnet — USDC source for Circle Gateway → Arc */
export const baseMainnet: Chain = {
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [env.baseRpcUrl(), ...env.baseRpcFallbacks()],
    },
  },
  blockExplorers: {
    default: { name: 'BaseScan', url: 'https://basescan.org' },
  },
};

const baseTransport = () =>
  fallback(
    [env.baseRpcUrl(), ...env.baseRpcFallbacks()].map((url) =>
      http(url, { timeout: 25_000, retryCount: 2 }),
    ),
  );

let _public: PublicClient | null = null;

export function basePublicClient(): PublicClient {
  if (!_public) {
    _public = createPublicClient({
      chain: baseMainnet,
      transport: baseTransport(),
    });
  }
  return _public;
}

export function baseWalletFromPk(privateKey: Hex): {
  account: Account;
  client: WalletClient;
} {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain: baseMainnet,
    transport: baseTransport(),
  });
  return { account, client };
}

export function baseTxUrl(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}
