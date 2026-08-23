/**
 * Sell PnL card → PNG.
 * Embeds DejaVu fonts so Railway/Docker slim images still show text
 * (system fonts are often missing → blank/garbled cards).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export type SellPnlCardInput = {
  symbol: string;
  pct: number;
  realizedUsdc: number | null;
  proceedsUsdc: number;
  tokenAmount: string;
  walletShort: string;
  txShort?: string;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fontRegular = path.join(root, 'assets/fonts/DejaVuSans.ttf');
const fontBold = path.join(root, 'assets/fonts/DejaVuSans-Bold.ttf');

let fontCss: string | null = null;

function loadFontCss(): string {
  if (fontCss) return fontCss;
  try {
    const reg = fs.readFileSync(fontRegular).toString('base64');
    const bold = fs.readFileSync(fontBold).toString('base64');
    fontCss = `
@font-face {
  font-family: 'Card';
  src: url('data:font/ttf;base64,${reg}') format('truetype');
  font-weight: 400;
  font-style: normal;
}
@font-face {
  font-family: 'Card';
  src: url('data:font/ttf;base64,${bold}') format('truetype');
  font-weight: 700;
  font-style: normal;
}`;
  } catch (e) {
    console.warn('[pnl-card] font load failed, text may be blank:', e);
    fontCss = '';
  }
  return fontCss;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ASCII-only money format (avoids missing-glyph unicode minus). */
function fmtUsd(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return 'n/a';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

function fmtAmt(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return esc(raw.slice(0, 14));
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(3)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(3)}K`;
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function buildSvg(input: SellPnlCardInput): string {
  const sym = esc((input.symbol || 'TOKEN').replace(/[^\w.\-]/g, '').slice(0, 16) || 'TOKEN');
  const hasPnl = input.realizedUsdc != null && Number.isFinite(input.realizedUsdc);
  const pnl = hasPnl ? (input.realizedUsdc as number) : 0;
  const win = hasPnl ? pnl >= 0 : true;
  const accent = hasPnl ? (win ? '#22c55e' : '#ef4444') : '#94a3b8';
  const glow = hasPnl ? (win ? '#14532d' : '#7f1d1d') : '#1e293b';
  const pnlBig = hasPnl ? fmtUsd(pnl) : 'n/a';
  const costEst = hasPnl ? input.proceedsUsdc - pnl : 0;
  const pctLabel =
    hasPnl && costEst > 1e-6
      ? `${pnl >= 0 ? '+' : ''}${((pnl / costEst) * 100).toFixed(1)}% vs cost`
      : hasPnl
        ? ''
        : 'No bot cost basis';

  const proceeds = `$${Number(input.proceedsUsdc).toFixed(2)}`;
  const amount = fmtAmt(input.tokenAmount);
  const wallet = esc(input.walletShort.replace(/…/g, '...'));
  const title = hasPnl ? (win ? 'PROFIT' : 'LOSS') : 'SOLD';
  const pctStr = `${Math.round(input.pct)}%`;
  const fonts = loadFontCss();

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="900" height="520" viewBox="0 0 900 520" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style type="text/css"><![CDATA[
      ${fonts}
      .t { font-family: 'Card', DejaVu Sans, Arial, sans-serif; }
    ]]></style>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="60%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="${glow}"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.25"/>
      <stop offset="50%" stop-color="${accent}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.25"/>
    </linearGradient>
  </defs>

  <rect x="16" y="16" width="868" height="488" rx="28" fill="url(#bg)" stroke="${accent}" stroke-width="3"/>
  <rect x="16" y="16" width="868" height="10" rx="4" fill="url(#bar)"/>

  <text class="t" x="48" y="72" fill="#94a3b8" font-size="22" font-weight="700">ARCTRADEBOT</text>
  <text class="t" x="852" y="72" text-anchor="end" fill="#64748b" font-size="18" font-weight="400">Arc Mainnet</text>

  <rect x="48" y="100" width="110" height="40" rx="12" fill="${accent}" fill-opacity="0.2" stroke="${accent}" stroke-width="2"/>
  <text class="t" x="103" y="128" text-anchor="middle" fill="${accent}" font-size="20" font-weight="700">SELL</text>
  <text class="t" x="180" y="128" fill="#f1f5f9" font-size="28" font-weight="700">$${sym}</text>
  <text class="t" x="852" y="128" text-anchor="end" fill="#94a3b8" font-size="22" font-weight="400">${esc(pctStr)} sold</text>

  <text class="t" x="450" y="215" text-anchor="middle" fill="#94a3b8" font-size="22" font-weight="700">${title}</text>
  <text class="t" x="450" y="300" text-anchor="middle" fill="${accent}" font-size="80" font-weight="700">${esc(pnlBig)}</text>
  ${
    pctLabel
      ? `<text class="t" x="450" y="348" text-anchor="middle" fill="#cbd5e1" font-size="24" font-weight="400">${esc(pctLabel)}</text>`
      : ''
  }

  <rect x="48" y="390" width="804" height="90" rx="18" fill="#020617" fill-opacity="0.65" stroke="#334155" stroke-width="1"/>
  <text class="t" x="150" y="425" text-anchor="middle" fill="#64748b" font-size="15" font-weight="400">PROCEEDS</text>
  <text class="t" x="150" y="458" text-anchor="middle" fill="#f8fafc" font-size="24" font-weight="700">${esc(proceeds)}</text>
  <text class="t" x="360" y="425" text-anchor="middle" fill="#64748b" font-size="15" font-weight="400">AMOUNT</text>
  <text class="t" x="360" y="458" text-anchor="middle" fill="#f8fafc" font-size="24" font-weight="700">${esc(amount)}</text>
  <text class="t" x="570" y="425" text-anchor="middle" fill="#64748b" font-size="15" font-weight="400">WALLET</text>
  <text class="t" x="570" y="458" text-anchor="middle" fill="#f8fafc" font-size="20" font-weight="700">${wallet}</text>
  <text class="t" x="760" y="425" text-anchor="middle" fill="#64748b" font-size="15" font-weight="400">SIDE</text>
  <text class="t" x="760" y="458" text-anchor="middle" fill="${accent}" font-size="24" font-weight="700">SELL</text>
</svg>`;
}

export async function renderSellPnlCard(input: SellPnlCardInput): Promise<Buffer> {
  const svg = buildSvg(input);
  return sharp(Buffer.from(svg, 'utf8'), { density: 144 })
    .png({ compressionLevel: 6 })
    .toBuffer();
}
