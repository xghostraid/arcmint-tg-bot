/**
 * ERC-20 withdraw / send from the user's bot wallet on Arc Mainnet.
 */
import { encodeFunctionData, parseUnits, type Hex } from 'viem';
import { publicClient, walletClientFromPk, txUrl } from '../chain/client.js';
import { erc20Abi } from '../chain/abis.js';
import { getTokenBalance, getTokenMeta } from './balances.js';
import { env } from '../config/env.js';

export async function transferToken(opts: {
  privateKey: Hex;
  token: `0x${string}`;
  to: `0x${string}`;
  /** Human amount string e.g. "10.5" */
  amountHuman: string;
}): Promise<{ hash: Hex; amountRaw: bigint; symbol: string; decimals: number }> {
  const { privateKey, token, to, amountHuman } = opts;
  const meta = await getTokenMeta(token);
  const amountRaw = parseUnits(amountHuman.replace(/,/g, ''), meta.decimals);
  if (amountRaw <= 0n) throw new Error('Amount must be > 0');

  const { account, client } = walletClientFromPk(privateKey);
  const bal = await getTokenBalance(token, account.address);
  if (bal < amountRaw) {
    throw new Error(
      `Insufficient balance (have ${bal.toString()} raw, need ${amountRaw.toString()})`,
    );
  }

  // Need native Arc gas for the transfer tx
  const gas = await publicClient().getBalance({ address: account.address });
  if (gas === 0n) {
    throw new Error(
      'No native gas on Arc (native USDC). Fund a little gas in this wallet to send tokens.',
    );
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amountRaw],
  });

  const hash = await client.sendTransaction({
    account,
    chain: client.chain,
    to: token,
    data,
  });
  await publicClient().waitForTransactionReceipt({ hash });
  return { hash, amountRaw, symbol: meta.symbol, decimals: meta.decimals };
}

export function isUsdcToken(token: string): boolean {
  return token.toLowerCase() === env.usdc().toLowerCase();
}

export { txUrl };
