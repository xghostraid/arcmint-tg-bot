import {
  concatHex,
  encodeFunctionData,
  formatUnits,
  maxUint256,
  numberToHex,
  parseUnits,
  pad,
  type Hex,
} from 'viem';
import { publicClient, walletClientFromPk, txUrl } from '../chain/client.js';
import { erc20Abi, quoterV2Abi, swapRouterAbi } from '../chain/abis.js';
import { env } from '../config/env.js';

/** Common Uniswap V3 fee tiers */
const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** USDC ERC-20 decimals on Arc */
const USDC_DECIMALS = 6;

export type QuoteResult = {
  /** Pool fee for single-hop; first hop fee for multi (display only) */
  fee: number;
  amountOut: bigint;
  amountIn: bigint;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  /** Multi-hop path for exactInput; undefined = exactInputSingle */
  path?: Hex;
  routeLabel?: string;
};

export type PlatformFeeSplit = {
  grossIn: bigint;
  swapIn: bigint;
  feeTotal: bigint;
  feeTreasury: bigint;
  feeReferral: bigint;
};

export function computePlatformFee(
  grossIn: bigint,
  hasReferrerPayout: boolean,
  feeExempt = false,
): PlatformFeeSplit {
  if (feeExempt || grossIn <= 0n) {
    return {
      grossIn,
      swapIn: grossIn,
      feeTotal: 0n,
      feeTreasury: 0n,
      feeReferral: 0n,
    };
  }
  const feeBps = Math.max(0, Math.min(1000, env.platformFeeBps()));
  const feeTotal = (grossIn * BigInt(feeBps)) / 10_000n;
  let feeReferral = 0n;
  if (hasReferrerPayout && feeTotal > 0n) {
    const shareBps = Math.max(0, Math.min(10_000, env.referralShareBps()));
    feeReferral = (feeTotal * BigInt(shareBps)) / 10_000n;
  }
  const feeTreasury = feeTotal - feeReferral;
  const swapIn = grossIn - feeTotal;
  return { grossIn, swapIn, feeTotal, feeTreasury, feeReferral };
}

export function formatUsdc(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

export function parseUnitsSafe(usdcAmount: string): bigint {
  return parseUnits(usdcAmount, USDC_DECIMALS);
}

/** Uniswap V3 path: token (20) + fee (3) + token (20) + ... */
export function encodeV3Path(tokens: `0x${string}`[], fees: number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error('Invalid path');
  }
  const parts: Hex[] = [];
  for (let i = 0; i < fees.length; i++) {
    parts.push(tokens[i]!.toLowerCase() as Hex);
    parts.push(pad(numberToHex(fees[i]!), { size: 3 }) as Hex);
  }
  parts.push(tokens[tokens.length - 1]!.toLowerCase() as Hex);
  return concatHex(parts);
}

async function quoteSingle(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  fee: number,
): Promise<QuoteResult | null> {
  try {
    const result = await publicClient().simulateContract({
      address: env.quoter(),
      abi: quoterV2Abi,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const amountOut = result.result[0] as bigint;
    if (amountOut <= 0n) return null;
    return {
      fee,
      amountOut,
      amountIn,
      tokenIn,
      tokenOut,
      routeLabel: 'direct',
    };
  } catch {
    return null;
  }
}

async function bestExactInputQuote(opts: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
}): Promise<QuoteResult | null> {
  const settled = await Promise.all(
    FEE_TIERS.map((fee) => quoteSingle(opts.tokenIn, opts.tokenOut, opts.amountIn, fee)),
  );
  let best: QuoteResult | null = null;
  for (const r of settled) {
    if (!r) continue;
    if (!best || r.amountOut > best.amountOut) best = r;
  }
  return best;
}

async function quoteMultiHop(opts: {
  tokens: `0x${string}`[];
  fees: number[];
  amountIn: bigint;
}): Promise<QuoteResult | null> {
  try {
    const path = encodeV3Path(opts.tokens, opts.fees);
    const result = await publicClient().simulateContract({
      address: env.quoter(),
      abi: quoterV2Abi,
      functionName: 'quoteExactInput',
      args: [path, opts.amountIn],
    });
    const amountOut = result.result[0] as bigint;
    if (amountOut <= 0n) return null;
    return {
      fee: opts.fees[0] ?? 3000,
      amountOut,
      amountIn: opts.amountIn,
      tokenIn: opts.tokens[0]!,
      tokenOut: opts.tokens[opts.tokens.length - 1]!,
      path,
      routeLabel: `via ${opts.tokens.length - 2} hop(s)`,
    };
  } catch {
    return null;
  }
}

/**
 * Best route tokenIn → tokenOut: direct all fees, then multi-hop via intermediates.
 */
export async function bestRouteQuote(opts: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
}): Promise<QuoteResult | null> {
  if (opts.amountIn <= 0n) return null;
  if (opts.tokenIn.toLowerCase() === opts.tokenOut.toLowerCase()) return null;

  // 1) Direct
  const direct = await bestExactInputQuote(opts);
  if (direct) return direct;

  // 2) Multi-hop: tokenIn → hub → tokenOut for each hub × fee pair
  const hubs = env
    .intermediateTokens()
    .filter(
      (h) =>
        h.toLowerCase() !== opts.tokenIn.toLowerCase() &&
        h.toLowerCase() !== opts.tokenOut.toLowerCase(),
    );

  if (hubs.length === 0) return null;

  const multiAttempts: Promise<QuoteResult | null>[] = [];
  for (const hub of hubs) {
    for (const feeA of FEE_TIERS) {
      for (const feeB of FEE_TIERS) {
        multiAttempts.push(
          quoteMultiHop({
            tokens: [opts.tokenIn, hub, opts.tokenOut],
            fees: [feeA, feeB],
            amountIn: opts.amountIn,
          }),
        );
      }
    }
  }
  // Cap concurrency cost: wait all (hubs usually 0–3)
  const multi = await Promise.all(multiAttempts);
  let best: QuoteResult | null = null;
  for (const r of multi) {
    if (!r) continue;
    if (!best || r.amountOut > best.amountOut) best = r;
  }
  return best;
}

export async function quoteUsdcToToken(
  tokenOut: `0x${string}`,
  usdcAmount: string,
  afterPlatformFee = true,
  feeExempt = false,
): Promise<QuoteResult | null> {
  let amountIn = parseUnits(usdcAmount, USDC_DECIMALS);
  if (amountIn <= 0n) return null;
  if (afterPlatformFee && !feeExempt) {
    amountIn = computePlatformFee(amountIn, false, false).swapIn;
    if (amountIn <= 0n) return null;
  }
  return bestRouteQuote({
    tokenIn: env.usdc(),
    tokenOut,
    amountIn,
  });
}

/** Quote selling tokenIn for USDC (direct or multi-hop). */
export async function quoteTokenToUsdc(
  tokenIn: `0x${string}`,
  amountIn: bigint,
): Promise<QuoteResult | null> {
  if (amountIn <= 0n) return null;
  return bestRouteQuote({
    tokenIn,
    tokenOut: env.usdc(),
    amountIn,
  });
}

async function executeSwap(opts: {
  privateKey: Hex;
  quote: QuoteResult;
  amountIn: bigint;
  amountOutMin: bigint;
  tokenIn: `0x${string}`;
}): Promise<Hex> {
  const { account, client } = walletClientFromPk(opts.privateKey);
  const pub = publicClient();
  const router = env.swapRouter();

  const allowance = (await pub.readContract({
    address: opts.tokenIn,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, router],
  })) as bigint;

  if (allowance < opts.amountIn) {
    const approveHash = await client.writeContract({
      address: opts.tokenIn,
      abi: erc20Abi,
      functionName: 'approve',
      args: [router, maxUint256],
      account,
      chain: client.chain,
    });
    await pub.waitForTransactionReceipt({ hash: approveHash });
  }

  let data: Hex;
  if (opts.quote.path) {
    data = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInput',
      args: [
        {
          path: opts.quote.path,
          recipient: account.address,
          amountIn: opts.amountIn,
          amountOutMinimum: opts.amountOutMin,
        },
      ],
    });
  } else {
    data = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: opts.quote.tokenIn,
          tokenOut: opts.quote.tokenOut,
          fee: opts.quote.fee,
          recipient: account.address,
          amountIn: opts.amountIn,
          amountOutMinimum: opts.amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }

  const hash = await client.sendTransaction({
    account,
    chain: client.chain,
    to: router,
    data,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

async function takePlatformFees(opts: {
  privateKey: Hex;
  grossUsdc: bigint;
  referrerAddress?: `0x${string}` | null;
  traderAddress?: `0x${string}`;
}): Promise<{ fee: PlatformFeeSplit; feeTxs: Hex[] }> {
  const { account, client } = walletClientFromPk(opts.privateKey);
  const pub = publicClient();
  const usdc = env.usdc();
  const treasury = env.feeTreasury();
  const feeExempt = env.isFeeExempt(opts.traderAddress ?? account.address);
  const hasRef = Boolean(opts.referrerAddress) && !feeExempt;
  const fee = computePlatformFee(opts.grossUsdc, hasRef, feeExempt);
  const feeTxs: Hex[] = [];

  if (fee.feeTreasury > 0n) {
    const h = await client.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [treasury, fee.feeTreasury],
      account,
      chain: client.chain,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    feeTxs.push(h);
  }
  if (fee.feeReferral > 0n && opts.referrerAddress) {
    const h = await client.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [opts.referrerAddress, fee.feeReferral],
      account,
      chain: client.chain,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    feeTxs.push(h);
  }
  return { fee, feeTxs };
}

export async function sellTokenForUsdc(opts: {
  privateKey: Hex;
  token: `0x${string}`;
  amountIn: bigint;
  slippageBps: number;
  referrerAddress?: `0x${string}` | null;
  traderAddress?: `0x${string}`;
}): Promise<{
  hash: Hex;
  quote: QuoteResult;
  fee: PlatformFeeSplit;
  usdcNet: bigint;
  feeTxs: Hex[];
}> {
  if (opts.amountIn <= 0n) throw new Error('Invalid sell amount');

  const quote = await quoteTokenToUsdc(opts.token, opts.amountIn);
  if (!quote || quote.amountOut <= 0n) {
    throw new Error(
      'NO_POOL: No liquid path to USDC on Arc. Use Send to withdraw the tokens, or wait for a pool.',
    );
  }

  const amountOutMin =
    (quote.amountOut * BigInt(10_000 - opts.slippageBps)) / 10_000n;

  const hash = await executeSwap({
    privateKey: opts.privateKey,
    quote,
    amountIn: opts.amountIn,
    amountOutMin,
    tokenIn: opts.token,
  });

  const { fee, feeTxs } = await takePlatformFees({
    privateKey: opts.privateKey,
    grossUsdc: quote.amountOut,
    referrerAddress: opts.referrerAddress,
    traderAddress: opts.traderAddress,
  });

  return { hash, quote, fee, usdcNet: fee.swapIn, feeTxs };
}

export async function buyTokenWithUsdc(opts: {
  privateKey: Hex;
  token: `0x${string}`;
  usdcAmount: string;
  slippageBps: number;
  referrerAddress?: `0x${string}` | null;
  traderAddress?: `0x${string}`;
}): Promise<{
  hash: Hex;
  amountOutMin: bigint;
  quote: QuoteResult;
  fee: PlatformFeeSplit;
  feeTxs: Hex[];
}> {
  const grossIn = parseUnits(opts.usdcAmount, USDC_DECIMALS);
  if (grossIn <= 0n) throw new Error('Invalid amount');

  const { account } = walletClientFromPk(opts.privateKey);
  const feeExempt = env.isFeeExempt(opts.traderAddress ?? account.address);
  const hasRef = Boolean(opts.referrerAddress) && !feeExempt;
  const fee = computePlatformFee(grossIn, hasRef, feeExempt);
  if (fee.swapIn <= 0n) throw new Error('Amount too small after fee');

  const quote = await quoteUsdcToToken(opts.token, formatUsdc(fee.swapIn), false);
  if (!quote || quote.amountOut <= 0n) {
    throw new Error(
      'NO_POOL: No liquid USDC path for this token on Arc Mainnet. Try another token or size.',
    );
  }

  const amountOutMin =
    (quote.amountOut * BigInt(10_000 - opts.slippageBps)) / 10_000n;

  // Fees first (from USDC), then swap
  const { feeTxs } = await takePlatformFees({
    privateKey: opts.privateKey,
    grossUsdc: grossIn,
    referrerAddress: opts.referrerAddress,
    traderAddress: opts.traderAddress,
  });

  const hash = await executeSwap({
    privateKey: opts.privateKey,
    quote: {
      ...quote,
      tokenIn: env.usdc(),
      tokenOut: opts.token,
      amountIn: fee.swapIn,
    },
    amountIn: fee.swapIn,
    amountOutMin,
    tokenIn: env.usdc(),
  });

  return { hash, amountOutMin, quote, fee, feeTxs };
}

export function formatSellQuoteHuman(
  quote: QuoteResult,
  tokenSymbol: string,
  tokenDecimals: number,
): string {
  const inn = formatUnits(quote.amountIn, tokenDecimals);
  const out = formatUnits(quote.amountOut, USDC_DECIMALS);
  const route = quote.path ? ` · ${quote.routeLabel || 'multi-hop'}` : '';
  return `≈ $${trim(out)} USDC for ${trim(inn)} ${tokenSymbol} (fee tier ${quote.fee / 10000}%${route})`;
}

export function formatQuoteHuman(
  quote: QuoteResult,
  tokenSymbol: string,
  tokenDecimals: number,
): string {
  const out = formatUnits(quote.amountOut, tokenDecimals);
  const inn = formatUnits(quote.amountIn, USDC_DECIMALS);
  const route = quote.path ? ` · ${quote.routeLabel || 'multi-hop'}` : '';
  return `≈ ${trim(out)} ${tokenSymbol} for $${trim(inn)} USDC (fee tier ${quote.fee / 10000}%${route})`;
}

export function formatPlatformFeeLine(fee: PlatformFeeSplit, mode: 'buy' | 'sell' = 'buy'): string {
  if (fee.feeTotal === 0n) {
    return mode === 'buy'
      ? `_No bot fee on this trade_\nSwaps *$${Number(formatUsdc(fee.swapIn)).toFixed(4)}* USDC`
      : `_No bot fee on this trade_\nYou keep *$${Number(formatUsdc(fee.swapIn)).toFixed(4)}* USDC`;
  }
  const pct = (env.platformFeeBps() / 100).toFixed(2);
  const total = Number(formatUsdc(fee.feeTotal)).toFixed(4);
  const net = Number(formatUsdc(fee.swapIn)).toFixed(4);
  let line = `Bot fee *${pct}%* ≈ *$${total}* USDC`;
  if (fee.feeReferral > 0n) {
    const ref = Number(formatUsdc(fee.feeReferral)).toFixed(4);
    line += ` (incl. *$${ref}* referral share)`;
  }
  if (mode === 'buy') {
    line += `\nSwaps *$${net}* USDC after fee`;
  } else {
    line += `\nYou keep *$${net}* USDC after fee`;
  }
  return line;
}

function trim(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(3)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(3)}K`;
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

export { txUrl };
