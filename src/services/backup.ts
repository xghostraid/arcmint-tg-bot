/**
 * Periodic full SQLite backups to DATA_DIR/wallet-backups only.
 * Never DMs Telegram. Never deletes bot.sqlite — only rotates old backup files.
 */
import { backupFullDatabase, listAllWalletCount } from '../db/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runScheduledBackup(reason = 'daily'): Promise<void> {
  try {
    const result = await backupFullDatabase(reason);
    console.log(
      `[backup] ok path=${result.path} wallets=${result.walletCount} size=${result.size} (no Telegram send)`,
    );
  } catch (e) {
    console.error('[backup] failed:', e instanceof Error ? e.message : e);
  }
}

/** Run once after boot, then every 24h — disk only. */
export function startBackupScheduler(): void {
  const hours = Number(process.env.BACKUP_INTERVAL_HOURS || '24');
  const intervalMs = Math.max(1, hours) * 60 * 60 * 1000;

  setTimeout(() => {
    void runScheduledBackup('boot');
  }, 120_000);

  setInterval(() => {
    void runScheduledBackup('daily');
  }, intervalMs || DAY_MS);

  console.log(
    `[backup] scheduler on · every ${hours}h · disk only · wallets_now=${listAllWalletCount()}`,
  );
}
