/**
 * Bidirectional USDC bridge via Circle Gateway (Base ↔ Arc).
 *
 * Bridge In  = Base → Arc
 * Bridge Out = Arc → Base
 *
 * 1. Platform fee on source chain → treasury
 * 2. deposit() into Gateway Wallet on source
 * 3. Wait for Circle balance
 * 4. BurnIntent + POST /v1/transfer
 * 5. gatewayMint() on destination
 */
import { randomBytes } from 'node:crypto';
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  maxUint256,
  pad,
  parseUnits,
  zeroAddress,
  type Hex,
} from 'viem';
import { env } from '../config/env.js';
import { basePublicClient, baseWalletFromPk, baseTxUrl } from '../chain/base.js';
import { publicClient, walletClientFromPk, txUrl } from '../chain/client.js';
import { erc20Abi } from '../chain/abis.js';

const USDC_DEC = 6;
const BASE_DOMAIN = 6;
const ARC_DOMAIN = 26;
/** Circle transfer fee reserve (~$0.011) */
const CIRCLE_MAX_FEE = 11_000n;

export type BridgeDirection = 'in' | 'out'; // in = Base→Arc, out = Arc→Base

const gatewayWalletAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const gatewayMinterAbi = [
  {
    type: 'function',
    name: 'gatewayMint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'attestationPayload', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const EIP712Domain = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
] as const;

const TransferSpec = [
  { name: 'version', type: 'uint32' },
  { name: 'sourceDomain', type: 'uint32' },
  { name: 'destinationDomain', type: 'uint32' },
  { name: 'sourceContract', type: 'bytes32' },
  { name: 'destinationContract', type: 'bytes32' },
  { name: 'sourceToken', type: 'bytes32' },
  { name: 'destinationToken', type: 'bytes32' },
  { name: 'sourceDepositor', type: 'bytes32' },
  { name: 'destinationRecipient', type: 'bytes32' },
  { name: 'sourceSigner', type: 'bytes32' },
  { name: 'destinationCaller', type: 'bytes32' },
  { name: 'value', type: 'uint256' },
  { name: 'salt', type: 'bytes32' },
  { name: 'hookData', type: 'bytes' },
] as const;

const BurnIntent = [
  { name: 'maxBlockHeight', type: 'uint256' },
  { name: 'maxFee', type: 'uint256' },
  { name: 'spec', type: 'TransferSpec' },
] as const;

function addr32(a: string): `0x${string}` {
  return pad(a.toLowerCase() as `0x${string}`, { size: 32 });
}

export function computeBridgeFee(gross: bigint): { fee: bigint; net: bigint } {
  const bps = Math.max(0, Math.min(1000, env.bridgeFeeBps()));
  const fee = (gross * BigInt(bps)) / 10_000n;
  return { fee, net: gross - fee };
}

export function directionLabel(dir: BridgeDirection): string {
  return dir === 'in' ? 'Base → Arc' : 'Arc → Base';
}

export async function getBaseUsdcBalance(address: `0x${string}`): Promise<bigint> {
  const owner = getAddress(address);
  return basePublicClient().readContract({
    address: env.baseUsdc(),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  }) as Promise<bigint>;
}

export async function getArcUsdcBalance(address: `0x${string}`): Promise<bigint> {
  const owner = getAddress(address);
  return publicClient().readContract({
    address: env.usdc(),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  }) as Promise<bigint>;
}

/** Gateway unified balance for a domain (6=Base, 26=Arc). */
export async function getGatewayBalance(
  address: `0x${string}`,
  domain: number = BASE_DOMAIN,
): Promise<bigint> {
  const res = await fetch(`${env.gatewayApi()}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: [{ domain, depositor: getAddress(address) }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gateway balances failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    balances?: { domain: number; balance: string }[];
  };
  const row = json.balances?.find((b) => b.domain === domain);
  return BigInt(row?.balance || '0');
}

export type BridgeProgress = (msg: string) => void | Promise<void>;

export type BridgeResult = {
  direction: BridgeDirection;
  feeUsdc: string;
  netUsdc: string;
  depositTx: Hex;
  mintTx: Hex;
  depositScan: string;
  mintScan: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function signAndTransfer(opts: {
  privateKey: Hex;
  sourceDomain: number;
  destDomain: number;
  sourceToken: `0x${string}`;
  destToken: `0x${string}`;
  transferValue: bigint;
  address: `0x${string}`;
}): Promise<{ attestation: Hex; signature: Hex }> {
  const { account, client: signer } = baseWalletFromPk(opts.privateKey);
  // EIP-712 domain is chain-agnostic for GatewayWallet (name+version only)
  const salt = (`0x${randomBytes(32).toString('hex')}`) as Hex;
  const burnIntentMessage = {
    maxBlockHeight: maxUint256,
    maxFee: CIRCLE_MAX_FEE,
    spec: {
      version: 1,
      sourceDomain: opts.sourceDomain,
      destinationDomain: opts.destDomain,
      sourceContract: addr32(env.gatewayWallet()),
      destinationContract: addr32(env.gatewayMinter()),
      sourceToken: addr32(opts.sourceToken),
      destinationToken: addr32(opts.destToken),
      sourceDepositor: addr32(opts.address),
      destinationRecipient: addr32(opts.address),
      sourceSigner: addr32(opts.address),
      destinationCaller: addr32(zeroAddress),
      value: opts.transferValue,
      salt,
      hookData: '0x' as Hex,
    },
  };

  const signature = await signer.signTypedData({
    account,
    domain: { name: 'GatewayWallet', version: '1' },
    types: { EIP712Domain, TransferSpec, BurnIntent },
    primaryType: 'BurnIntent',
    message: burnIntentMessage,
  });

  const apiBody = [
    {
      burnIntent: {
        maxBlockHeight: burnIntentMessage.maxBlockHeight.toString(),
        maxFee: burnIntentMessage.maxFee.toString(),
        spec: {
          ...burnIntentMessage.spec,
          value: burnIntentMessage.spec.value.toString(),
        },
      },
      signature,
    },
  ];

  const transferRes = await fetch(`${env.gatewayApi()}/v1/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(apiBody),
  });
  if (!transferRes.ok) {
    throw new Error(
      `Circle transfer failed: ${transferRes.status} ${(await transferRes.text()).slice(0, 300)}`,
    );
  }
  const transferJson = (await transferRes.json()) as {
    attestation?: string;
    signature?: string;
  };
  if (!transferJson.attestation || !transferJson.signature) {
    throw new Error(
      `Circle response missing attestation: ${JSON.stringify(transferJson).slice(0, 300)}`,
    );
  }
  return {
    attestation: transferJson.attestation as Hex,
    signature: transferJson.signature as Hex,
  };
}

/**
 * Bridge USDC either Base→Arc (`in`) or Arc→Base (`out`).
 */
export async function bridgeUsdc(opts: {
  privateKey: Hex;
  usdcAmount: string;
  direction: BridgeDirection;
  onProgress?: BridgeProgress;
}): Promise<BridgeResult> {
  const progress = opts.onProgress ?? (() => {});
  const dir = opts.direction;
  const gross = parseUnits(opts.usdcAmount, USDC_DEC);
  if (gross <= 0n) throw new Error('Amount must be > 0');

  const feeExempt = env.isFeeExempt(
    baseWalletFromPk(opts.privateKey).account.address,
  );
  const { fee, net } = feeExempt
    ? { fee: 0n, net: gross }
    : computeBridgeFee(gross);
  if (net <= 0n) throw new Error('Amount too small after fee');

  if (dir === 'in') {
    return doBridgeIn({ privateKey: opts.privateKey, gross, fee, net, feeExempt, progress });
  }
  return doBridgeOut({ privateKey: opts.privateKey, gross, fee, net, feeExempt, progress });
}

async function doBridgeIn(opts: {
  privateKey: Hex;
  gross: bigint;
  fee: bigint;
  net: bigint;
  feeExempt: boolean;
  progress: BridgeProgress;
}): Promise<BridgeResult> {
  const { account, client: baseWallet } = baseWalletFromPk(opts.privateKey);
  const basePub = basePublicClient();
  const { gross, fee, net, feeExempt, progress } = opts;

  const bal = await getBaseUsdcBalance(account.address);
  if (bal < gross) {
    throw new Error(
      `Insufficient *Base* USDC. Need $${formatUnits(gross, USDC_DEC)}, have $${formatUnits(bal, USDC_DEC)}. ` +
        `Send Base USDC to \`${account.address}\`.`,
    );
  }
  if ((await basePub.getBalance({ address: account.address })) === 0n) {
    throw new Error('Need a little *ETH on Base* for gas (~0.0005 ETH).');
  }

  await progress(
    feeExempt
      ? `*Base → Arc* · $${formatUnits(gross, USDC_DEC)} (fee waived)…`
      : `*Base → Arc* · $${formatUnits(gross, USDC_DEC)} · fee $${formatUnits(fee, USDC_DEC)}…`,
  );

  if (fee > 0n) {
    await progress('Fee → treasury on Base…');
    const h = await baseWallet.writeContract({
      address: env.baseUsdc(),
      abi: erc20Abi,
      functionName: 'transfer',
      args: [env.feeTreasury(), fee],
      account,
      chain: baseWallet.chain,
    });
    await basePub.waitForTransactionReceipt({ hash: h });
  }

  const gateway = env.gatewayWallet();
  const usdc = env.baseUsdc();
  const allowance = (await basePub.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, gateway],
  })) as bigint;
  if (allowance < net) {
    await progress('Approve USDC on Base…');
    const appr = await baseWallet.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [gateway, maxUint256],
      account,
      chain: baseWallet.chain,
    });
    await basePub.waitForTransactionReceipt({ hash: appr });
  }

  await progress('Deposit Gateway (Base)…');
  const depositTx = await baseWallet.writeContract({
    address: gateway,
    abi: gatewayWalletAbi,
    functionName: 'deposit',
    args: [usdc, net],
    account,
    chain: baseWallet.chain,
  });
  await basePub.waitForTransactionReceipt({ hash: depositTx });
  await progress(
    `Deposited. Waiting for Circle (~15 min on Base)…\n[Base](${baseTxUrl(depositTx)})`,
  );

  const gatewayBal = await waitGatewayBalance(
    account.address,
    BASE_DOMAIN,
    net,
    progress,
    25 * 60_000,
    20_000,
  );

  const transferValue =
    gatewayBal > CIRCLE_MAX_FEE ? gatewayBal - CIRCLE_MAX_FEE : gatewayBal;
  if (transferValue <= 0n) throw new Error('Gateway balance too small after Circle fee');

  await progress(`Claim ~$${formatUnits(transferValue, USDC_DEC)} on Arc…`);
  const { attestation, signature } = await signAndTransfer({
    privateKey: opts.privateKey,
    sourceDomain: BASE_DOMAIN,
    destDomain: ARC_DOMAIN,
    sourceToken: env.baseUsdc(),
    destToken: env.usdc(),
    transferValue,
    address: account.address,
  });

  // First-time users have no Arc gas — platform relayer pays mint gas (funds still go to user)
  await progress('Minting on Arc (gas sponsored)…');
  const mintTx = await mintOnDestination({
    chain: 'arc',
    userKey: opts.privateKey,
    userAddress: account.address,
    attestation,
    signature,
    progress,
  });

  return {
    direction: 'in',
    feeUsdc: formatUnits(fee, USDC_DEC),
    netUsdc: formatUnits(transferValue, USDC_DEC),
    depositTx,
    mintTx,
    depositScan: baseTxUrl(depositTx),
    mintScan: txUrl(mintTx),
  };
}

async function doBridgeOut(opts: {
  privateKey: Hex;
  gross: bigint;
  fee: bigint;
  net: bigint;
  feeExempt: boolean;
  progress: BridgeProgress;
}): Promise<BridgeResult> {
  const { account, client: arcWallet } = walletClientFromPk(opts.privateKey);
  const arcPub = publicClient();
  const { gross, fee, net, feeExempt, progress } = opts;

  const bal = await getArcUsdcBalance(account.address);
  if (bal < gross) {
    throw new Error(
      `Insufficient *Arc* USDC. Need $${formatUnits(gross, USDC_DEC)}, have $${formatUnits(bal, USDC_DEC)}.`,
    );
  }
  // Arc gas = native USDC (18 dec)
  if ((await arcPub.getBalance({ address: account.address })) === 0n) {
    throw new Error('Need a little *native USDC on Arc* for gas (deposit).');
  }

  await progress(
    feeExempt
      ? `*Arc → Base* · $${formatUnits(gross, USDC_DEC)} (fee waived)…`
      : `*Arc → Base* · $${formatUnits(gross, USDC_DEC)} · fee $${formatUnits(fee, USDC_DEC)}…`,
  );

  if (fee > 0n) {
    await progress('Fee → treasury on Arc…');
    const h = await arcWallet.writeContract({
      address: env.usdc(),
      abi: erc20Abi,
      functionName: 'transfer',
      args: [env.feeTreasury(), fee],
      account,
      chain: arcWallet.chain,
    });
    await arcPub.waitForTransactionReceipt({ hash: h });
  }

  const gateway = env.gatewayWallet();
  const usdc = env.usdc();
  const allowance = (await arcPub.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, gateway],
  })) as bigint;
  if (allowance < net) {
    await progress('Approve USDC on Arc…');
    const appr = await arcWallet.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [gateway, maxUint256],
      account,
      chain: arcWallet.chain,
    });
    await arcPub.waitForTransactionReceipt({ hash: appr });
  }

  await progress('Deposit Gateway (Arc)…');
  const depositTx = await arcWallet.writeContract({
    address: gateway,
    abi: gatewayWalletAbi,
    functionName: 'deposit',
    args: [usdc, net],
    account,
    chain: arcWallet.chain,
  });
  await arcPub.waitForTransactionReceipt({ hash: depositTx });
  // Arc finality is fast (~seconds)
  await progress(
    `Deposited. Waiting for Circle (usually seconds on Arc)…\n[Arc](${txUrl(depositTx)})`,
  );

  const gatewayBal = await waitGatewayBalance(
    account.address,
    ARC_DOMAIN,
    net,
    progress,
    5 * 60_000,
    5_000,
  );

  const transferValue =
    gatewayBal > CIRCLE_MAX_FEE ? gatewayBal - CIRCLE_MAX_FEE : gatewayBal;
  if (transferValue <= 0n) throw new Error('Gateway balance too small after Circle fee');

  await progress(`Claim ~$${formatUnits(transferValue, USDC_DEC)} on Base…`);
  const { attestation, signature } = await signAndTransfer({
    privateKey: opts.privateKey,
    sourceDomain: ARC_DOMAIN,
    destDomain: BASE_DOMAIN,
    sourceToken: env.usdc(),
    destToken: env.baseUsdc(),
    transferValue,
    address: account.address,
  });

  await progress('Minting on Base (gas sponsored if needed)…');
  const mintTx = await mintOnDestination({
    chain: 'base',
    userKey: opts.privateKey,
    userAddress: account.address,
    attestation,
    signature,
    progress,
  });

  return {
    direction: 'out',
    feeUsdc: formatUnits(fee, USDC_DEC),
    netUsdc: formatUnits(transferValue, USDC_DEC),
    depositTx,
    mintTx,
    depositScan: txUrl(depositTx),
    mintScan: baseTxUrl(mintTx),
  };
}

/**
 * Submit gatewayMint. Prefer platform relayer so first-time Bridge In users
 * don't need Arc gas. destinationCaller=0 allows any EOA to submit; funds still
 * mint to the user (destinationRecipient).
 */
async function mintOnDestination(opts: {
  chain: 'arc' | 'base';
  userKey: Hex;
  userAddress: `0x${string}`;
  attestation: Hex;
  signature: Hex;
  progress: BridgeProgress;
}): Promise<Hex> {
  const data = encodeFunctionData({
    abi: gatewayMinterAbi,
    functionName: 'gatewayMint',
    args: [opts.attestation, opts.signature],
  });
  const to = env.gatewayMinter();
  const relayerKey = env.bridgeRelayerKey();

  if (opts.chain === 'arc') {
    const arcPub = publicClient();
    const userGas = await arcPub.getBalance({ address: opts.userAddress });
    if (userGas > 0n) {
      const { account, client } = walletClientFromPk(opts.userKey);
      const hash = await client.sendTransaction({
        account,
        chain: client.chain,
        to,
        data,
      });
      await arcPub.waitForTransactionReceipt({ hash });
      return hash;
    }
    if (!relayerKey) {
      throw new Error(
        'First-time bridge needs gas sponsorship. Operator must set BRIDGE_RELAYER_PRIVATE_KEY ' +
          '(an Arc wallet funded with a little native USDC). Your deposit is safe — use Claim In after that.',
      );
    }
    await opts.progress('Using platform gas sponsor for Arc mint…');
    const { account, client } = walletClientFromPk(relayerKey);
    const relayerGas = await arcPub.getBalance({ address: account.address });
    if (relayerGas === 0n) {
      throw new Error(
        'Gas sponsor is out of native USDC on Arc. Deposit is safe — operator must top up relayer.',
      );
    }
    const hash = await client.sendTransaction({
      account,
      chain: client.chain,
      to,
      data,
    });
    await arcPub.waitForTransactionReceipt({ hash });
    return hash;
  }

  // Base
  const basePub = basePublicClient();
  const userEth = await basePub.getBalance({ address: opts.userAddress });
  if (userEth > 0n) {
    const { account, client } = baseWalletFromPk(opts.userKey);
    const hash = await client.sendTransaction({
      account,
      chain: client.chain,
      to,
      data,
    });
    await basePub.waitForTransactionReceipt({ hash });
    return hash;
  }
  if (!relayerKey) {
    throw new Error(
      'Need ETH on Base for mint, or set BRIDGE_RELAYER_PRIVATE_KEY. Deposit is safe — use Claim Out later.',
    );
  }
  await opts.progress('Using platform gas sponsor for Base mint…');
  const { account, client } = baseWalletFromPk(relayerKey);
  if ((await basePub.getBalance({ address: account.address })) === 0n) {
    throw new Error('Gas sponsor is out of ETH on Base. Deposit is safe — top up relayer.');
  }
  const hash = await client.sendTransaction({
    account,
    chain: client.chain,
    to,
    data,
  });
  await basePub.waitForTransactionReceipt({ hash });
  return hash;
}

async function waitGatewayBalance(
  address: `0x${string}`,
  domain: number,
  need: bigint,
  progress: BridgeProgress,
  timeoutMs: number,
  pollMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let gatewayBal = 0n;
  while (Date.now() < deadline) {
    try {
      gatewayBal = await getGatewayBalance(address, domain);
      if (gatewayBal >= need) return gatewayBal;
      await progress(
        `Circle indexing… $${formatUnits(gatewayBal, USDC_DEC)} / $${formatUnits(need, USDC_DEC)}`,
      );
    } catch (e) {
      await progress(
        `Waiting for Circle… (${e instanceof Error ? e.message.slice(0, 60) : 'retry'})`,
      );
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Circle has not credited yet ($${formatUnits(gatewayBal, USDC_DEC)}). ` +
      `Funds are safe in Gateway — use *Claim* from Bridge menu.`,
  );
}

/** Claim Gateway balance toward a destination (in = mint Arc, out = mint Base). */
export async function claimGateway(opts: {
  privateKey: Hex;
  direction: BridgeDirection;
  onProgress?: BridgeProgress;
}): Promise<{ mintTx: Hex; amount: string; scan: string } | null> {
  const progress = opts.onProgress ?? (() => {});
  const { account } = baseWalletFromPk(opts.privateKey);
  const sourceDomain = opts.direction === 'in' ? BASE_DOMAIN : ARC_DOMAIN;
  const destDomain = opts.direction === 'in' ? ARC_DOMAIN : BASE_DOMAIN;
  const sourceToken = opts.direction === 'in' ? env.baseUsdc() : env.usdc();
  const destToken = opts.direction === 'in' ? env.usdc() : env.baseUsdc();

  const gatewayBal = await getGatewayBalance(account.address, sourceDomain);
  if (gatewayBal <= CIRCLE_MAX_FEE) return null;

  const transferValue = gatewayBal - CIRCLE_MAX_FEE;
  await progress(
    `Claiming $${formatUnits(transferValue, USDC_DEC)} → ${opts.direction === 'in' ? 'Arc' : 'Base'}…`,
  );

  const { attestation, signature } = await signAndTransfer({
    privateKey: opts.privateKey,
    sourceDomain,
    destDomain,
    sourceToken,
    destToken,
    transferValue,
    address: account.address,
  });

  const mintTx = await mintOnDestination({
    chain: opts.direction === 'in' ? 'arc' : 'base',
    userKey: opts.privateKey,
    userAddress: account.address,
    attestation,
    signature,
    progress,
  });

  return {
    mintTx,
    amount: formatUnits(transferValue, USDC_DEC),
    scan: opts.direction === 'in' ? txUrl(mintTx) : baseTxUrl(mintTx),
  };
}

/** @deprecated use bridgeUsdc */
export async function bridgeBaseToArc(opts: {
  privateKey: Hex;
  usdcAmount: string;
  onProgress?: BridgeProgress;
}): Promise<BridgeResult> {
  return bridgeUsdc({ ...opts, direction: 'in' });
}

/** @deprecated use claimGateway */
export async function claimGatewayToArc(opts: {
  privateKey: Hex;
  onProgress?: BridgeProgress;
}): Promise<{ mintTx: Hex; amount: string; arcScan: string } | null> {
  const r = await claimGateway({ ...opts, direction: 'in' });
  if (!r) return null;
  return { mintTx: r.mintTx, amount: r.amount, arcScan: r.scan };
}

export function formatBridgeQuote(
  grossHuman: string,
  feeExempt: boolean,
  direction: BridgeDirection = 'in',
): string {
  try {
    const gross = parseUnits(grossHuman, USDC_DEC);
    const { fee, net } = feeExempt
      ? { fee: 0n, net: gross }
      : computeBridgeFee(gross);
    const pct = (env.bridgeFeeBps() / 100).toFixed(2);
    const route = directionLabel(direction);
    const dest = direction === 'in' ? 'Arc' : 'Base';
    return feeExempt
      ? `*${route}* · $${formatUnits(gross, USDC_DEC)} (fee waived) → ~$${formatUnits(net, USDC_DEC)} on ${dest}`
      : `*${route}* · $${formatUnits(gross, USDC_DEC)} · fee ${pct}% ($${formatUnits(fee, USDC_DEC)}) → ~$${formatUnits(net, USDC_DEC)} on ${dest}`;
  } catch {
    return 'Enter a valid amount';
  }
}

export type BridgeRelayerStatus = {
  configured: boolean;
  address: `0x${string}` | null;
  /** Native gas on Arc (native USDC units, 18 dec) */
  arcGas: bigint;
  /** ETH on Base */
  baseEth: bigint;
  canSponsorArc: boolean;
  canSponsorBase: boolean;
};

/** Operator gas sponsor for gatewayMint when user has no dest-chain gas. */
export async function getBridgeRelayerStatus(): Promise<BridgeRelayerStatus> {
  const key = env.bridgeRelayerKey();
  if (!key) {
    return {
      configured: false,
      address: null,
      arcGas: 0n,
      baseEth: 0n,
      canSponsorArc: false,
      canSponsorBase: false,
    };
  }
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(key);
  let arcGas = 0n;
  let baseEth = 0n;
  try {
    arcGas = await publicClient().getBalance({ address: account.address });
  } catch {
    /* */
  }
  try {
    baseEth = await basePublicClient().getBalance({ address: account.address });
  } catch {
    /* */
  }
  return {
    configured: true,
    address: account.address,
    arcGas,
    baseEth,
    canSponsorArc: arcGas > 0n,
    canSponsorBase: baseEth > 0n,
  };
}

export function formatRelayerStatusLine(s: BridgeRelayerStatus): string {
  if (!s.configured) {
    return '⛽ Gas sponsor: *not configured* _(first-time Bridge In needs Arc gas or operator setup)_';
  }
  const arcOk = s.canSponsorArc ? '✓ Arc' : '✗ Arc empty';
  const baseOk = s.canSponsorBase ? '✓ Base' : '✗ Base empty';
  return `⛽ Gas sponsor: *${arcOk}* · *${baseOk}*`;
}
