import { Bot, InputFile, type Context, session, type SessionFlavor } from 'grammy';
import { formatUnits, isAddress, getAddress, type Hex } from 'viem';
import { env } from '../config/env.js';
import { addressUrl } from '../chain/client.js';
import {
  addWallet,
  ensureUser,
  getActiveWallet,
  getReferralStats,
  getReferrerTgId,
  getLang,
  getSlippage,
  listWallets,
  setLang,
  formatPnlLines,
  getInviteSlug,
  getPositionPnl,
  getRefCode,
  addToWatchlist,
  getCreatorFeeStats,
  isOnWatchlist,
  listTrades,
  listWatchlist,
  recordBuyCost,
  referralEarningsExample,
  removeFromWatchlist,
  recordFeeEvent,
  recordSellCost,
  recordTrade,
  rememberToken,
  resolveReferrerFromPayload,
  setRefCode,
  setSlippage,
  trySetReferrer,
} from '../db/store.js';
import { createWallet, decryptPrivateKey, encryptPrivateKey } from '../services/crypto.js';
import { getTokenBalance, getTokenMeta, getUsdcBalance } from '../services/balances.js';
import {
  buyTokenWithUsdc,
  computePlatformFee,
  formatPlatformFeeLine,
  formatQuoteHuman,
  formatSellQuoteHuman,
  formatUsdc,
  parseUnitsSafe,
  quoteTokenToUsdc,
  quoteUsdcToToken,
  sellTokenForUsdc,
  txUrl,
} from '../services/swap.js';
import {
  buildTokenCard,
  enrichPositions,
  fetchWalletHoldings,
  formatPortfolioMessage,
  formatTokenDetail,
  tokenNameLink,
} from '../services/positions.js';
import {
  bridgeAmountMenu,
  bridgeMenu,
  buyPresets,
  cancelOnly,
  confirmBridge,
  confirmBuy,
  confirmSell,
  hideReplyKeyboard,
  adminMenu,
  confirmSend,
  noPoolBuyMenu,
  noPoolSellMenu,
  historyMenu,
  mainMenu,
  positionDetailMenu,
  positionsMenu,
  referralMenu,
  sellPresets,
  sellTokenPicker,
  sendAssetMenu,
  watchlistMenu,
  languageMenu,
  settingsMenu,
  walletMenu,
} from './keyboards.js';
import { LANG_LABELS, normalizeLang, t } from '../i18n/index.js';
import {
  bridgeUsdc,
  claimGateway,
  directionLabel,
  formatBridgeQuote,
  formatRelayerStatusLine,
  getArcUsdcBalance,
  getBaseUsdcBalance,
  getBridgeRelayerStatus,
  getGatewayBalance,
  type BridgeDirection,
} from '../services/bridge.js';
import { renderSellPnlCard } from '../services/pnlCard.js';
import { transferToken, txUrl as transferTxUrl } from '../services/transfer.js';

type SessionData = {
  expect?:
    | 'import_pk'
    | 'buy_token'
    | 'buy_amount'
    | 'sell_token'
    | 'sell_usd_amount'
    | 'set_ref_code'
    | 'bridge_amount'
    | 'send_token'
    | 'send_to'
    | 'send_amount'
    | 'watch_token'
    | null;
  pendingToken?: string;
  bridgeDir?: BridgeDirection;
  /** Withdraw / send draft (confirmed via send_go) */
  sendDraft?: {
    token: `0x${string}`;
    to: `0x${string}`;
    amountHuman: string;
    symbol: string;
  };
};

/** Sell by % of bag or by target USDC proceeds (pre-fee quote). */
type SellSize = { kind: 'pct'; pct: number } | { kind: 'usd'; usdc: number };

export type BotContext = Context & SessionFlavor<SessionData>;

function allowed(ctx: BotContext): boolean {
  const list = env.allowlist();
  if (list.length === 0) return true;
  const id = ctx.from?.id;
  return Boolean(id && list.includes(id));
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function userLang(tgId: number) {
  return normalizeLang(getLang(tgId));
}

function langOf(ctx: BotContext) {
  return userLang(ctx.from!.id);
}

function settingsText(tgId: number): string {
  const lang = userLang(tgId);
  const slip = getSlippage(tgId);
  const label = LANG_LABELS[lang] ?? LANG_LABELS.en;
  return [
    t(lang, 'settings_title'),
    `${t(lang, 'settings_slippage')}: *${(slip / 100).toFixed(1)}%*`,
    `${t(lang, 'settings_language')}: *${label}*`,
  ].join('\n');
}

async function homeText(tgId: number): Promise<string> {
  const lang = userLang(tgId);
  const w = getActiveWallet(tgId);
  if (!w) {
    return t(lang, 'home_no_wallet');
  }

  // Never hang home > 4s even if Arc RPC is dead
  let cashStr = '—';
  try {
    const usdc = await Promise.race([
      getUsdcBalance(w.address as `0x${string}`),
      new Promise<{ formatted: string }>((resolve) =>
        setTimeout(() => resolve({ formatted: '—' }), 4_000),
      ),
    ]);
    if (usdc.formatted !== '—') {
      const cash = Number(usdc.formatted);
      cashStr = Number.isFinite(cash) ? `$${cash.toFixed(2)}` : '—';
    }
  } catch {
    cashStr = '—';
  }

  return [
    `*ArcTradeBot*  ·  Arc`,
    ``,
    `\`${w.address}\``,
    ``,
    `${t(lang, 'home_usdc')}  \`${cashStr}\``,
    `_Open Positions for token marks_`,
    ``,
    t(lang, 'home_paste'),
  ].join('\n');
}

function hasAnyWallet(tgId: number): boolean {
  return listWallets(tgId).length > 0;
}

/** Dismiss leftover reply keyboard — fire-and-forget (never block UX). */
function clearBottomKeyboard(ctx: BotContext): void {
  void (async () => {
    try {
      const msg = await ctx.reply('\u2060', { reply_markup: hideReplyKeyboard() });
      await ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    } catch {
      /* ignore */
    }
  })();
}

async function sendHome(ctx: BotContext, opts?: { edit?: boolean }): Promise<void> {
  ctx.session.expect = null;
  ctx.session.pendingToken = undefined;
  const id = ctx.from!.id;
  const hasWallet = hasAnyWallet(id);
  const text = await homeText(id);
  const menu = mainMenu(hasWallet, userLang(id));

  // Inline buttons under the message (in-chat) — never the system keyboard strip
  if (opts?.edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: menu,
      });
      return;
    } catch {
      /* fall through to new message */
    }
  }

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: menu,
  });
}

export function createBot(token: string): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  bot.use(
    session({
      initial: (): SessionData => ({}),
    }),
  );

  bot.use(async (ctx, next) => {
    if (!allowed(ctx)) {
      await ctx.reply(t(langOf(ctx), 'private_bot'));
      return;
    }
    if (ctx.from) ensureUser(ctx.from.id);
    // Never let a handler hang forever (RPC freezes felt like "bot dead")
    try {
      await Promise.race([
        next(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('handler timeout 45s')), 45_000),
        ),
      ]);
    } catch (e) {
      console.error('[bot] handler timeout/error:', e);
      try {
        await ctx.reply('Took too long. Try again.', {
          reply_markup: mainMenu(hasAnyWallet(ctx.from!.id), langOf(ctx)),
        });
      } catch {
        /* */
      }
    }
  });

  bot.command('start', async (ctx) => {
    const arg = (ctx.message?.text || '').split(/\s+/)[1];
    if (arg && ctx.from) {
      // Deep link: tok_0x… / token_0x… / bare 0x… → full token card
      const tokPayload = arg.match(/^(?:tok|token)[_-]?(0x[0-9a-fA-F]{40})$/i);
      const bareAddr = /^0x[0-9a-fA-F]{40}$/i.test(arg) ? arg : null;
      const tokenArg = tokPayload?.[1] || bareAddr;
      if (tokenArg && isAddress(tokenArg)) {
        clearBottomKeyboard(ctx);
        await openBuy(ctx, getAddress(tokenArg));
        return;
      }

      // /start ref_alice | ref_123456789 | alice — bind referrer once
      const refId = resolveReferrerFromPayload(arg);
      if (refId) {
        const bound = trySetReferrer(ctx.from.id, refId);
        if (bound) {
          const who = getRefCode(refId) || String(refId);
          await ctx.reply(
            `✅ Referral linked to *${who.replace(/[_*`]/g, '')}*.`,
            { parse_mode: 'Markdown' },
          );
        }
      }
    }
    clearBottomKeyboard(ctx);
    await sendHome(ctx);
  });

  bot.command('home', async (ctx) => {
    await sendHome(ctx);
  });

  bot.command('help', async (ctx) => {
    const lang = langOf(ctx);
    await ctx.reply(
      [t(lang, 'help_title'), t(lang, 'help_body')].join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: mainMenu(hasAnyWallet(ctx.from!.id), lang),
      },
    );
  });

  bot.command('wallet', async (ctx) => {
    await showWallet(ctx);
  });

  bot.command('settings', async (ctx) => {
    const id = ctx.from!.id;
    const lang = userLang(id);
    const slip = getSlippage(id);
    await ctx.reply(settingsText(id), {
      parse_mode: 'Markdown',
      reply_markup: settingsMenu(slip, lang, { isAdmin: env.isAdmin(id) }),
    });
  });

  bot.command('admin', async (ctx) => {
    await showAdmin(ctx);
  });

  bot.command('buy', async (ctx) => {
    const parts = (ctx.message?.text || '').split(/\s+/);
    const token = parts[1];
    if (token && isAddress(token)) {
      await openBuy(ctx, getAddress(token));
      return;
    }
    ctx.session.expect = 'buy_token';
    await ctx.reply(t(langOf(ctx), 'send_token_buy_cmd'), {
      parse_mode: 'Markdown',
      reply_markup: cancelOnly('menu:back', langOf(ctx)),
    });
  });

  bot.command('sell', async (ctx) => {
    await showSellPicker(ctx);
  });

  bot.command('positions', async (ctx) => {
    await showPositions(ctx);
  });

  bot.command('bridge', async (ctx) => {
    await showBridge(ctx);
  });

  bot.command(['referral', 'ref'], async (ctx) => {
    await showReferral(ctx);
  });

  bot.command('history', async (ctx) => {
    await showHistory(ctx);
  });

  bot.command(['send', 'withdraw'], async (ctx) => {
    await showSend(ctx);
  });

  bot.command(['watchlist', 'watch'], async (ctx) => {
    await showWatchlist(ctx);
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => {});
    const id = ctx.from!.id;

    if (data === 'noop') return;

    if (data === 'menu:home' || data === 'menu:refresh' || data === 'menu:back') {
      // Prefer edit so buttons stay on the same message (in-chat)
      await sendHome(ctx, { edit: true });
      return;
    }

    if (data.startsWith('back:buy:')) {
      const token = data.slice('back:buy:'.length);
      if (token && isAddress(token)) {
        await openBuy(ctx, getAddress(token));
      } else {
        await sendHome(ctx);
      }
      return;
    }

    if (data === 'menu:wallet') {
      // Clear input waits when entering wallet
      ctx.session.expect = null;
      await showWallet(ctx, true);
      return;
    }

    if (data === 'menu:buy') {
      ctx.session.expect = 'buy_token';
      await ctx.reply(t(langOf(ctx), 'send_token_buy'), {
        parse_mode: 'Markdown',
        reply_markup: cancelOnly('menu:back', langOf(ctx)),
      });
      return;
    }

    if (data === 'menu:sell') {
      await showSellPicker(ctx, true);
      return;
    }

    if (data === 'menu:bridge') {
      await showBridge(ctx, true);
      return;
    }

    if (data === 'menu:history') {
      await showHistory(ctx, true);
      return;
    }

    if (data === 'menu:send') {
      await showSend(ctx, true);
      return;
    }

    if (data === 'menu:watchlist') {
      await showWatchlist(ctx, true);
      return;
    }

    if (data === 'watch:paste') {
      ctx.session.expect = 'watch_token';
      await ctx.reply('Send a *token contract* to add to your watchlist (`0x…`):', {
        parse_mode: 'Markdown',
        reply_markup: cancelOnly('menu:watchlist', langOf(ctx)),
      });
      return;
    }

    if (data.startsWith('watch_add:')) {
      const token = data.slice('watch_add:'.length);
      if (!token || !isAddress(token)) return;
      const addr = getAddress(token);
      let symbol = 'TOKEN';
      try {
        symbol = (await getTokenMeta(addr)).symbol;
      } catch {
        /* */
      }
      const added = addToWatchlist(id, addr, symbol);
      await ctx.reply(
        added
          ? `⭐ Added *$${symbol}* to watchlist`
          : `⭐ *$${symbol}* already on your watchlist`,
        {
          parse_mode: 'Markdown',
          reply_markup: buyPresets(addr, langOf(ctx), {
            hasBalance: false,
            watching: true,
          }),
        },
      );
      return;
    }

    if (data.startsWith('watch_rm:')) {
      const token = data.slice('watch_rm:'.length);
      if (!token || !isAddress(token)) return;
      const addr = getAddress(token);
      removeFromWatchlist(id, addr);
      await ctx.reply(`Removed from watchlist.`, {
        reply_markup: watchlistMenu(
          listWatchlist(id).map((w) => ({
            address: w.token_address,
            symbol: w.symbol,
          })),
          langOf(ctx),
        ),
      });
      return;
    }

    if (data.startsWith('send_asset:')) {
      const part = data.slice('send_asset:'.length);
      if (part === 'paste') {
        ctx.session.expect = 'send_token';
        ctx.session.sendDraft = undefined;
        await ctx.reply('Send the *token contract* to withdraw (`0x…`):', {
          parse_mode: 'Markdown',
          reply_markup: cancelOnly('menu:send', langOf(ctx)),
        });
        return;
      }
      if (!isAddress(part)) return;
      await beginSendTo(ctx, getAddress(part));
      return;
    }

    if (data === 'send_go') {
      await executeSend(ctx);
      return;
    }

    // Refresh token card (paste / buy screen)
    if (data.startsWith('token:')) {
      const token = data.slice('token:'.length);
      if (token && isAddress(token)) {
        await openBuy(ctx, getAddress(token));
      }
      return;
    }

    if (data === 'bridge:dir:in' || data === 'bridge:dir:out') {
      const dir = data.endsWith(':in') ? 'in' : 'out';
      ctx.session.bridgeDir = dir;
      await ctx.reply(
        dir === 'in'
          ? `*Bridge In* · Base → Arc\nPick amount (USDC on *Base*):`
          : `*Bridge Out* · Arc → Base\nPick amount (USDC on *Arc*):`,
        { parse_mode: 'Markdown', reply_markup: bridgeAmountMenu(dir, langOf(ctx)) },
      );
      return;
    }

    if (data.startsWith('bridge:custom:')) {
      const dir = data.endsWith(':out') ? 'out' : 'in';
      ctx.session.bridgeDir = dir;
      ctx.session.expect = 'bridge_amount';
      await ctx.reply(
        dir === 'in'
          ? 'Send USDC amount to bridge *Base → Arc* (e.g. `25`):'
          : 'Send USDC amount to bridge *Arc → Base* (e.g. `25`):',
        { parse_mode: 'Markdown', reply_markup: cancelOnly('menu:bridge', langOf(ctx)) },
      );
      return;
    }

    if (data === 'bridge:claim:in' || data === 'bridge:claim:out') {
      const dir = data.endsWith(':in') ? 'in' : 'out';
      await runBridgeClaim(ctx, dir);
      return;
    }

    // bridge:in:25 or bridge:out:10
    if (/^bridge:(in|out):[\d.]+$/.test(data)) {
      const [, dir, amount] = data.split(':') as [string, BridgeDirection, string];
      if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return;
      await previewBridge(ctx, amount, dir);
      return;
    }

    if (data.startsWith('bridge_go:')) {
      // bridge_go:in:25
      const parts = data.split(':');
      const dir = (parts[1] === 'out' ? 'out' : 'in') as BridgeDirection;
      const amount = parts[2];
      if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return;
      await executeBridge(ctx, amount, dir);
      return;
    }

    if (data === 'sell:paste') {
      ctx.session.expect = 'sell_token';
      await ctx.reply('Send the *token contract address* to sell:', {
        parse_mode: 'Markdown',
        reply_markup: cancelOnly('menu:sell', langOf(ctx)),
      });
      return;
    }

    if (data.startsWith('sell_pick:')) {
      const token = data.slice('sell_pick:'.length);
      if (!token || !isAddress(token)) return;
      await openSell(ctx, getAddress(token));
      return;
    }

    if (data === 'menu:positions') {
      await showPositions(ctx, true);
      return;
    }

    if (data.startsWith('pos:')) {
      const token = data.slice('pos:'.length);
      if (!token || !isAddress(token)) return;
      // Full token card (price / MC / holders / buy) — same as tapping the name link
      await openBuy(ctx, getAddress(token));
      return;
    }

    if (data.startsWith('buy_more:')) {
      const token = data.slice('buy_more:'.length);
      if (!token || !isAddress(token)) return;
      await openBuy(ctx, getAddress(token));
      return;
    }

    if (data === 'menu:referral') {
      await showReferral(ctx, true);
      return;
    }

    if (data === 'ref:how') {
      await showReferralHowItWorks(ctx);
      return;
    }

    if (data === 'ref:set_code') {
      ctx.session.expect = 'set_ref_code';
      await ctx.reply('Send a username (3–20 chars, letters/numbers/_).', {
        reply_markup: cancelOnly('menu:referral', langOf(ctx)),
      });
      return;
    }

    if (data === 'menu:settings') {
      const lang = userLang(id);
      const slip = getSlippage(id);
      await ctx.reply(settingsText(id), {
        parse_mode: 'Markdown',
        reply_markup: settingsMenu(slip, lang, { isAdmin: env.isAdmin(id) }),
      });
      return;
    }

    if (data === 'menu:admin') {
      await showAdmin(ctx, true);
      return;
    }

    if (data === 'settings:lang') {
      const lang = userLang(id);
      await ctx.reply(t(lang, 'settings_pick_lang'), {
        reply_markup: languageMenu(lang),
      });
      return;
    }

    if (data.startsWith('lang:')) {
      const next = normalizeLang(data.slice('lang:'.length));
      setLang(id, next);
      const slip = getSlippage(id);
      await ctx.reply(t(next, 'lang_set', { label: LANG_LABELS[next] }), {
        parse_mode: 'Markdown',
        reply_markup: settingsMenu(slip, next, { isAdmin: env.isAdmin(id) }),
      });
      return;
    }

    if (data.startsWith('slip:')) {
      const bps = Number(data.split(':')[1]);
      setSlippage(id, bps);
      const lang = userLang(id);
      await ctx.reply(t(lang, 'slippage_set', { pct: (bps / 100).toFixed(1) }), {
        parse_mode: 'Markdown',
        reply_markup: settingsMenu(bps, lang, { isAdmin: env.isAdmin(id) }),
      });
      return;
    }

    if (data === 'wallet:create') {
      const { privateKey, address } = createWallet();
      const enc = encryptPrivateKey(privateKey);
      const n = listWallets(id).length + 1;
      addWallet(id, `W${n}`, address, enc);
      const body = [
        `✅ *Wallet created* (Arc Mainnet)`,
        ``,
        `\`${address}\``,
        ``,
        `Fund with *USDC* (for trades) and *native gas USDC* on Arc.`,
        `Explorer: ${addressUrl(address)}`,
        ``,
        `⚠️ Bot stores an encrypted key. Export & backup. Do not use for large funds without review.`,
      ].join('\n');
      try {
        await ctx.editMessageText(body, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: walletMenu(true, langOf(ctx)),
        });
      } catch {
        await ctx.reply(body, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: walletMenu(true, langOf(ctx)),
        });
      }
      return;
    }

    if (data === 'wallet:import') {
      ctx.session.expect = 'import_pk';
      await ctx.reply(
        'Send your *private key* (0x… or 64 hex). Message will be deleted when possible.',
        { parse_mode: 'Markdown', reply_markup: cancelOnly('menu:wallet', langOf(ctx)) },
      );
      return;
    }

    if (data === 'wallet:copy') {
      const w = getActiveWallet(id);
      if (!w) return;
      await ctx.reply(`\`${w.address}\``, { parse_mode: 'Markdown' });
      return;
    }

    if (data === 'wallet:export') {
      const w = getActiveWallet(id);
      if (!w) return;
      try {
        const pk = decryptPrivateKey(w.enc_pk);
        const msg = await ctx.reply(
          `⚠️ *Private key* for \`${short(w.address)}\`:\n\n\`${pk}\`\n\nDelete this message after saving.`,
          { parse_mode: 'Markdown' },
        );
        setTimeout(() => {
          ctx.api.deleteMessage(ctx.chat!.id, msg.message_id).catch(() => {});
        }, 60_000);
      } catch {
        await ctx.reply('Could not decrypt key — check WALLET_ENCRYPTION_KEY.');
      }
      return;
    }

    if (data.startsWith('buy:') && !data.startsWith('buy_custom:')) {
      const [, token, amount] = data.split(':');
      if (!token || !amount || !isAddress(token)) return;
      await previewBuy(ctx, getAddress(token), amount);
      return;
    }

    if (data.startsWith('buy_custom:')) {
      const token = data.split(':')[1];
      if (!token || !isAddress(token)) return;
      ctx.session.expect = 'buy_amount';
      ctx.session.pendingToken = getAddress(token);
      await ctx.reply('Send USDC amount (e.g. `12.5`):', {
        parse_mode: 'Markdown',
        reply_markup: cancelOnly(`back:buy:${getAddress(token)}`, langOf(ctx)),
      });
      return;
    }

    if (data.startsWith('confirm_buy:')) {
      const [, token, amount] = data.split(':');
      if (!token || !amount || !isAddress(token)) return;
      await executeBuy(ctx, getAddress(token), amount);
      return;
    }

    // Custom USD sell amount
    if (data.startsWith('sell_usd:')) {
      const token = data.slice('sell_usd:'.length);
      if (!token || !isAddress(token)) return;
      ctx.session.expect = 'sell_usd_amount';
      ctx.session.pendingToken = getAddress(token);
      await ctx.reply(
        'Send *USD amount* to sell (e.g. `10` or `25.50`).\n_Approx. USDC value of tokens to sell._',
        {
          parse_mode: 'Markdown',
          reply_markup: cancelOnly(`sell_pick:${getAddress(token)}`, langOf(ctx)),
        },
      );
      return;
    }

    // sell:token:pct  (not sell:paste / sell_pick / sell_usd)
    if (data.startsWith('sell:') && data !== 'sell:paste') {
      const parts = data.split(':');
      const token = parts[1];
      const pct = parts[2];
      if (!token || !pct || !isAddress(token)) return;
      const p = Number(pct);
      if (![25, 50, 100].includes(p)) return;
      await previewSell(ctx, getAddress(token), { kind: 'pct', pct: p });
      return;
    }

    if (data.startsWith('confirm_sell:')) {
      // confirm_sell:0x…:25  |  confirm_sell:0x…:u:12.50
      const parts = data.split(':');
      const token = parts[1];
      if (!token || !isAddress(token)) return;
      if (parts[2] === 'u') {
        const usdc = Number(parts[3]);
        if (!Number.isFinite(usdc) || usdc <= 0) return;
        await executeSell(ctx, getAddress(token), { kind: 'usd', usdc });
        return;
      }
      const p = Number(parts[2]);
      if (![25, 50, 100].includes(p)) return;
      await executeSell(ctx, getAddress(token), { kind: 'pct', pct: p });
      return;
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const id = ctx.from!.id;

    if (ctx.session.expect === 'bridge_amount') {
      ctx.session.expect = null;
      const amount = text.replace(/\$/g, '').trim();
      if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        await ctx.reply('Invalid amount. Try again or go Back.');
        return;
      }
      const dir = ctx.session.bridgeDir ?? 'in';
      await previewBridge(ctx, amount, dir);
      return;
    }

    if (ctx.session.expect === 'set_ref_code') {
      ctx.session.expect = null;
      const result = setRefCode(id, text);
      if (!result.ok) {
        ctx.session.expect = 'set_ref_code';
        await ctx.reply(`❌ ${result.error}\n\nTry another username:`, {
          reply_markup: cancelOnly('menu:referral', langOf(ctx)),
        });
        return;
      }
      const link = referralInviteLink(id);
      await ctx.reply(
        `Set to *${result.code}*\n\`${link}\``,
        {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: referralMenu(link, langOf(ctx)),
        },
      );
      return;
    }

    // import pk
    if (ctx.session.expect === 'import_pk') {
      ctx.session.expect = null;
      let pk = text;
      if (!pk.startsWith('0x')) pk = `0x${pk}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
        await ctx.reply('Invalid private key format.');
        return;
      }
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const account = privateKeyToAccount(pk as Hex);
        const enc = encryptPrivateKey(pk as Hex);
        const n = listWallets(id).length + 1;
        addWallet(id, `W${n}`, account.address, enc);
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(`✅ Imported \`${account.address}\``, {
          parse_mode: 'Markdown',
          reply_markup: walletMenu(true, langOf(ctx)),
        });
      } catch {
        await ctx.reply('Import failed.');
      }
      return;
    }

    if (ctx.session.expect === 'buy_amount' && ctx.session.pendingToken) {
      const amount = text.replace(/\$/g, '');
      if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        await ctx.reply('Invalid amount.');
        return;
      }
      const token = ctx.session.pendingToken as `0x${string}`;
      ctx.session.expect = null;
      ctx.session.pendingToken = undefined;
      await previewBuy(ctx, token, amount);
      return;
    }

    if (ctx.session.expect === 'sell_usd_amount' && ctx.session.pendingToken) {
      const amount = text.replace(/[$,]/g, '').trim();
      const usdc = Number(amount);
      if (!Number.isFinite(usdc) || usdc <= 0) {
        await ctx.reply('Invalid USD amount. Example: `10` or `25.50`', {
          parse_mode: 'Markdown',
        });
        return;
      }
      const token = ctx.session.pendingToken as `0x${string}`;
      ctx.session.expect = null;
      ctx.session.pendingToken = undefined;
      await previewSell(ctx, token, { kind: 'usd', usdc });
      return;
    }

    if (ctx.session.expect === 'send_token') {
      if (!isAddress(text)) {
        await ctx.reply('Send a valid `0x` token address.');
        return;
      }
      ctx.session.expect = null;
      await beginSendTo(ctx, getAddress(text));
      return;
    }

    if (ctx.session.expect === 'watch_token') {
      if (!isAddress(text)) {
        await ctx.reply('Send a valid `0x` token address.');
        return;
      }
      ctx.session.expect = null;
      const addr = getAddress(text);
      let symbol = 'TOKEN';
      try {
        symbol = (await getTokenMeta(addr)).symbol;
      } catch {
        /* */
      }
      addToWatchlist(id, addr, symbol);
      await ctx.reply(`⭐ Added *$${symbol}* to watchlist`, {
        parse_mode: 'Markdown',
        reply_markup: watchlistMenu(
          listWatchlist(id).map((w) => ({
            address: w.token_address,
            symbol: w.symbol,
          })),
          langOf(ctx),
        ),
      });
      return;
    }

    if (ctx.session.expect === 'send_to' && ctx.session.pendingToken) {
      if (!isAddress(text)) {
        await ctx.reply('Send a valid recipient `0x` address.', {
          parse_mode: 'Markdown',
        });
        return;
      }
      const to = getAddress(text);
      const token = ctx.session.pendingToken as `0x${string}`;
      let symbol = 'TOKEN';
      try {
        symbol = (await getTokenMeta(token)).symbol;
      } catch {
        /* */
      }
      ctx.session.sendDraft = {
        token,
        to,
        amountHuman: '',
        symbol,
      };
      ctx.session.expect = 'send_amount';
      await ctx.reply(
        [
          `*Send $${symbol}*`,
          `To: \`${to}\``,
          ``,
          `Send *amount* (e.g. \`10\` or \`0.5\`):`,
          `_Double-check the address — transfers cannot be reversed._`,
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: cancelOnly('menu:send', langOf(ctx)),
        },
      );
      return;
    }

    if (ctx.session.expect === 'send_amount' && ctx.session.sendDraft) {
      const amount = text.replace(/[$,]/g, '').trim();
      if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        await ctx.reply('Invalid amount. Example: `10` or `1.5`', {
          parse_mode: 'Markdown',
        });
        return;
      }
      ctx.session.sendDraft.amountHuman = amount;
      ctx.session.expect = null;
      const d = ctx.session.sendDraft;
      await ctx.reply(
        [
          `*Confirm withdraw*`,
          ``,
          `Token: *$${d.symbol}*`,
          `Amount: *${d.amountHuman}*`,
          `To: \`${d.to}\``,
          ``,
          `⚠️ *Irreversible.* Wrong address = lost funds.`,
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: confirmSend(langOf(ctx)),
        },
      );
      return;
    }

    // bare token address — buy by default, sell if expecting sell
    if (isAddress(text)) {
      const addr = getAddress(text);
      if (ctx.session.expect === 'sell_token') {
        ctx.session.expect = null;
        await openSell(ctx, addr);
        return;
      }
      ctx.session.expect = null;
      await openBuy(ctx, addr);
      return;
    }

    if (ctx.session.expect === 'buy_token' || ctx.session.expect === 'sell_token') {
      await ctx.reply('Send a valid `0x` token address.', { parse_mode: 'Markdown' });
    }
  });

  // Never let a single handler crash kill long-polling
  bot.catch((err) => {
    console.error('[bot] handler error (ignored — bot stays up):', err);
  });

  return bot;
}

async function showWallet(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  const wallets = listWallets(id);
  const active = getActiveWallet(id);
  let bal = '—';
  if (active) {
    try {
      bal = `$${Number((await getUsdcBalance(active.address as `0x${string}`)).formatted).toFixed(2)}`;
    } catch {
      bal = '—';
    }
  }
  const lines = [
    `*Wallets · Arc Mainnet (${env.chainId})*`,
    ``,
    active
      ? `Active: \`${active.address}\`\nUSDC: *${bal}*`
      : [
          `_No wallet yet_`,
          ``,
          `Tap *➕ Create new wallet* to generate one, or *Import* an existing key.`,
        ].join('\n'),
    ``,
    wallets.length
      ? wallets.map((w, i) => `${i + 1}. \`${short(w.address)}\` ${w.id === active?.id ? '✓' : ''}`).join('\n')
      : '',
  ].join('\n');

  const markup = walletMenu(wallets.length > 0, userLang(id));
  // Always send a fresh message so Create/Import buttons are visible
  // (editing "Quick actions" can fail silently on markup edge cases)
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines, {
        parse_mode: 'Markdown',
        reply_markup: markup,
      });
      return;
    } catch {
      /* fall through to reply */
    }
  }
  await ctx.reply(lines, { parse_mode: 'Markdown', reply_markup: markup });
}

function referralInviteLink(tgId: number): string {
  return `https://t.me/${env.botUsername()}?start=ref_${getInviteSlug(tgId)}`;
}

async function showPositions(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), { reply_markup: walletMenu(false, langOf(ctx)) });
    return;
  }

  const loading = edit
    ? null
    : await ctx.reply('⏳ Loading portfolio…', { parse_mode: 'Markdown' });

  try {
    const { holdings } = await fetchWalletHoldings(
      w.address as `0x${string}`,
      id,
    );
    // light: 1 quote per token, no Blockscout per row
    const positions = await enrichPositions(holdings, id, { limit: 8, light: true });
    const body = formatPortfolioMessage(w.address, positions, '');
    const markup = positionsMenu(
      positions
        .filter((p) => !p.isUsdc)
        .map((p) => ({
          address: p.address,
          symbol: p.symbol,
          label: `$${p.symbol.slice(0, 16)}`.slice(0, 64),
        })),
      langOf(ctx),
    );

    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(body, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: markup,
        });
        return;
      } catch {
        /* fall through */
      }
    }

    if (loading) {
      try {
        await ctx.api.editMessageText(loading.chat.id, loading.message_id, body, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: markup,
        });
        return;
      } catch {
        /* fall through */
      }
    }

    await ctx.reply(body, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      reply_markup: markup,
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : 'error';
    await ctx.reply(`Could not load positions: ${err}`, {
      reply_markup: positionsMenu(undefined, langOf(ctx)),
    });
  }
}

async function showPositionDetail(
  ctx: BotContext,
  token: `0x${string}`,
  edit = false,
): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), { reply_markup: walletMenu(false, langOf(ctx)) });
    return;
  }

  try {
    let raw = 0n;
    try {
      raw = await getTokenBalance(token, w.address as `0x${string}`);
    } catch {
      /* */
    }
    let symbol = 'TOKEN';
    let name = 'Token';
    let decimals = 18;
    try {
      const meta = await getTokenMeta(token);
      symbol = meta.symbol;
      name = meta.symbol;
      decimals = meta.decimals;
    } catch {
      /* */
    }
    const holding = {
      address: token,
      symbol,
      name,
      decimals,
      raw,
      formatted:
        raw > 0n
          ? (() => {
              const n = Number(formatUnits(raw, decimals));
              return Number.isFinite(n)
                ? n >= 1
                  ? n.toFixed(4)
                  : n.toPrecision(4)
                : formatUnits(raw, decimals);
            })()
          : '0',
    };
    const [enriched] = await enrichPositions([holding], id, { limit: 1 });
    const body = enriched
      ? formatTokenDetail(enriched)
      : `*$${symbol}*\n\`${token}\`\n\nNo data.`;
    const markup = positionDetailMenu(token, langOf(ctx));

    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(body, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: markup,
        });
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(body, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      reply_markup: markup,
    });
  } catch (e) {
    await ctx.reply(`Could not load token: ${e instanceof Error ? e.message : 'error'}`, {
      reply_markup: positionsMenu(undefined, langOf(ctx)),
    });
  }
}

async function showAdmin(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  if (!env.isAdmin(id)) {
    await ctx.reply('_Not authorized._', { parse_mode: 'Markdown' });
    return;
  }

  const s = getCreatorFeeStats();
  const feePct = (env.platformFeeBps() / 100).toFixed(2);
  const refShare = (env.referralShareBps() / 100).toFixed(0);
  const treasury = env.feeTreasury();
  const last =
    s.lastTradeAt != null
      ? new Date(s.lastTradeAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      : '—';

  const body = [
    `*👑 Creator stats* _(private)_`,
    ``,
    `Platform fee: *${feePct}%* · referrer cut of fee: *${refShare}%*`,
    `Treasury: \`${treasury}\``,
    ``,
    `*Fees (from bot trades)*`,
    `• Volume tracked: *$${s.volumeUsdc.toFixed(2)}*`,
    `• Fees total: *$${s.feeTotalUsdc.toFixed(4)}*`,
    `• → You (treasury): *$${s.feeTreasuryUsdc.toFixed(4)}*`,
    `• → Referrers: *$${s.feeReferralUsdc.toFixed(4)}*`,
    ``,
    `*Activity*`,
    `• Fee events: *${s.tradeCount}*`,
    `• Unique traders: *${s.uniqueTraders}*`,
    `• Users / wallets: *${s.usersCount}* / *${s.walletsCount}*`,
    `• Last fee event: _${last}_`,
    ``,
    `_USDC lands on-chain in the treasury wallet. Bridge fees are not in this table yet._`,
  ].join('\n');

  const markup = adminMenu(langOf(ctx));
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(body, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(body, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: markup,
  });
}

function buildReferralShareText(inviteLink: string): string {
  return `Trade on Arc with ArcTradeBot\n${inviteLink}`;
}

async function showReferral(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  const stats = getReferralStats(id);
  const link = referralInviteLink(id);
  const code = getRefCode(id);
  const ex = referralEarningsExample(100, env.platformFeeBps(), env.referralShareBps());

  const lines: string[] = [
    `*Referrals*`,
    ``,
    `\`${link}\``,
  ];
  if (code) lines.push(`@${code}`);
  lines.push(
    ``,
    `Invites *${stats.inviteCount}*  ·  Earned *$${stats.earnedUsdc.toFixed(2)}*`,
    `_You get ${ex.refSharePct}% of the ${ex.feePct}% fee when they trade._`,
  );

  const body = lines.join('\n');
  const markup = referralMenu(link, langOf(ctx), buildReferralShareText(link));
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(body, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(body, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: markup,
  });
}

async function showReferralHowItWorks(ctx: BotContext): Promise<void> {
  const ex = referralEarningsExample(100, env.platformFeeBps(), env.referralShareBps());
  const link = referralInviteLink(ctx.from!.id);
  await ctx.reply(
    [
      `*How it works*`,
      ``,
      `Share your link. When they trade, you get *${ex.refSharePct}%* of the *${ex.feePct}%* fee.`,
      `They pay the same as everyone else.`,
      ``,
      `\`${link}\``,
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: referralMenu(link, langOf(ctx), buildReferralShareText(link)),
    },
  );
}

async function showBridge(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), { reply_markup: walletMenu(false, langOf(ctx)) });
    return;
  }

  const addr = w.address as `0x${string}`;
  let baseUsdc = '—';
  let arcUsdc = '—';
  let gwBase = '—';
  let gwArc = '—';
  try {
    baseUsdc = `$${Number(formatUnits(await getBaseUsdcBalance(addr), 6)).toFixed(2)}`;
  } catch (e) {
    console.warn('[bridge] base usdc', e instanceof Error ? e.message : e);
    baseUsdc = '—';
  }
  try {
    arcUsdc = `$${Number(formatUnits(await getArcUsdcBalance(addr), 6)).toFixed(2)}`;
  } catch (e) {
    console.warn('[bridge] arc usdc', e instanceof Error ? e.message : e);
    arcUsdc = '—';
  }
  try {
    gwBase = `$${Number(formatUnits(await getGatewayBalance(addr, 6), 6)).toFixed(4)}`;
  } catch {
    gwBase = '—';
  }
  try {
    gwArc = `$${Number(formatUnits(await getGatewayBalance(addr, 26), 6)).toFixed(4)}`;
  } catch {
    gwArc = '—';
  }

  const feePct = (env.bridgeFeeBps() / 100).toFixed(2);
  const feeExempt = env.isFeeExempt(w.address);
  let relayerLine = '⛽ Gas sponsor: …';
  try {
    relayerLine = formatRelayerStatusLine(await getBridgeRelayerStatus());
  } catch {
    /* */
  }
  const body = [
    `*🌉 Bridge*`,
    `\`${w.address}\``,
    ``,
    `*Balances*`,
    `Base USDC   ${baseUsdc}`,
    `Arc USDC    ${arcUsdc}`,
    `Gateway(Base) ${gwBase}`,
    `Gateway(Arc)  ${gwArc}`,
    ``,
    `*⬇️ In*  Base → Arc`,
    `*⬆️ Out* Arc → Base`,
    ``,
    relayerLine,
    feeExempt
      ? `Fee: *waived*`
      : `Fee: *${feePct}%* on source chain`,
    ``,
    `*Bridge In needs:* Base USDC + a little *ETH on Base* for deposit.`,
    `_Mint on Arc is gas-sponsored when the sponsor is funded._`,
  ].join('\n');

  const markup = bridgeMenu(langOf(ctx));
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(body, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(body, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: markup,
  });
}

async function previewBridge(
  ctx: BotContext,
  amount: string,
  dir: BridgeDirection,
): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), { reply_markup: walletMenu(false, langOf(ctx)) });
    return;
  }
  const feeExempt = env.isFeeExempt(w.address);
  const waitNote =
    dir === 'in'
      ? `_~15 min for Circle after Base deposit. Arc mint gas is sponsored — no Arc balance needed._`
      : `_Arc deposit is usually fast. Base mint uses your ETH or platform sponsor._`;

  await ctx.reply(
    [
      `*Confirm bridge*`,
      formatBridgeQuote(amount, feeExempt, dir),
      ``,
      waitNote,
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: confirmBridge(dir, amount, langOf(ctx)),
    },
  );
}

async function executeBridge(
  ctx: BotContext,
  amount: string,
  dir: BridgeDirection,
): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply('No wallet.');
    return;
  }

  const status = await ctx.reply(
    `⏳ Starting ${directionLabel(dir)}…`,
    { parse_mode: 'Markdown' },
  );

  const update = async (msg: string) => {
    try {
      await ctx.api.editMessageText(status.chat.id, status.message_id, msg, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    } catch {
      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    }
  };

  try {
    const pk = decryptPrivateKey(w.enc_pk);
    const result = await bridgeUsdc({
      privateKey: pk,
      usdcAmount: amount,
      direction: dir,
      onProgress: update,
    });
    const dest = dir === 'in' ? 'Arc' : 'Base';
    await ctx.reply(
      [
        `✅ *Bridge complete* (${directionLabel(dir)})`,
        `Received ≈ *$${result.netUsdc}* USDC on ${dest}`,
        result.feeUsdc !== '0' ? `Fee: *$${result.feeUsdc}*` : `Fee: waived`,
        ``,
        `[Deposit](${result.depositScan})`,
        `[Mint](${result.mintScan})`,
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: mainMenu(true, langOf(ctx)),
      },
    );
  } catch (e) {
    await ctx.reply(
      `❌ Bridge failed: ${e instanceof Error ? e.message : 'error'}`,
      {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: bridgeMenu(langOf(ctx)),
      },
    );
  }
}

async function runBridgeClaim(
  ctx: BotContext,
  dir: BridgeDirection,
): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply('No wallet.');
    return;
  }
  const dest = dir === 'in' ? 'Arc' : 'Base';
  const status = await ctx.reply(`⏳ Checking Gateway (${dest})…`);
  try {
    const pk = decryptPrivateKey(w.enc_pk);
    const result = await claimGateway({
      privateKey: pk,
      direction: dir,
      onProgress: async (msg) => {
        try {
          await ctx.api.editMessageText(status.chat.id, status.message_id, msg, {
            parse_mode: 'Markdown',
          });
        } catch {
          /* */
        }
      },
    });
    if (!result) {
      await ctx.reply(`No claimable Gateway balance for *${dest}*.`, {
        parse_mode: 'Markdown',
        reply_markup: bridgeMenu(langOf(ctx)),
      });
      return;
    }
    await ctx.reply(
      `✅ Claimed *$${result.amount}* USDC on ${dest}\n[Tx](${result.scan})`,
      {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: mainMenu(true, langOf(ctx)),
      },
    );
  } catch (e) {
    await ctx.reply(`❌ Claim failed: ${e instanceof Error ? e.message : 'error'}`, {
      reply_markup: bridgeMenu(langOf(ctx)),
    });
  }
}

async function showSellPicker(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), { reply_markup: walletMenu(false, langOf(ctx)) });
    return;
  }

  const loading = edit
    ? null
    : await ctx.reply('⏳ Loading…', { parse_mode: 'Markdown' });

  try {
    // FAST: holdings only — no per-token quotes on the list
    const { holdings } = await fetchWalletHoldings(
      w.address as `0x${string}`,
      id,
    );
    const usdc = env.usdc().toLowerCase();
    const sellable = holdings
      .filter((h) => h.address.toLowerCase() !== usdc)
      .slice(0, 24);

    const bodyLines = [
      `*📉 Sell · Arc Mainnet*`,
      `Wallet: \`${short(w.address)}\``,
      ``,
      sellable.length
        ? `Tap a token to sell:`
        : `_No sellable tokens found_ (USDC-only or empty wallet).\nFund / buy tokens, or paste an address.`,
      ``,
    ];
    for (const t of sellable) {
      bodyLines.push(`• ${tokenNameLink(t.symbol, t.address)} \`${t.formatted}\``);
    }
    const body = bodyLines.join('\n');

    const markup = sellTokenPicker(
      sellable.map((h) => ({
        address: h.address,
        symbol: h.symbol,
        formatted: h.formatted,
      })),
      langOf(ctx),
    );

    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(body, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: markup,
        });
        return;
      } catch {
        /* fall through */
      }
    }
    if (loading) {
      try {
        await ctx.api.editMessageText(loading.chat.id, loading.message_id, body, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: markup,
        });
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(body, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      reply_markup: markup,
    });
  } catch (e) {
    await ctx.reply(
      `Could not load holdings: ${e instanceof Error ? e.message : 'error'}`,
      { reply_markup: cancelOnly('menu:back', langOf(ctx)) },
    );
  }
}

async function openSell(ctx: BotContext, token: `0x${string}`): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), { reply_markup: walletMenu(false, langOf(ctx)) });
    return;
  }
  if (token.toLowerCase() === env.usdc().toLowerCase()) {
    await ctx.reply('USDC is the quote asset — pick a token to sell for USDC.', {
      reply_markup: cancelOnly('menu:sell', langOf(ctx)),
    });
    return;
  }

  let symbol = 'TOKEN';
  let decimals = 18;
  try {
    const meta = await getTokenMeta(token);
    symbol = meta.symbol;
    decimals = meta.decimals;
  } catch {
    /* */
  }

  let bal = 0n;
  try {
    bal = await getTokenBalance(token, w.address as `0x${string}`);
  } catch {
    /* */
  }
  if (bal <= 0n) {
    await ctx.reply(`No *$${symbol}* balance in this wallet.`, {
      parse_mode: 'Markdown',
      reply_markup: cancelOnly('menu:sell', langOf(ctx)),
    });
    return;
  }

  const balHuman = formatUnits(bal, decimals);
  const balShow = Number(balHuman);
  const balStr = Number.isFinite(balShow)
    ? balShow >= 1
      ? balShow.toFixed(4)
      : balShow.toPrecision(4)
    : balHuman;

  let quoteLine = '_Pick a % to quote_';
  let markUsdc = 0;
  let hasPool = false;
  try {
    const q = await quoteTokenToUsdc(token, bal);
    if (q) {
      hasPool = true;
      quoteLine = formatSellQuoteHuman(q, symbol, decimals) + ' (100%)';
      markUsdc = Number(formatUsdc(q.amountOut));
    } else {
      quoteLine = '_No USDC path — you can still Send / withdraw this token_';
    }
  } catch {
    quoteLine = '_Quote failed — try again_';
  }

  if (!hasPool) {
    await ctx.reply(
      [
        `*Sell $${symbol}*`,
        `\`${token}\``,
        ``,
        `Balance: *${balStr}*`,
        ``,
        `No liquid path to USDC on Arc (direct or multi-hop).`,
        `You can still *withdraw* the tokens with Send.`,
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: noPoolSellMenu(token, langOf(ctx)),
        link_preview_options: { is_disabled: true },
      },
    );
    return;
  }

  const pnl = getPositionPnl(id, token, bal, markUsdc);
  const feeExempt = env.isFeeExempt(w.address);
  const feePct = (env.platformFeeBps() / 100).toFixed(2);
  await ctx.reply(
    [
      `*Sell $${symbol}*`,
      `\`${token}\``,
      ``,
      `Balance: *${balStr}*`,
      quoteLine,
      ``,
      ...formatPnlLines(pnl),
      ``,
      `Slippage: ${(getSlippage(id) / 100).toFixed(1)}%`,
      feeExempt
        ? `Bot fee: *waived*`
        : `Bot fee: *${feePct}%* of USDC proceeds`,
      ``,
      `Choose how much to sell (% or custom $):`,
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: sellPresets(token, langOf(ctx)),
      link_preview_options: { is_disabled: true },
    },
  );
}

/**
 * Resolve token amount to sell: % of bag, or ~target USDC (pre-fee quote).
 */
async function resolveSellAmountIn(
  token: `0x${string}`,
  owner: `0x${string}`,
  size: SellSize,
): Promise<{ amountIn: bigint; bal: bigint; approxPct: number }> {
  const bal = await getTokenBalance(token, owner);
  if (bal <= 0n) throw new Error('Balance is zero');

  if (size.kind === 'pct') {
    const amountIn = (bal * BigInt(size.pct)) / 100n;
    if (amountIn <= 0n) throw new Error('Amount too small');
    return { amountIn, bal, approxPct: size.pct };
  }

  const targetRaw = parseUnitsSafe(String(size.usdc));
  if (targetRaw <= 0n) throw new Error('Invalid USD amount');

  const fullQ = await quoteTokenToUsdc(token, bal);
  if (!fullQ || fullQ.amountOut <= 0n) {
    throw new Error(
      'NO_POOL: No path to USDC. Use Send to withdraw tokens instead.',
    );
  }

  // Sell whole bag if target ≥ full mark
  if (targetRaw >= fullQ.amountOut) {
    return { amountIn: bal, bal, approxPct: 100 };
  }

  // Pro-rate bag by USDC quote: amountIn = bal * target / fullOut
  let amountIn = (bal * targetRaw) / fullQ.amountOut;
  if (amountIn <= 0n) throw new Error('Amount too small');
  if (amountIn > bal) amountIn = bal;
  const approxPct = Math.min(
    100,
    Math.max(1, Number((amountIn * 10_000n) / bal) / 100),
  );
  return { amountIn, bal, approxPct };
}

async function previewSell(
  ctx: BotContext,
  token: `0x${string}`,
  size: SellSize,
): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply('No wallet.');
    return;
  }

  let symbol = 'TOKEN';
  let decimals = 18;
  try {
    const meta = await getTokenMeta(token);
    symbol = meta.symbol;
    decimals = meta.decimals;
  } catch {
    /* */
  }

  try {
    const { amountIn, bal, approxPct } = await resolveSellAmountIn(
      token,
      w.address as `0x${string}`,
      size,
    );

    const q = await quoteTokenToUsdc(token, amountIn);
    if (!q) {
      await ctx.reply(
        [
          `*Can't swap $${symbol} → USDC*`,
          ``,
          `No liquid path found (direct or multi-hop).`,
          ``,
          `You can still *Send* these tokens out of the bot wallet to any address.`,
          `_A DEX pool is required to convert to USDC — we can't invent liquidity._`,
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: noPoolSellMenu(token, langOf(ctx)),
        },
      );
      return;
    }
    const refId = getReferrerTgId(id);
    const refWallet = refId ? getActiveWallet(refId) : null;
    const feeExempt = env.isFeeExempt(w.address);
    const fee = computePlatformFee(
      q.amountOut,
      Boolean(refWallet?.address) && !feeExempt,
      feeExempt,
    );
    const tokAmt = formatUnits(amountIn, decimals);
    const markSlice = Number(formatUsdc(q.amountOut));
    const frac = Math.min(1, Math.max(0, approxPct / 100));
    const fullMark = frac > 0 ? markSlice / frac : markSlice;
    const fullPnl = getPositionPnl(id, token, bal, fullMark);
    const sliceCost = fullPnl.hasBasis ? fullPnl.costUsdc * frac : 0;
    const slicePnl = fullPnl.hasBasis ? markSlice - sliceCost : null;

    const sizeLine =
      size.kind === 'pct'
        ? `Sell: *${size.pct}%* ≈ \`${Number(tokAmt).toPrecision(6)}\``
        : `Sell: *$${size.usdc.toFixed(2)}* USDC worth ≈ \`${Number(tokAmt).toPrecision(6)}\` (~${approxPct.toFixed(1)}%)`;

    const pnlLines =
      slicePnl == null
        ? ['_PnL n/a for this slice (no buy cost basis)_']
        : [
            `Est. PnL on this sell ≈ *${slicePnl >= 0 ? '+' : ''}$${slicePnl.toFixed(2)}*`,
          ];

    const confirmKb = confirmSell(
      token,
      size.kind === 'pct'
        ? { kind: 'pct', value: String(size.pct) }
        : { kind: 'usd', value: size.usdc.toFixed(2) },
      langOf(ctx),
    );

    await ctx.reply(
      [
        `*Confirm sell*`,
        `Token: *$${symbol}*`,
        sizeLine,
        formatSellQuoteHuman(q, symbol, decimals),
        `Slippage: ${(getSlippage(id) / 100).toFixed(1)}%`,
        ``,
        ...pnlLines,
        formatPlatformFeeLine(fee, 'sell'),
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: confirmKb,
      },
    );
  } catch (e) {
    await ctx.reply('Quote failed. Try again.');
  }
}

async function executeSell(
  ctx: BotContext,
  token: `0x${string}`,
  size: SellSize,
): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply('No wallet.');
    return;
  }

  await ctx.reply('⏳ Submitting sell on *Arc Mainnet*…', { parse_mode: 'Markdown' });

  try {
    const { amountIn, bal, approxPct } = await resolveSellAmountIn(
      token,
      w.address as `0x${string}`,
      size,
    );
    if (amountIn <= 0n) throw new Error('Nothing to sell');

    const pk = decryptPrivateKey(w.enc_pk);
    const slip = getSlippage(id);
    const refId = getReferrerTgId(id);
    const refWallet = refId ? getActiveWallet(refId) : null;
    const referrerAddress = refWallet?.address
      ? (refWallet.address as `0x${string}`)
      : null;

    const { hash, quote, fee, usdcNet } = await sellTokenForUsdc({
      privateKey: pk,
      token,
      amountIn,
      slippageBps: slip,
      referrerAddress,
      traderAddress: w.address as `0x${string}`,
    });

    recordFeeEvent({
      tgId: id,
      referrerTgId: referrerAddress && refId ? refId : null,
      tradeUsdc: formatUsdc(quote.amountOut),
      feeTotal: formatUsdc(fee.feeTotal),
      feeTreasury: formatUsdc(fee.feeTreasury),
      feeReferral: formatUsdc(fee.feeReferral),
      swapTx: hash,
    });

    let symbol = 'TOKEN';
    let decimals = 18;
    try {
      const meta = await getTokenMeta(token);
      symbol = meta.symbol;
      decimals = meta.decimals;
    } catch {
      /* */
    }
    rememberToken(id, token, symbol, decimals);
    const realized = recordSellCost(
      id,
      token,
      amountIn,
      Number(formatUsdc(usdcNet)),
    );
    const tokenAmountHuman = formatUnits(amountIn, decimals);
    const proceedsN = Number(formatUsdc(usdcNet));
    recordTrade({
      tgId: id,
      side: 'sell',
      tokenAddress: token,
      tokenSymbol: symbol,
      tokenAmount: tokenAmountHuman,
      usdcAmount: formatUsdc(usdcNet),
      feeUsdc: formatUsdc(fee.feeTotal),
      realizedUsdc: Number.isFinite(realized) ? realized : null,
      txHash: hash,
    });

    const sizeNote =
      size.kind === 'pct'
        ? `${size.pct}%`
        : `~$${size.usdc.toFixed(2)}`;

    const caption = [
      `✅ *Sell sent* · *$${symbol}* (${sizeNote})`,
      formatSellQuoteHuman(quote, symbol, decimals),
      formatPlatformFeeLine(fee, 'sell'),
      `Net ≈ *$${proceedsN.toFixed(4)}* USDC`,
      Number.isFinite(realized)
        ? `Realized PnL ≈ *${realized >= 0 ? '+' : ''}$${realized.toFixed(2)}*`
        : '',
      ``,
      `[View swap](${txUrl(hash)})`,
    ]
      .filter(Boolean)
      .join('\n');

    // Share-style PnL card image (exact numbers)
    try {
      const png = await renderSellPnlCard({
        symbol,
        pct: Math.round(approxPct),
        realizedUsdc: Number.isFinite(realized) ? realized : null,
        proceedsUsdc: proceedsN,
        tokenAmount: tokenAmountHuman,
        walletShort: short(w.address),
        txShort: `${hash.slice(0, 8)}…`,
      });
      await ctx.replyWithPhoto(new InputFile(png, `pnl-${symbol}.png`), {
        caption,
        parse_mode: 'Markdown',
        reply_markup: mainMenu(true, langOf(ctx)),
      });
    } catch (imgErr) {
      console.warn('[pnl-card]', imgErr instanceof Error ? imgErr.message : imgErr);
      await ctx.reply(caption, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: mainMenu(true, langOf(ctx)),
      });
    }
  } catch (e) {
    await ctx.reply(
      `❌ Sell failed: ${e instanceof Error ? e.message : 'error'}\n\nCheck token balance + native gas on Arc Mainnet.`,
      { reply_markup: mainMenu(true, langOf(ctx)) },
    );
  }
}

async function openBuy(ctx: BotContext, token: `0x${string}`): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), {
      reply_markup: walletMenu(false, langOf(ctx)),
    });
    return;
  }

  const feeExempt = env.isFeeExempt(w.address);
  const feePct = (env.platformFeeBps() / 100).toFixed(2);
  const feeLine = feeExempt
    ? `Bot fee: *waived*`
    : `Bot fee: *${feePct}%*${getReferrerTgId(id) ? ' (includes referral share)' : ''}`;

  try {
    // No extra "loading" Telegram round-trip — one reply when ready
    const card = await buildTokenCard({
      token,
      owner: w.address as `0x${string}`,
      tgId: id,
      feeExempt,
      sampleUsdc: env.buyPresets()[0] || '10',
      slippageBps: getSlippage(id),
      feeLine,
    });
    rememberToken(id, token, card.symbol, card.decimals);

    const text = [
      card.text,
      ``,
      `Network: *Arc Mainnet* · \`${env.chainId}\``,
    ].join('\n');
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      reply_markup: buyPresets(token, langOf(ctx), {
        hasBalance: card.hasBalance,
        watching: isOnWatchlist(id, token),
      }),
    });
  } catch (e) {
    await ctx.reply(
      `Could not load token: ${e instanceof Error ? e.message : 'error'}\n\`${token}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: buyPresets(token, langOf(ctx), {
          watching: isOnWatchlist(id, token),
        }),
        link_preview_options: { is_disabled: true },
      },
    );
  }
}

async function showWatchlist(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  const items = listWatchlist(id);
  const lines = [
    `*⭐ Watchlist*`,
    ``,
    items.length
      ? items
          .map((w, i) => `${i + 1}. ${tokenNameLink(w.symbol, w.token_address)}`)
          .join('\n')
      : `_Empty — paste a token or tap ☆ Watch on a token card._`,
    ``,
    `_Tap a name or button to open the token card._`,
  ].join('\n');
  const markup = watchlistMenu(
    items.map((w) => ({ address: w.token_address, symbol: w.symbol })),
    langOf(ctx),
  );
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(lines, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: markup,
  });
}

async function showSend(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), {
      reply_markup: walletMenu(false, langOf(ctx)),
    });
    return;
  }
  ctx.session.expect = null;
  ctx.session.sendDraft = undefined;

  let tokens: { address: string; symbol: string; formatted: string }[] = [];
  try {
    const { holdings } = await fetchWalletHoldings(w.address as `0x${string}`, id);
    tokens = holdings
      .filter((h) => h.address.toLowerCase() !== env.usdc().toLowerCase())
      .slice(0, 12)
      .map((h) => ({
        address: h.address,
        symbol: h.symbol,
        formatted: h.formatted,
      }));
  } catch {
    /* empty list is fine */
  }

  let usdcLine = '—';
  try {
    usdcLine = `$${(await getUsdcBalance(w.address as `0x${string}`)).formatted}`;
  } catch {
    /* */
  }

  const body = [
    `*📤 Send / withdraw*`,
    `\`${w.address}\``,
    ``,
    `USDC: *${usdcLine}*`,
    ``,
    `Pick an asset to send on *Arc Mainnet*.`,
    `_You need a little native Arc gas to submit the transfer._`,
  ].join('\n');
  const markup = sendAssetMenu(tokens, langOf(ctx));

  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(body, {
        parse_mode: 'Markdown',
        reply_markup: markup,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(body, { parse_mode: 'Markdown', reply_markup: markup });
}

async function beginSendTo(ctx: BotContext, token: `0x${string}`): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply(t(langOf(ctx), 'create_wallet_first'), {
      reply_markup: walletMenu(false, langOf(ctx)),
    });
    return;
  }
  let symbol = 'TOKEN';
  let balStr = '?';
  try {
    const meta = await getTokenMeta(token);
    symbol = meta.symbol;
    const raw = await getTokenBalance(token, w.address as `0x${string}`);
    balStr = formatUnits(raw, meta.decimals);
  } catch {
    /* */
  }
  ctx.session.pendingToken = token;
  ctx.session.sendDraft = undefined;
  ctx.session.expect = 'send_to';
  await ctx.reply(
    [
      `*Send $${symbol}*`,
      `Balance: \`${balStr}\``,
      `\`${token}\``,
      ``,
      `Send the *recipient wallet address* (\`0x…\`):`,
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: cancelOnly('menu:send', langOf(ctx)),
    },
  );
}

async function executeSend(ctx: BotContext): Promise<void> {
  const id = ctx.from!.id;
  const draft = ctx.session.sendDraft;
  const w = getActiveWallet(id);
  if (!w || !draft?.token || !draft.to || !draft.amountHuman) {
    await ctx.reply('Nothing to send — start again with Send.', {
      reply_markup: mainMenu(!!w, langOf(ctx)),
    });
    return;
  }

  await ctx.reply('⏳ Sending on *Arc Mainnet*…', { parse_mode: 'Markdown' });
  try {
    const pk = decryptPrivateKey(w.enc_pk);
    const { hash, symbol } = await transferToken({
      privateKey: pk,
      token: draft.token,
      to: draft.to,
      amountHuman: draft.amountHuman,
    });
    ctx.session.sendDraft = undefined;
    ctx.session.pendingToken = undefined;
    await ctx.reply(
      [
        `✅ *Sent*`,
        `*${draft.amountHuman}* $${symbol}`,
        `To: \`${draft.to}\``,
        ``,
        `[View tx](${transferTxUrl(hash)})`,
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: mainMenu(true, langOf(ctx)),
      },
    );
  } catch (e) {
    await ctx.reply(
      `❌ Send failed: ${e instanceof Error ? e.message : 'error'}`,
      { reply_markup: mainMenu(true, langOf(ctx)) },
    );
  }
}

async function showHistory(ctx: BotContext, edit = false): Promise<void> {
  const id = ctx.from!.id;
  const lang = langOf(ctx);
  const trades = listTrades(id, 20);
  const lines: string[] = [t(lang, 'history_title'), ``];

  if (trades.length === 0) {
    lines.push(t(lang, 'history_empty'));
  } else {
    for (const tr of trades) {
      const when = new Date(tr.created_at * 1000);
      const day = when.toISOString().slice(0, 10);
      const side = tr.side === 'buy' ? '🟢 BUY' : '🔴 SELL';
      const usdc = Number(tr.usdc_amount);
      const usdcStr = Number.isFinite(usdc) ? `$${usdc.toFixed(2)}` : `$${tr.usdc_amount}`;
      const name = tokenNameLink(tr.token_symbol, tr.token_address);
      let row = `${side} ${name} · ${usdcStr}`;
      if (tr.side === 'sell' && tr.realized_usdc != null) {
        const r = Number(tr.realized_usdc);
        if (Number.isFinite(r)) {
          row += ` · PnL ${r >= 0 ? '+' : ''}$${r.toFixed(2)}`;
        }
      }
      row += `\n_${day}_ · \`${tr.token_amount.slice(0, 14)}\``;
      if (tr.tx_hash) {
        row += ` · [tx](${txUrl(tr.tx_hash)})`;
      }
      lines.push(row);
      lines.push(``);
    }
  }

  const body = lines.join('\n').trimEnd();
  const markup = historyMenu(lang);
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(body, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(body, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: markup,
  });
}

async function previewBuy(
  ctx: BotContext,
  token: `0x${string}`,
  amount: string,
): Promise<void> {
  const id = ctx.from!.id;
  let symbol = 'TOKEN';
  let decimals = 18;
  try {
    const meta = await getTokenMeta(token);
    symbol = meta.symbol;
    decimals = meta.decimals;
  } catch {
    /* */
  }

  try {
    const w = getActiveWallet(id);
    const feeExempt = w ? env.isFeeExempt(w.address) : false;
    const refId = getReferrerTgId(id);
    const refWallet = refId ? getActiveWallet(refId) : null;
    const gross = parseUnitsSafe(amount);
    const fee = computePlatformFee(
      gross,
      Boolean(refWallet?.address) && !feeExempt,
      feeExempt,
    );
    const q = await quoteUsdcToToken(token, amount, true, feeExempt);
    if (!q) {
      await ctx.reply(
        [
          `*Can't buy $${symbol} with USDC*`,
          ``,
          `No liquid USDC path (direct pool or multi-hop) on Arc V3.`,
          ``,
          `• Check the contract is on *Arc Mainnet*`,
          `• Token may need a USDC (or intermediate) pool on RadarDEX`,
          `• Try a smaller size or another token`,
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: noPoolBuyMenu(langOf(ctx)),
        },
      );
      return;
    }
    await ctx.reply(
      [
        `*Confirm buy*`,
        `Token: *$${symbol}*`,
        formatQuoteHuman(q, symbol, decimals),
        `Slippage: ${(getSlippage(id) / 100).toFixed(1)}%`,
        ``,
        `You pay *$${amount} USDC* total`,
        formatPlatformFeeLine(fee, 'buy'),
        ``,
        `→ receive ≈ *${symbol}*`,
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: confirmBuy(token, amount, langOf(ctx)),
      },
    );
  } catch (e) {
    await ctx.reply('Quote failed. Try again.');
  }
}

async function executeBuy(
  ctx: BotContext,
  token: `0x${string}`,
  amount: string,
): Promise<void> {
  const id = ctx.from!.id;
  const w = getActiveWallet(id);
  if (!w) {
    await ctx.reply('No wallet.');
    return;
  }

  await ctx.reply('⏳ Submitting on *Arc Mainnet*…', { parse_mode: 'Markdown' });

  try {
    const pk = decryptPrivateKey(w.enc_pk);
    const slip = getSlippage(id);
    const refId = getReferrerTgId(id);
    const refWallet = refId ? getActiveWallet(refId) : null;
    const referrerAddress = refWallet?.address
      ? (refWallet.address as `0x${string}`)
      : null;

    const { hash, quote, fee } = await buyTokenWithUsdc({
      privateKey: pk,
      token,
      usdcAmount: amount,
      slippageBps: slip,
      referrerAddress,
      traderAddress: w.address as `0x${string}`,
    });

    recordFeeEvent({
      tgId: id,
      referrerTgId: referrerAddress && refId ? refId : null,
      tradeUsdc: amount,
      feeTotal: formatUsdc(fee.feeTotal),
      feeTreasury: formatUsdc(fee.feeTreasury),
      feeReferral: formatUsdc(fee.feeReferral),
      swapTx: hash,
    });

    let symbol = 'TOKEN';
    let decimals = 18;
    try {
      const meta = await getTokenMeta(token);
      symbol = meta.symbol;
      decimals = meta.decimals;
    } catch {
      /* */
    }
    rememberToken(id, token, symbol, decimals);
    // Cost basis = USDC that actually swapped (after platform fee)
    recordBuyCost(id, token, quote.amountOut, Number(formatUsdc(fee.swapIn)));
    recordTrade({
      tgId: id,
      side: 'buy',
      tokenAddress: token,
      tokenSymbol: symbol,
      tokenAmount: formatUnits(quote.amountOut, decimals),
      usdcAmount: amount,
      feeUsdc: formatUsdc(fee.feeTotal),
      txHash: hash,
    });
    await ctx.reply(
      [
        `✅ *Buy sent*`,
        formatQuoteHuman(quote, symbol, decimals),
        formatPlatformFeeLine(fee),
        ``,
        `[View swap](${txUrl(hash)})`,
      ].join('\n'),
      {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: mainMenu(true, langOf(ctx)),
      },
    );
  } catch (e) {
    await ctx.reply(
      `❌ Trade failed: ${e instanceof Error ? e.message : 'error'}\n\nCheck USDC balance + native gas on Arc Mainnet.`,
      { reply_markup: mainMenu(true, langOf(ctx)) },
    );
  }
}

