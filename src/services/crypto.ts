import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { env } from '../config/env.js';

function keyBytes(): Buffer {
  const raw = env.encryptionKey();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  // Derive if user pasted a passphrase
  return scryptSync(raw, 'arcmint-tg-bot-v1', 32);
}

export function encryptPrivateKey(pk: Hex): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(pk.slice(2), 'hex'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptPrivateKey(blob: string): Hex {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return `0x${dec.toString('hex')}` as Hex;
}

export function createWallet(): { privateKey: Hex; address: `0x${string}` } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}
