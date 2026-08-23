import { InlineKeyboard } from 'grammy';
import type { ReplyKeyboardRemove } from 'grammy/types';
import { env } from '../config/env.js';
import { LANGS, LANG_LABELS, normalizeLang, t, type Lang } from '../i18n/index.js';

/** Dismiss Telegram's bottom reply keyboard (if one was shown earlier). */
export function hideReplyKeyboard(): ReplyKeyboardRemove {
  return { remove_keyboard: true };
}

function L(lang?: string | null): Lang {
  return normalizeLang(lang);
}

/** Nav footer: Back + Home — always on the message (inline) */
function navRow(kb: InlineKeyboard, back: string = 'menu:back', lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return kb.row().text(t(l, 'back'), back).text(t(l, 'home'), 'menu:home');
}

/**
 * Home screen actions — inline buttons under the home message (in the chat),
 * NOT the system keyboard area at the bottom of Telegram.
 */
export function mainMenu(hasWallet = true, lang?: string | null): InlineKeyboard {
  const l = L(lang);
  const kb = new InlineKeyboard();
  if (!hasWallet) {
    kb.text(t(l, 'create_wallet'), 'wallet:create')
      .text(t(l, 'import'), 'wallet:import')
      .row();
  }
  return kb
    .text(t(l, 'buy'), 'menu:buy')
    .text(t(l, 'sell'), 'menu:sell')
    .text(t(l, 'positions'), 'menu:positions')
    .row()
    .text(t(l, 'bridge'), 'menu:bridge')
    .text(t(l, 'send'), 'menu:send')
    .text(t(l, 'wallet'), 'menu:wallet')
    .row()
    .text(t(l, 'watchlist'), 'menu:watchlist')
    .text(t(l, 'history'), 'menu:history')
    .text(t(l, 'ref'), 'menu:referral')
    .row()
    .text(t(l, 'settings'), 'menu:settings')
    .text(t(l, 'refresh'), 'menu:refresh')
    .url(t(l, 'explorer'), env.explorer())
    .row()
    .text(t(l, 'back'), 'menu:back')
    .text(t(l, 'home'), 'menu:home');
}

export function watchlistMenu(
  items: { address: string; symbol: string }[],
  lang?: string | null,
): InlineKeyboard {
  const l = L(lang);
  const kb = new InlineKeyboard();
  for (const it of items.slice(0, 20)) {
    kb.text(`$${it.symbol.slice(0, 14)}`, `token:${it.address}`)
      .text('🗑', `watch_rm:${it.address}`)
      .row();
  }
  kb.text('➕ Paste token', 'watch:paste').row();
  kb.text(t(l, 'refresh'), 'menu:watchlist').row();
  return navRow(kb, 'menu:back', l);
}

/** Pick asset to withdraw / send */
export function sendAssetMenu(
  tokens: { address: string; symbol: string; formatted: string }[],
  lang?: string | null,
): InlineKeyboard {
  const l = L(lang);
  const kb = new InlineKeyboard();
  kb.text('💵 USDC', `send_asset:${env.usdc()}`).row();
  for (const tok of tokens.slice(0, 12)) {
    if (tok.address.toLowerCase() === env.usdc().toLowerCase()) continue;
    const label = `$${tok.symbol.slice(0, 12)} · ${tok.formatted}`.slice(0, 48);
    kb.text(label, `send_asset:${tok.address}`).row();
  }
  kb.text('📝 Other token', 'send_asset:paste').row();
  return navRow(kb, 'menu:back', l);
}

export function confirmSend(lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text('✅ Confirm send', 'send_go')
    .row()
    .text(t(l, 'cancel'), 'menu:home')
    .text(t(l, 'back'), 'menu:send');
}

/** When no swap pool — still let user withdraw the bag */
export function noPoolSellMenu(token: string, lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text('📤 Send / withdraw token', `send_asset:${token}`)
    .row()
    .text(t(l, 'sell'), 'menu:sell')
    .text(t(l, 'home'), 'menu:home');
}

export function noPoolBuyMenu(lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text(t(l, 'buy'), 'menu:buy')
    .text(t(l, 'home'), 'menu:home');
}

export function historyMenu(lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text(t(l, 'refresh'), 'menu:history')
    .row()
    .text(t(l, 'back'), 'menu:back')
    .text(t(l, 'home'), 'menu:home');
}

/** Pick bridge direction */
export function bridgeMenu(lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text(t(l, 'bridge_in'), 'bridge:dir:in')
    .text(t(l, 'bridge_out'), 'bridge:dir:out')
    .row()
    .text(t(l, 'claim_in'), 'bridge:claim:in')
    .text(t(l, 'claim_out'), 'bridge:claim:out')
    .row()
    .text(t(l, 'refresh'), 'menu:bridge')
    .row()
    .text(t(l, 'back'), 'menu:back')
    .text(t(l, 'home'), 'menu:home');
}

/** Amount presets for a direction: in = Base→Arc, out = Arc→Base */
export function bridgeAmountMenu(dir: 'in' | 'out', lang?: string | null): InlineKeyboard {
  const l = L(lang);
  const kb = new InlineKeyboard();
  const presets = env.bridgePresets();
  presets.forEach((p, i) => {
    kb.text(`$${p}`, `bridge:${dir}:${p}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  kb.row().text(t(l, 'custom'), `bridge:custom:${dir}`);
  kb.row().text(t(l, 'back'), 'menu:bridge').text(t(l, 'home'), 'menu:home');
  return kb;
}

export function confirmBridge(
  dir: 'in' | 'out',
  amount: string,
  lang?: string | null,
): InlineKeyboard {
  const l = L(lang);
  const label = dir === 'in' ? t(l, 'confirm_bridge_in') : t(l, 'confirm_bridge_out');
  return new InlineKeyboard()
    .text(label, `bridge_go:${dir}:${amount}`)
    .row()
    .text(t(l, 'cancel'), 'menu:home')
    .text(t(l, 'back'), `bridge:dir:${dir}`);
}

export function referralMenu(
  inviteLink: string,
  lang?: string | null,
  shareText?: string,
): InlineKeyboard {
  const l = L(lang);
  const text = shareText || t(l, 'share_invite_text');
  return navRow(
    new InlineKeyboard()
      .url(
        t(l, 'share_invite'),
        `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(text)}`,
      )
      .row()
      .text(t(l, 'set_username'), 'ref:set_code')
      .text('📖 How it works', 'ref:how')
      .row()
      .text(t(l, 'refresh_stats'), 'menu:referral'),
    'menu:back',
    l,
  );
}

export function positionsMenu(
  tokens: { address: string; symbol: string; label?: string }[] = [],
  lang?: string | null,
): InlineKeyboard {
  const l = L(lang);
  const kb = new InlineKeyboard();
  const usdc = env.usdc().toLowerCase();
  const list = tokens.filter((x) => x.address.toLowerCase() !== usdc).slice(0, 8);
  for (let i = 0; i < list.length; i += 2) {
    const a = list[i]!;
    // Button label = $SYMBOL → opens full token info card
    kb.text(`$${(a.symbol || a.label || 'TOKEN').slice(0, 20)}`, `pos:${a.address}`);
    const b = list[i + 1];
    if (b) kb.text(`$${(b.symbol || b.label || 'TOKEN').slice(0, 20)}`, `pos:${b.address}`);
    kb.row();
  }
  kb.text(t(l, 'refresh'), 'menu:positions').text(t(l, 'sell'), 'menu:sell').row();
  kb.text(t(l, 'back'), 'menu:back').text(t(l, 'home'), 'menu:home');
  return kb;
}

export function positionDetailMenu(token: string, lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text(t(l, 'sell'), `sell_pick:${token}`)
    .text(t(l, 'buy_more'), `buy_more:${token}`)
    .row()
    .text(t(l, 'back'), 'menu:positions')
    .text(t(l, 'home'), 'menu:home');
}

/** Token card buy strip — presets + custom + optional sell + chart. */
export function buyPresets(
  token: string,
  lang?: string | null,
  opts?: { hasBalance?: boolean; watching?: boolean },
): InlineKeyboard {
  const l = L(lang);
  const kb = new InlineKeyboard();
  const presets = env.buyPresets();
  presets.forEach((p, i) => {
    kb.text(`$${p}`, `buy:${token}:${p}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  kb.row().text(t(l, 'custom_amount'), `buy_custom:${token}`);
  if (opts?.hasBalance) {
    kb.row().text(t(l, 'sell'), `sell_pick:${token}`);
  }
  if (opts?.watching) {
    kb.row().text('⭐ Watching · remove', `watch_rm:${token}`);
  } else {
    kb.row().text('☆ Watch', `watch_add:${token}`);
  }
  kb.row()
    .text(t(l, 'refresh'), `token:${token}`)
    .url(t(l, 'explorer'), `${env.explorer().replace(/\/$/, '')}/token/${token}`);
  return navRow(kb, 'menu:back', l);
}

/** Pick a holding to sell (excludes USDC). Optional pnlShort e.g. "+$12 (+4%)". */
export function sellTokenPicker(
  tokens: {
    address: string;
    symbol: string;
    formatted: string;
    pnlShort?: string;
  }[],
  lang?: string | null,
): InlineKeyboard {
  const l = L(lang);
  const kb = new InlineKeyboard();
  const usdc = env.usdc().toLowerCase();
  const sellable = tokens.filter((tkn) => tkn.address.toLowerCase() !== usdc);
  for (const tok of sellable.slice(0, 24)) {
    const pnl = tok.pnlShort ? ` · ${tok.pnlShort}` : '';
    const label = `$${tok.symbol.slice(0, 10)} · ${tok.formatted}${pnl}`.slice(0, 64);
    kb.text(label, `sell_pick:${tok.address}`).row();
  }
  kb.text(t(l, 'paste_token'), 'sell:paste').row();
  kb.text(t(l, 'refresh_list'), 'menu:sell');
  return navRow(kb, 'menu:back', l);
}

export function sellPresets(token: string, lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return navRow(
    new InlineKeyboard()
      .text('25%', `sell:${token}:25`)
      .text('50%', `sell:${token}:50`)
      .text('100%', `sell:${token}:100`)
      .row()
      .text('✏️ Custom $', `sell_usd:${token}`)
      .row()
      .text(t(l, 'tokens_back'), 'menu:sell'),
    'menu:back',
    l,
  );
}

/** pct: confirm_sell:0x…:25 · usd: confirm_sell:0x…:u:12.50 */
export function confirmSell(
  token: string,
  size: { kind: 'pct'; value: string } | { kind: 'usd'; value: string },
  lang?: string | null,
): InlineKeyboard {
  const l = L(lang);
  const cb =
    size.kind === 'usd'
      ? `confirm_sell:${token}:u:${size.value}`
      : `confirm_sell:${token}:${size.value}`;
  return new InlineKeyboard()
    .text(t(l, 'confirm_sell'), cb)
    .row()
    .text(t(l, 'cancel'), 'menu:home')
    .row()
    .text(t(l, 'back'), `sell_pick:${token}`)
    .text(t(l, 'home'), 'menu:home');
}

export function walletMenu(hasWallet: boolean, lang?: string | null): InlineKeyboard {
  const l = L(lang);
  const kb = new InlineKeyboard();
  if (!hasWallet) {
    kb.text(t(l, 'create_new_wallet'), 'wallet:create').row();
    kb.text(t(l, 'import_pk'), 'wallet:import').row();
  } else {
    kb.text(t(l, 'copy_address'), 'wallet:copy')
      .text(t(l, 'export_key'), 'wallet:export')
      .row();
    kb.text(t(l, 'send'), 'menu:send').row();
    kb.text(t(l, 'create_new_wallet'), 'wallet:create').row();
    kb.text(t(l, 'import_pk'), 'wallet:import').row();
  }
  return navRow(kb, 'menu:back', l);
}

export function settingsMenu(
  slippageBps: number,
  lang?: string | null,
  opts?: { isAdmin?: boolean },
): InlineKeyboard {
  const l = L(lang);
  const langLabel = LANG_LABELS[l] ?? LANG_LABELS.en;
  const kb = new InlineKeyboard()
    .text(`${t(l, 'settings_slippage')}: ${(slippageBps / 100).toFixed(1)}%`, 'noop')
    .row()
    .text('0.5%', 'slip:50')
    .text('1%', 'slip:100')
    .text('2%', 'slip:200')
    .text('5%', 'slip:500')
    .row()
    .text(`${t(l, 'language')}: ${langLabel}`, 'settings:lang');
  if (opts?.isAdmin) {
    kb.row().text('👑 Creator stats', 'menu:admin');
  }
  return navRow(kb, 'menu:back', l);
}

export function adminMenu(lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text(t(l, 'refresh'), 'menu:admin')
    .row()
    .text(t(l, 'settings'), 'menu:settings')
    .text(t(l, 'home'), 'menu:home');
}

export function languageMenu(current?: string | null): InlineKeyboard {
  const l = L(current);
  const kb = new InlineKeyboard();
  for (let i = 0; i < LANGS.length; i++) {
    const code = LANGS[i]!;
    const mark = code === l ? '✓ ' : '';
    kb.text(`${mark}${LANG_LABELS[code]}`, `lang:${code}`);
    if ((i + 1) % 2 === 0) kb.row();
  }
  if (LANGS.length % 2 !== 0) kb.row();
  kb.text(t(l, 'back'), 'menu:settings').text(t(l, 'home'), 'menu:home');
  return kb;
}

export function confirmBuy(token: string, amount: string, lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text(t(l, 'confirm_buy'), `confirm_buy:${token}:${amount}`)
    .row()
    .text(t(l, 'cancel'), 'menu:home')
    .row()
    .text(t(l, 'back'), `back:buy:${token}`)
    .text(t(l, 'home'), 'menu:home');
}

/** Waiting for user text input */
export function cancelOnly(back: string = 'menu:back', lang?: string | null): InlineKeyboard {
  const l = L(lang);
  return new InlineKeyboard()
    .text(t(l, 'back'), back)
    .text(t(l, 'home'), 'menu:home');
}
