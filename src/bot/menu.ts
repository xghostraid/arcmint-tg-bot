import type { Bot } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { BotContext } from './handlers.js';

/**
 * Left-side Telegram Menu button (hamburger / Menu) — BasedBot-style.
 * Type `commands` opens this list when the user taps the blue menu control
 * next to the message field.
 */
export const BOT_COMMANDS: BotCommand[] = [
  { command: 'start', description: 'Home — start trading' },
  { command: 'home', description: 'Home & portfolio balance' },
  { command: 'buy', description: 'Buy a token with USDC' },
  { command: 'sell', description: 'Sell token holdings' },
  { command: 'positions', description: 'Open positions' },
  { command: 'bridge', description: 'Bridge USDC Base ↔ Arc' },
  { command: 'wallet', description: 'Wallets — create / import / export' },
  { command: 'send', description: 'Send / withdraw tokens' },
  { command: 'watchlist', description: 'Watchlist — pinned tokens' },
  { command: 'referral', description: 'Invite link & rewards' },
  { command: 'history', description: 'Trade history' },
  { command: 'settings', description: 'Slippage & language' },
  { command: 'help', description: 'Help & how to use' },
];

/** Register commands + enable the left Menu button for every private chat. */
export async function setupBotMenu(bot: Bot<BotContext>): Promise<void> {
  // Default scope (all private chats) — required for the left Menu control
  await bot.api.setMyCommands(BOT_COMMANDS);
  await bot.api.setMyCommands(BOT_COMMANDS, {
    scope: { type: 'all_private_chats' },
  });

  // Global menu button → command list (left of the message field)
  await bot.api.setChatMenuButton({
    menu_button: { type: 'commands' },
  });

  // Verify so empty menus never go unnoticed
  const cmds = await bot.api.getMyCommands();
  const btn = await bot.api.getChatMenuButton();
  console.log(
    `[bot] menu button type=${btn.type} commands=${cmds.length}: ${cmds.map((c) => '/' + c.command).join(', ')}`,
  );
  if (cmds.length === 0) {
    console.error('[bot] FATAL: getMyCommands is empty after setMyCommands');
  }
}
