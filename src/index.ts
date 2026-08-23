/**
 * Always-on ArcTrade bot — explicit getUpdates loop (more reliable than bot.start alone).
 */
import { env } from './config/env.js';
import { publicClient, arcMainnet } from './chain/client.js';
import { createBot } from './bot/handlers.js';
import type { Update } from 'grammy/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection (alive):', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException (alive):', err);
  });
  const shutdown = (sig: string) => {
    console.log(`[bot] ${sig} — exit`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function probeArcRpcQuick(): Promise<void> {
  try {
    const client = publicClient();
    const chainId = await withTimeout(client.getChainId(), 8_000, 'getChainId');
    const block = await withTimeout(client.getBlockNumber(), 8_000, 'getBlockNumber');
    console.log(`[arc] ok chainId=${chainId} block=${block} name=${arcMainnet.name}`);
  } catch (e) {
    console.warn(
      '[arc] RPC probe failed (bot still starts):',
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Explicit long-poll. Confirms every update (offset) so pending_update_count stays 0.
 */
async function runPollingLoop(bot: ReturnType<typeof createBot>): Promise<void> {
  let offset = 0;
  let emptyRounds = 0;
  let lastProgressAt = Date.now();

  console.log('[bot] explicit getUpdates loop starting…');

  // Drain backlog first (short timeout)
  try {
    const backlog = await bot.api.getUpdates({ offset: 0, limit: 100, timeout: 0 });
    if (backlog.length) {
      console.log(`[bot] draining ${backlog.length} pending update(s)`);
      for (const u of backlog) {
        try {
          await bot.handleUpdate(u as Update);
        } catch (e) {
          console.error('[bot] handleUpdate error:', e);
        }
        offset = u.update_id + 1;
      }
    }
  } catch (e) {
    console.warn('[bot] backlog drain:', e instanceof Error ? e.message : e);
  }

  for (;;) {
    try {
      const updates = await withTimeout(
        bot.api.getUpdates({
          offset,
          limit: 50,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        }),
        45_000,
        'getUpdates',
      );

      lastProgressAt = Date.now();
      if (updates.length === 0) {
        emptyRounds += 1;
        if (emptyRounds % 20 === 0) {
          console.log(`[bot] poll ok (idle) offset=${offset}`);
        }
        continue;
      }
      emptyRounds = 0;
      console.log(`[bot] got ${updates.length} update(s)`);

      for (const u of updates) {
        try {
          await bot.handleUpdate(u as Update);
        } catch (e) {
          console.error('[bot] handleUpdate error:', e);
        }
        offset = Math.max(offset, u.update_id + 1);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[bot] getUpdates error:', msg);

      // 409 = another getUpdates conflict — wait and retry
      if (msg.includes('409') || msg.toLowerCase().includes('conflict')) {
        console.warn('[bot] 409 conflict — waiting 3s');
        await sleep(3000);
        continue;
      }

      // Hard stuck: no successful poll for 3 minutes
      if (Date.now() - lastProgressAt > 3 * 60 * 1000) {
        console.error('[bot] no successful poll for 3m — process.exit(1)');
        process.exit(1);
      }
      await sleep(2000);
    }
  }
}

async function runBotOnce(): Promise<void> {
  if (env.chainId === 5042002) {
    throw new Error('MAINNET ONLY: do not use testnet chain id 5042002');
  }

  await probeArcRpcQuick();

  const bot = createBot(env.telegramToken());

  try {
    await withTimeout(
      bot.api.deleteWebhook({ drop_pending_updates: false }),
      10_000,
      'deleteWebhook',
    );
  } catch (e) {
    console.warn('[bot] deleteWebhook:', e instanceof Error ? e.message : e);
  }

  // Required before bot.handleUpdate (bot.start does this; we use a custom poll loop)
  try {
    await bot.init();
    console.log(`[bot] @${bot.botInfo.username} init ok — starting poll`);
  } catch (e) {
    console.error('[bot] init/getMe failed:', e);
    throw e;
  }

  // Non-blocking menu / bridge (never delay first getUpdates)
  void (async () => {
    try {
      const { setupBotMenu } = await import('./bot/menu.js');
      await withTimeout(setupBotMenu(bot), 25_000, 'setupBotMenu');
    } catch (e) {
      console.warn('[bot] menu:', e instanceof Error ? e.message : e);
    }
  })();
  void (async () => {
    try {
      const { getBridgeRelayerStatus } = await import('./services/bridge.js');
      const rel = await withTimeout(getBridgeRelayerStatus(), 10_000, 'relayer');
      console.log(`[bridge] sponsorArc=${rel.canSponsorArc} addr=${rel.address ?? 'n/a'}`);
    } catch (e) {
      console.warn('[bridge] skipped:', e instanceof Error ? e.message : e);
    }
  })();

  try {
    const { listAllWalletCount, getDbPath } = await import('./db/store.js');
    console.log(`[db] path=${getDbPath()} wallets=${listAllWalletCount()}`);
  } catch {
    /* */
  }

  try {
    const { startBackupScheduler } = await import('./services/backup.js');
    startBackupScheduler();
  } catch {
    /* */
  }

  // Never returns unless error thrown out of loop
  await runPollingLoop(bot);
}

async function main(): Promise<void> {
  installProcessGuards();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      console.log(`[bot] runner attempt ${attempt}`);
      await runBotOnce();
    } catch (e) {
      console.error('[bot] runner error:', e);
    }
    const wait = Math.min(3000 + attempt * 500, 20_000);
    console.log(`[bot] restart in ${wait}ms`);
    await sleep(wait);
  }
}

main().catch((e) => {
  console.error('[bot] outer fatal:', e);
  process.exit(1);
});
