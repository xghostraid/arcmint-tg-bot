import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, type Hex } from 'viem';
// Hex used for BRIDGE_RELAYER_PRIVATE_KEY

// Always load project .env and override any stale shell TELEGRAM_BOT_TOKEN.
const envDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(envDir, '../../.env'),
  override: true,
});

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v == null || v === '') {
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

/** Normalize to EIP-55 checksum; required by viem strict address checks. */
function addr(name: string, fallback: string): `0x${string}` {
  const raw = (opt(name, fallback) || fallback).trim();
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`Invalid address for ${name}: ${raw}`);
  }
  return getAddress(raw);
}

/** Arc MAINNET only — never use testnet chain 5042002. */
export const env = {
  telegramToken: () => req('TELEGRAM_BOT_TOKEN'),
  allowlist: () =>
    opt('TELEGRAM_ALLOWLIST')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),

  /**
   * Creator / ops Telegram user ids (comma-separated).
   * Only these can open /admin fee stats. Default empty = nobody.
   */
  adminTgIds: (): number[] =>
    opt('ADMIN_TG_IDS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),

  isAdmin: (tgId: number | undefined | null): boolean => {
    if (tgId == null) return false;
    return env.adminTgIds().includes(tgId);
  },

  chainId: Number(opt('ARC_CHAIN_ID', '5042')),
  /**
   * Arc Mainnet RPC. Defaults to Alchemy public docs-demo (works with Origin header).
   * Fallbacks: Blockscout eth-rpc + thirdweb.
   */
  rpcUrl: () =>
    opt('ARC_RPC_URL', 'https://arc-mainnet.g.alchemy.com/v2/docs-demo'),
  rpcFallbacks: () =>
    opt(
      'ARC_RPC_FALLBACKS',
      'https://arc-mainnet.cloud.blockscout.com/api/eth-rpc,https://5042.rpc.thirdweb.com',
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  explorer: () => opt('ARC_EXPLORER', 'https://arc-scan.org'),

  usdc: () => addr('USDC_ADDRESS', '0x3600000000000000000000000000000000000000'),
  swapRouter: () =>
    addr('SWAP_ROUTER', '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77'),
  quoter: () => addr('QUOTER', '0x7dfd4f31be6814d2906bde155c3e1b146eac1468'),
  feeRouter: () =>
    addr('FEE_ROUTER', '0x2804d131cfB046f987E7e532Bc58CFC30326B350'),
  /**
   * Intermediate tokens for multi-hop when no direct USDC pool
   * (comma-separated). Leave empty to skip multi-hop hubs.
   */
  intermediateTokens: (): `0x${string}`[] =>
    opt('INTERMEDIATE_TOKENS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => isAddress(s, { strict: false }))
      .map((s) => getAddress(s)),

  /** Platform fee recipient — never show this address to end users */
  feeTreasury: () =>
    addr('FEE_TREASURY_ADDRESS', '0x850cd1A1940C0653d78Dff6311D7a5166b8098a3'),
  /**
   * Wallets that pay 0 platform fee (comma-separated).
   * Treasury is always included so the owner isn't charged.
   */
  feeExemptWallets: (): Set<string> => {
    const treasury = env.feeTreasury().toLowerCase();
    const extra = opt(
      'FEE_EXEMPT_WALLETS',
      '0x850cd1A1940C0653d78Dff6311D7a5166b8098a3',
    )
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .map((s) => (isAddress(s, { strict: false }) ? getAddress(s).toLowerCase() : s));
    return new Set([treasury, ...extra]);
  },
  isFeeExempt: (address: string): boolean => {
    try {
      return env.feeExemptWallets().has(getAddress(address).toLowerCase());
    } catch {
      return env.feeExemptWallets().has(address.toLowerCase());
    }
  },
  /** Platform fee on trade volume in bps (100 = 1%) */
  platformFeeBps: () => Number(opt('PLATFORM_FEE_BPS', '100')),
  /** Share of platform fee paid to referrer in bps (2500 = 25% of fee) */
  referralShareBps: () => Number(opt('REFERRAL_SHARE_BPS', '2500')),
  botUsername: () => opt('BOT_USERNAME', 'ArcTraderXbot'),

  /** Base (8453) RPC for Circle Gateway deposits — with public fallbacks */
  baseRpcUrl: () => opt('BASE_RPC_URL', 'https://mainnet.base.org'),
  baseRpcFallbacks: () =>
    opt(
      'BASE_RPC_FALLBACKS',
      'https://1rpc.io/base,https://base-mainnet.public.blastapi.io',
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  /** Base USDC (native Circle) — must be correct EIP-55 checksum */
  baseUsdc: () =>
    addr('BASE_USDC_ADDRESS', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  /** Circle Gateway Wallet (same addr on Base + other mainnets) */
  gatewayWallet: () =>
    addr('GATEWAY_WALLET', '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'),
  /** Circle Gateway Minter (same addr on Arc + other mainnets) */
  gatewayMinter: () =>
    addr('GATEWAY_MINTER', '0x2222222d7164433c4C09B0b0D809a9b52C04C205'),
  gatewayApi: () =>
    opt('GATEWAY_API_URL', 'https://gateway-api.circle.com'),
  /** Bridge platform fee in bps (100 = 1%). Taken on Base before Gateway deposit. */
  bridgeFeeBps: () => Number(opt('BRIDGE_FEE_BPS', '100')),
  /**
   * Pays destination-chain gas for gatewayMint (first-time Bridge In users have no Arc gas).
   * Funds still mint to the user — relayer only submits the tx. Optional but strongly recommended.
   */
  bridgeRelayerKey: (): Hex | null => {
    const k = opt('BRIDGE_RELAYER_PRIVATE_KEY', '').trim();
    if (!k) return null;
    const hex = (k.startsWith('0x') ? k : `0x${k}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('BRIDGE_RELAYER_PRIVATE_KEY must be a 32-byte hex private key');
    }
    return hex;
  },
  /** Presets for bridge amount (USDC) */
  bridgePresets: () =>
    opt('BRIDGE_PRESETS', '10,25,50,100,250')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

  encryptionKey: () => req('WALLET_ENCRYPTION_KEY'),
  slippageBps: Number(opt('DEFAULT_SLIPPAGE_BPS', '100')),
  buyPresets: () =>
    opt('DEFAULT_BUY_PRESETS', '5,10,25,50,100')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
};

if (env.chainId === 5042002) {
  throw new Error(
    'Refusing to start: ARC_CHAIN_ID=5042002 is Arc TESTNET. This bot is MAINNET-only (5042).',
  );
}
