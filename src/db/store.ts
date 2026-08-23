import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WALLET PERSISTENCE — HARD RULE
 * ─────────────────────────────────────────────────────────────
 * NEVER delete user wallets. No DELETE FROM wallets. No DROP TABLE wallets.
 * No rm of bot.sqlite. No "reset DB" helpers. No UI to remove wallets.
 * Lost wallets = empty DATA_DIR / new volume, not intentional deletes.
 * Override with DATA_DIR only for a durable volume (Railway: /data).
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const backupDir = path.join(dataDir, 'wallet-backups');
fs.mkdirSync(backupDir, { recursive: true });

const dbPath = path.join(dataDir, 'bot.sqlite');

// On Railway (or any host with RAILWAY_ENVIRONMENT), DATA_DIR must point at the
// mounted volume. Refusing ephemeral container FS prevents "wallets vanished" deploys.
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
  const required = process.env.DATA_DIR;
  if (!required || path.resolve(required) !== path.resolve('/data')) {
    throw new Error(
      '[db] FATAL: On Railway, DATA_DIR must be /data (volume mount). ' +
        `Got DATA_DIR=${required ?? '(unset)'}. Refusing to open a throwaway DB.`,
    );
  }
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Never wipe user data — log path once for ops. */
console.log(`[db] sqlite ${dbPath}`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    tg_id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    slippage_bps INTEGER NOT NULL DEFAULT 100,
    active_wallet INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    address TEXT NOT NULL,
    enc_pk TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (tg_id) REFERENCES users(tg_id)
  );

  CREATE TABLE IF NOT EXISTS fee_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    referrer_tg_id INTEGER,
    trade_usdc TEXT NOT NULL,
    fee_total TEXT NOT NULL,
    fee_treasury TEXT NOT NULL,
    fee_referral TEXT NOT NULL,
    swap_tx TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS known_tokens (
    address TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 18,
    first_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_tokens (
    tg_id INTEGER NOT NULL,
    token_address TEXT NOT NULL,
    PRIMARY KEY (tg_id, token_address)
  );

  /** Average-cost inventory for unrealized PnL (bot-tracked trades only). */
  CREATE TABLE IF NOT EXISTS cost_basis (
    tg_id INTEGER NOT NULL,
    token_address TEXT NOT NULL,
    tokens_raw TEXT NOT NULL DEFAULT '0',
    cost_usdc TEXT NOT NULL DEFAULT '0',
    realized_usdc TEXT NOT NULL DEFAULT '0',
    PRIMARY KEY (tg_id, token_address)
  );

  /** Immutable trade log (buys/sells) — never delete rows. */
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    side TEXT NOT NULL,
    token_address TEXT NOT NULL,
    token_symbol TEXT NOT NULL,
    token_amount TEXT NOT NULL,
    usdc_amount TEXT NOT NULL,
    fee_usdc TEXT NOT NULL DEFAULT '0',
    realized_usdc TEXT,
    tx_hash TEXT,
    created_at INTEGER NOT NULL
  );

  /** User watchlist — pin tokens without holding. */
  CREATE TABLE IF NOT EXISTS watchlist (
    tg_id INTEGER NOT NULL,
    token_address TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT 'TOKEN',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (tg_id, token_address)
  );

  CREATE INDEX IF NOT EXISTS idx_wallets_tg ON wallets(tg_id);
  CREATE INDEX IF NOT EXISTS idx_fee_events_tg ON fee_events(tg_id);
  CREATE INDEX IF NOT EXISTS idx_fee_events_ref ON fee_events(referrer_tg_id);
  CREATE INDEX IF NOT EXISTS idx_trades_tg ON trades(tg_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_watchlist_tg ON watchlist(tg_id);
`);

// Migrate older DBs
const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
if (!userCols.some((c) => c.name === 'referrer_tg_id')) {
  db.exec('ALTER TABLE users ADD COLUMN referrer_tg_id INTEGER');
}
if (!userCols.some((c) => c.name === 'ref_code')) {
  db.exec('ALTER TABLE users ADD COLUMN ref_code TEXT');
}
if (!userCols.some((c) => c.name === 'lang')) {
  db.exec("ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_tg_id)');
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code) WHERE ref_code IS NOT NULL',
);

export type UserRow = {
  tg_id: number;
  created_at: number;
  slippage_bps: number;
  active_wallet: number;
  referrer_tg_id: number | null;
  ref_code: string | null;
  lang: string | null;
};

export type WalletRow = {
  id: number;
  tg_id: number;
  label: string;
  address: string;
  enc_pk: string;
  created_at: number;
};

export type FeeEventRow = {
  id: number;
  tg_id: number;
  referrer_tg_id: number | null;
  trade_usdc: string;
  fee_total: string;
  fee_treasury: string;
  fee_referral: string;
  swap_tx: string | null;
  created_at: number;
};

export function ensureUser(tgId: number): UserRow {
  const existing = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) as
    | UserRow
    | undefined;
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT INTO users (tg_id, created_at, slippage_bps, active_wallet, referrer_tg_id) VALUES (?, ?, 100, 0, NULL)',
  ).run(tgId, now);
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) as UserRow;
}

/**
 * Bind referrer once. Ignores self-ref, missing users, and users who already have a referrer.
 */
export function trySetReferrer(tgId: number, referrerTgId: number): boolean {
  if (!Number.isFinite(referrerTgId) || referrerTgId <= 0) return false;
  if (referrerTgId === tgId) return false;
  ensureUser(tgId);
  ensureUser(referrerTgId);
  const user = ensureUser(tgId);
  if (user.referrer_tg_id) return false;
  db.prepare('UPDATE users SET referrer_tg_id = ? WHERE tg_id = ? AND referrer_tg_id IS NULL').run(
    referrerTgId,
    tgId,
  );
  return ensureUser(tgId).referrer_tg_id === referrerTgId;
}

export function getReferrerTgId(tgId: number): number | null {
  const u = ensureUser(tgId);
  return u.referrer_tg_id ?? null;
}

export function getRefCode(tgId: number): string | null {
  return ensureUser(tgId).ref_code ?? null;
}

/** Invite slug for links: custom username, else tg id. */
export function getInviteSlug(tgId: number): string {
  const code = getRefCode(tgId);
  return code || String(tgId);
}

const RESERVED_REF_CODES = new Set([
  'start',
  'home',
  'help',
  'wallet',
  'buy',
  'sell',
  'settings',
  'admin',
  'ref',
  'referral',
  'support',
  'bot',
  'arcmint',
  'arctrade',
]);

/**
 * Validate + set unique referral username.
 * Rules: 3–20 chars, start with a letter, a–z 0–9 _, case-insensitive unique.
 */
export function setRefCode(
  tgId: number,
  raw: string,
): { ok: true; code: string } | { ok: false; error: string } {
  ensureUser(tgId);
  const code = raw.trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(code)) {
    return {
      ok: false,
      error:
        'Username must be 3–20 chars, start with a letter, and use only a–z, 0–9, underscore.',
    };
  }
  if (RESERVED_REF_CODES.has(code)) {
    return { ok: false, error: 'That username is reserved. Pick another.' };
  }
  // Pure digit-like codes that could collide with tg ids are blocked by letter-start rule.

  const taken = db
    .prepare(
      'SELECT tg_id FROM users WHERE lower(ref_code) = ? AND tg_id != ? LIMIT 1',
    )
    .get(code, tgId) as { tg_id: number } | undefined;
  if (taken) {
    return { ok: false, error: 'That username is already taken.' };
  }

  try {
    db.prepare('UPDATE users SET ref_code = ? WHERE tg_id = ?').run(code, tgId);
  } catch {
    return { ok: false, error: 'That username is already taken.' };
  }
  return { ok: true, code };
}

/** Resolve /start payload (ref_alice, ref_123, alice) → referrer tg id. */
export function resolveReferrerFromPayload(payload: string): number | null {
  let p = payload.trim();
  if (!p) return null;
  p = p.replace(/^(ref[_-]?)/i, '');
  if (!p) return null;

  // Numeric Telegram id
  if (/^\d+$/.test(p)) {
    const id = Number(p);
    if (!Number.isFinite(id) || id <= 0) return null;
    const exists = db.prepare('SELECT tg_id FROM users WHERE tg_id = ?').get(id) as
      | { tg_id: number }
      | undefined;
    // Still allow binding to id even if they never opened the bot — ensureUser on set
    return id;
  }

  const code = p.toLowerCase();
  const row = db
    .prepare('SELECT tg_id FROM users WHERE lower(ref_code) = ? LIMIT 1')
    .get(code) as { tg_id: number } | undefined;
  return row?.tg_id ?? null;
}

export function listWallets(tgId: number): WalletRow[] {
  return db
    .prepare('SELECT * FROM wallets WHERE tg_id = ? ORDER BY id ASC')
    .all(tgId) as WalletRow[];
}

/** Total wallets stored (for startup health log — never wipe this table). */
export function listAllWalletCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM wallets').get() as { c: number };
  return row.c;
}

export function getDbPath(): string {
  return dbPath;
}

export function getDataDir(): string {
  return dataDir;
}

export function getBackupDir(): string {
  return backupDir;
}

/** Consistent offline copy of the full SQLite DB (wallets + all tables). Never deletes live DB. */
export async function backupFullDatabase(reason: string): Promise<{
  path: string;
  size: number;
  walletCount: number;
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const outPath = path.join(backupDir, `bot-${stamp}-${safeReason}.sqlite`);
  await db.backup(outPath);
  const size = fs.statSync(outPath).size;
  const walletCount = listAllWalletCount();

  // Keep last 14 full DB dumps (never touch bot.sqlite itself)
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('bot-') && f.endsWith('.sqlite'))
    .sort();
  while (files.length > 14) {
    const old = files.shift();
    if (old) {
      try {
        fs.unlinkSync(path.join(backupDir, old));
      } catch {
        /* */
      }
    }
  }
  console.log(`[db] full backup ${outPath} size=${size} wallets=${walletCount} reason=${reason}`);
  return { path: outPath, size, walletCount };
}

export type WatchlistRow = {
  tg_id: number;
  token_address: string;
  symbol: string;
  added_at: number;
};

export function addToWatchlist(tgId: number, tokenAddress: string, symbol: string): boolean {
  ensureUser(tgId);
  const addr = tokenAddress.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO watchlist (tg_id, token_address, symbol, added_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(tgId, addr, symbol.slice(0, 32), now);
  if (info.changes > 0) {
    rememberToken(tgId, addr, symbol, 18);
    return true;
  }
  // Update symbol if already watched
  db.prepare(`UPDATE watchlist SET symbol = ? WHERE tg_id = ? AND token_address = ?`).run(
    symbol.slice(0, 32),
    tgId,
    addr,
  );
  return false;
}

export function removeFromWatchlist(tgId: number, tokenAddress: string): boolean {
  const info = db
    .prepare(`DELETE FROM watchlist WHERE tg_id = ? AND token_address = ?`)
    .run(tgId, tokenAddress.toLowerCase());
  return info.changes > 0;
}

export function isOnWatchlist(tgId: number, tokenAddress: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS o FROM watchlist WHERE tg_id = ? AND token_address = ?`)
    .get(tgId, tokenAddress.toLowerCase()) as { o: number } | undefined;
  return Boolean(row);
}

export function listWatchlist(tgId: number): WatchlistRow[] {
  return db
    .prepare(
      `SELECT tg_id, token_address, symbol, added_at FROM watchlist
       WHERE tg_id = ? ORDER BY added_at DESC LIMIT 40`,
    )
    .all(tgId) as WatchlistRow[];
}

/**
 * INTENTIONALLY OMITTED — never implement:
 * - deleteWallet / removeWallet
 * - DELETE FROM wallets
 * - DROP TABLE wallets
 * - unlink(bot.sqlite)
 * User wallets are permanent once stored.
 */

/** Snapshot all wallets (still encrypted) after every create/import. */
function backupWalletsSnapshot(reason: string): void {
  try {
    const rows = db.prepare('SELECT * FROM wallets ORDER BY id ASC').all() as WalletRow[];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(backupDir, `wallets-${stamp}-${reason}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          reason,
          at: new Date().toISOString(),
          dbPath,
          count: rows.length,
          wallets: rows,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    // Keep last 50 snapshots — never delete bot.sqlite itself
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('wallets-') && f.endsWith('.json'))
      .sort();
    while (files.length > 50) {
      const old = files.shift();
      if (old) fs.unlinkSync(path.join(backupDir, old));
    }
  } catch (e) {
    console.error('[db] wallet backup failed (non-fatal):', e);
  }
}

export function addWallet(
  tgId: number,
  label: string,
  address: string,
  encPk: string,
): WalletRow {
  ensureUser(tgId);
  const now = Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      'INSERT INTO wallets (tg_id, label, address, enc_pk, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(tgId, label, address, encPk, now);
  const id = Number(info.lastInsertRowid);
  const wallets = listWallets(tgId);
  if (wallets.length === 1) {
    db.prepare('UPDATE users SET active_wallet = ? WHERE tg_id = ?').run(id, tgId);
  }
  backupWalletsSnapshot(`add-${tgId}-${id}`);
  return db.prepare('SELECT * FROM wallets WHERE id = ?').get(id) as WalletRow;
}

export function getActiveWallet(tgId: number): WalletRow | null {
  const user = ensureUser(tgId);
  if (!user.active_wallet) {
    const wallets = listWallets(tgId);
    return wallets[0] ?? null;
  }
  return (
    (db.prepare('SELECT * FROM wallets WHERE id = ? AND tg_id = ?').get(
      user.active_wallet,
      tgId,
    ) as WalletRow | undefined) ?? null
  );
}

export function setActiveWallet(tgId: number, walletId: number): void {
  db.prepare('UPDATE users SET active_wallet = ? WHERE tg_id = ?').run(walletId, tgId);
}

export function setSlippage(tgId: number, bps: number): void {
  ensureUser(tgId);
  db.prepare('UPDATE users SET slippage_bps = ? WHERE tg_id = ?').run(bps, tgId);
}

export function getSlippage(tgId: number): number {
  return ensureUser(tgId).slippage_bps;
}

export function getLang(tgId: number): string {
  return ensureUser(tgId).lang || 'en';
}

export function setLang(tgId: number, lang: string): void {
  ensureUser(tgId);
  db.prepare('UPDATE users SET lang = ? WHERE tg_id = ?').run(lang, tgId);
}

export function recordFeeEvent(opts: {
  tgId: number;
  referrerTgId: number | null;
  tradeUsdc: string;
  feeTotal: string;
  feeTreasury: string;
  feeReferral: string;
  swapTx: string | null;
}): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO fee_events
      (tg_id, referrer_tg_id, trade_usdc, fee_total, fee_treasury, fee_referral, swap_tx, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.tgId,
    opts.referrerTgId,
    opts.tradeUsdc,
    opts.feeTotal,
    opts.feeTreasury,
    opts.feeReferral,
    opts.swapTx,
    now,
  );
}

export type TradeSide = 'buy' | 'sell';

export type TradeRow = {
  id: number;
  tg_id: number;
  side: TradeSide;
  token_address: string;
  token_symbol: string;
  token_amount: string;
  usdc_amount: string;
  fee_usdc: string;
  realized_usdc: string | null;
  tx_hash: string | null;
  created_at: number;
};

/** Append-only trade history (never deleted). */
export function recordTrade(opts: {
  tgId: number;
  side: TradeSide;
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: string;
  usdcAmount: string;
  feeUsdc?: string;
  realizedUsdc?: number | null;
  txHash?: string | null;
}): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO trades
      (tg_id, side, token_address, token_symbol, token_amount, usdc_amount, fee_usdc, realized_usdc, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.tgId,
    opts.side,
    opts.tokenAddress.toLowerCase(),
    opts.tokenSymbol.slice(0, 32),
    opts.tokenAmount,
    opts.usdcAmount,
    opts.feeUsdc ?? '0',
    opts.realizedUsdc != null && Number.isFinite(opts.realizedUsdc)
      ? String(opts.realizedUsdc)
      : null,
    opts.txHash ?? null,
    now,
  );
}

export function listTrades(tgId: number, limit = 20): TradeRow[] {
  return db
    .prepare(
      `SELECT * FROM trades WHERE tg_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(tgId, limit) as TradeRow[];
}

export type ReferralStats = {
  inviteCount: number;
  tradeCount: number;
  volumeUsdc: number;
  earnedUsdc: number;
};

/** Remember a token the user bought / was seen holding (RPC fallback for positions). */
export function rememberToken(
  tgId: number,
  address: string,
  symbol: string,
  decimals: number,
): void {
  const addr = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO known_tokens (address, symbol, decimals, first_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals`,
  ).run(addr, symbol.slice(0, 32), decimals, now);
  db.prepare(
    `INSERT OR IGNORE INTO user_tokens (tg_id, token_address) VALUES (?, ?)`,
  ).run(tgId, addr);
}

export function listKnownTokensForUser(
  tgId: number,
): { address: string; symbol: string; decimals: number }[] {
  return db
    .prepare(
      `SELECT k.address, k.symbol, k.decimals
       FROM user_tokens u
       JOIN known_tokens k ON k.address = u.token_address
       WHERE u.tg_id = ?
       ORDER BY k.first_seen DESC
       LIMIT 100`,
    )
    .all(tgId) as { address: string; symbol: string; decimals: number }[];
}

type CostRow = {
  tokens_raw: string;
  cost_usdc: string;
  realized_usdc: string;
};

function getCostRow(tgId: number, token: string): CostRow {
  const addr = token.toLowerCase();
  const row = db
    .prepare(
      'SELECT tokens_raw, cost_usdc, realized_usdc FROM cost_basis WHERE tg_id = ? AND token_address = ?',
    )
    .get(tgId, addr) as CostRow | undefined;
  if (row) return row;
  db.prepare(
    `INSERT INTO cost_basis (tg_id, token_address, tokens_raw, cost_usdc, realized_usdc)
     VALUES (?, ?, '0', '0', '0')`,
  ).run(tgId, addr);
  return { tokens_raw: '0', cost_usdc: '0', realized_usdc: '0' };
}

/** Record a buy into average-cost inventory (token raw amount + USDC spent). */
export function recordBuyCost(
  tgId: number,
  token: string,
  tokenAmountRaw: bigint,
  usdcSpent: number,
): void {
  if (tokenAmountRaw <= 0n || !(usdcSpent > 0)) return;
  const addr = token.toLowerCase();
  const row = getCostRow(tgId, addr);
  let tokens = 0n;
  try {
    tokens = BigInt(row.tokens_raw || '0');
  } catch {
    tokens = 0n;
  }
  const cost = Number(row.cost_usdc) || 0;
  const nextTokens = tokens + tokenAmountRaw;
  const nextCost = cost + usdcSpent;
  db.prepare(
    `UPDATE cost_basis SET tokens_raw = ?, cost_usdc = ? WHERE tg_id = ? AND token_address = ?`,
  ).run(nextTokens.toString(), String(nextCost), tgId, addr);
}

/**
 * cost * num / den without Number(bigint) precision loss on huge token amounts.
 * Uses fixed-point ratio (1e12).
 */
function mulDivCost(costUsd: number, num: bigint, den: bigint): number {
  if (costUsd <= 0 || den <= 0n || num <= 0n) return 0;
  const scale = 1_000_000_000_000n; // 1e12
  const ratio = (num * scale) / den; // floor
  // ratio is in 1e12 units of den
  return (costUsd * Number(ratio)) / 1e12;
}

/** Record a sell: reduce inventory, accrue realized PnL. */
export function recordSellCost(
  tgId: number,
  token: string,
  tokenAmountRaw: bigint,
  usdcReceived: number,
): number {
  if (tokenAmountRaw <= 0n) return 0;
  const addr = token.toLowerCase();
  const row = getCostRow(tgId, addr);
  let tokens = 0n;
  try {
    tokens = BigInt(row.tokens_raw || '0');
  } catch {
    tokens = 0n;
  }
  const cost = Number(row.cost_usdc) || 0;
  const realized = Number(row.realized_usdc) || 0;

  if (tokens <= 0n || cost <= 0) {
    // No basis — treat full proceeds as realized (unknown cost)
    db.prepare(
      `UPDATE cost_basis SET realized_usdc = ? WHERE tg_id = ? AND token_address = ?`,
    ).run(String(realized + usdcReceived), tgId, addr);
    return usdcReceived;
  }

  const sold = tokenAmountRaw > tokens ? tokens : tokenAmountRaw;
  const costOfSold = mulDivCost(cost, sold, tokens);
  const realizedPnl = usdcReceived - costOfSold;
  const nextTokens = tokens - sold;
  const nextCost = Math.max(0, cost - costOfSold);

  db.prepare(
    `UPDATE cost_basis SET tokens_raw = ?, cost_usdc = ?, realized_usdc = ?
     WHERE tg_id = ? AND token_address = ?`,
  ).run(
    nextTokens.toString(),
    String(nextCost),
    String(realized + realizedPnl),
    tgId,
    addr,
  );
  return realizedPnl;
}

export type PositionPnl = {
  /** USDC cost attributed to current balance */
  costUsdc: number;
  /** Mark value of current balance in USDC */
  markUsdc: number;
  /** mark - cost */
  unrealizedUsdc: number;
  /** % vs cost; null if no cost */
  unrealizedPct: number | null;
  /** Lifetime realized from bot sells */
  realizedUsdc: number;
  hasBasis: boolean;
};

/**
 * Unrealized PnL for current token balance using average cost from bot trades.
 * markUsdc = current full-balance quote in USDC.
 */
export function getPositionPnl(
  tgId: number,
  token: string,
  balanceRaw: bigint,
  markUsdc: number,
): PositionPnl {
  const row = db
    .prepare(
      'SELECT tokens_raw, cost_usdc, realized_usdc FROM cost_basis WHERE tg_id = ? AND token_address = ?',
    )
    .get(tgId, token.toLowerCase()) as CostRow | undefined;

  const realizedUsdc = row ? Number(row.realized_usdc) || 0 : 0;
  if (!row || balanceRaw <= 0n || !(markUsdc >= 0) || !Number.isFinite(markUsdc)) {
    return {
      costUsdc: 0,
      markUsdc: Number.isFinite(markUsdc) ? markUsdc : 0,
      unrealizedUsdc: 0,
      unrealizedPct: null,
      realizedUsdc,
      hasBasis: false,
    };
  }

  let tracked = 0n;
  try {
    tracked = BigInt(row.tokens_raw || '0');
  } catch {
    tracked = 0n;
  }
  const costPool = Number(row.cost_usdc) || 0;

  if (tracked <= 0n || costPool <= 0) {
    return {
      costUsdc: 0,
      markUsdc,
      unrealizedUsdc: 0,
      unrealizedPct: null,
      realizedUsdc,
      hasBasis: false,
    };
  }

  // Only attribute cost to min(balance, tracked) — external inflows have $0 cost
  const attributed = balanceRaw < tracked ? balanceRaw : tracked;
  const costUsdc = mulDivCost(costPool, attributed, tracked);
  const unrealizedUsdc = markUsdc - costUsdc;
  const unrealizedPct = costUsdc > 1e-9 ? (unrealizedUsdc / costUsdc) * 100 : null;

  return {
    costUsdc,
    markUsdc,
    unrealizedUsdc,
    unrealizedPct,
    realizedUsdc,
    hasBasis: true,
  };
}

export function formatPnlShort(pnl: PositionPnl): string {
  if (!pnl.hasBasis) return 'PnL n/a';
  const sign = pnl.unrealizedUsdc >= 0 ? '+' : '';
  const usd = `${sign}$${Math.abs(pnl.unrealizedUsdc).toFixed(2)}`;
  if (pnl.unrealizedPct == null) return usd;
  const ps = pnl.unrealizedPct >= 0 ? '+' : '';
  return `${usd} (${ps}${pnl.unrealizedPct.toFixed(1)}%)`;
}

export function formatPnlLines(pnl: PositionPnl): string[] {
  if (!pnl.hasBasis) {
    return [
      `Value ≈ *$${pnl.markUsdc.toFixed(2)}* USDC`,
      `_PnL n/a — buy this token in the bot to track cost basis_`,
    ];
  }
  const sign = pnl.unrealizedUsdc >= 0 ? '+' : '';
  const pct =
    pnl.unrealizedPct == null
      ? ''
      : ` (${pnl.unrealizedPct >= 0 ? '+' : ''}${pnl.unrealizedPct.toFixed(1)}%)`;
  return [
    `Cost basis ≈ *$${pnl.costUsdc.toFixed(2)}*`,
    `Value ≈ *$${pnl.markUsdc.toFixed(2)}*`,
    `PnL ≈ *${sign}$${Math.abs(pnl.unrealizedUsdc).toFixed(2)}*${pct}`,
  ];
}

export function getReferralStats(tgId: number): ReferralStats {
  const inviteCount = (
    db.prepare('SELECT COUNT(*) AS c FROM users WHERE referrer_tg_id = ?').get(tgId) as {
      c: number;
    }
  ).c;

  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS trade_count,
         COALESCE(SUM(CAST(trade_usdc AS REAL)), 0) AS volume,
         COALESCE(SUM(CAST(fee_referral AS REAL)), 0) AS earned
       FROM fee_events
       WHERE referrer_tg_id = ?`,
    )
    .get(tgId) as { trade_count: number; volume: number; earned: number };

  return {
    inviteCount,
    tradeCount: row.trade_count,
    volumeUsdc: row.volume,
    earnedUsdc: row.earned,
  };
}

export type ReferralPayoutRow = {
  tg_id: number;
  trade_usdc: string;
  fee_referral: string;
  created_at: number;
  swap_tx: string | null;
};

/** Latest referral fee payouts (USDC already sent to referrer on-chain). */
export function listRecentReferralPayouts(tgId: number, limit = 8): ReferralPayoutRow[] {
  return db
    .prepare(
      `SELECT tg_id, trade_usdc, fee_referral, created_at, swap_tx
       FROM fee_events
       WHERE referrer_tg_id = ? AND CAST(fee_referral AS REAL) > 0
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(tgId, limit) as ReferralPayoutRow[];
}

/** Users who joined via this referrer (most recent first). */
export function listRecentInvitees(
  tgId: number,
  limit = 6,
): { tg_id: number; created_at: number; ref_code: string | null }[] {
  return db
    .prepare(
      `SELECT tg_id, created_at, ref_code FROM users
       WHERE referrer_tg_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(tgId, limit) as { tg_id: number; created_at: number; ref_code: string | null }[];
}

/** Example: $100 trade → platform fee → your cut (for growth UI). */
export function referralEarningsExample(
  tradeUsdc: number,
  platformFeeBps: number,
  referralShareBps: number,
): {
  tradeUsdc: number;
  feeTotal: number;
  youEarn: number;
  feePct: number;
  refSharePct: number;
} {
  const feeBps = Math.max(0, Math.min(1000, platformFeeBps));
  const shareBps = Math.max(0, Math.min(10_000, referralShareBps));
  const feeTotal = (tradeUsdc * feeBps) / 10_000;
  const youEarn = (feeTotal * shareBps) / 10_000;
  return {
    tradeUsdc,
    feeTotal,
    youEarn,
    feePct: feeBps / 100,
    refSharePct: shareBps / 100,
  };
}

/** Platform-wide fee stats for the bot creator (from fee_events). */
export type CreatorFeeStats = {
  tradeCount: number;
  uniqueTraders: number;
  volumeUsdc: number;
  feeTotalUsdc: number;
  feeTreasuryUsdc: number;
  feeReferralUsdc: number;
  usersCount: number;
  walletsCount: number;
  lastTradeAt: number | null;
};

export function getCreatorFeeStats(): CreatorFeeStats {
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) AS trade_count,
         COUNT(DISTINCT tg_id) AS unique_traders,
         COALESCE(SUM(CAST(trade_usdc AS REAL)), 0) AS volume,
         COALESCE(SUM(CAST(fee_total AS REAL)), 0) AS fee_total,
         COALESCE(SUM(CAST(fee_treasury AS REAL)), 0) AS fee_treasury,
         COALESCE(SUM(CAST(fee_referral AS REAL)), 0) AS fee_referral,
         MAX(created_at) AS last_at
       FROM fee_events`,
    )
    .get() as {
    trade_count: number;
    unique_traders: number;
    volume: number;
    fee_total: number;
    fee_treasury: number;
    fee_referral: number;
    last_at: number | null;
  };

  const usersCount = (
    db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  ).c;
  const walletsCount = (
    db.prepare('SELECT COUNT(*) AS c FROM wallets').get() as { c: number }
  ).c;

  return {
    tradeCount: agg.trade_count || 0,
    uniqueTraders: agg.unique_traders || 0,
    volumeUsdc: Number(agg.volume) || 0,
    feeTotalUsdc: Number(agg.fee_total) || 0,
    feeTreasuryUsdc: Number(agg.fee_treasury) || 0,
    feeReferralUsdc: Number(agg.fee_referral) || 0,
    usersCount,
    walletsCount,
    lastTradeAt: agg.last_at ?? null,
  };
}

/** Lifetime realized PnL from bot sells (cost_basis). */
export function getLifetimeRealizedUsdc(tgId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(realized_usdc AS REAL)), 0) AS r
       FROM cost_basis WHERE tg_id = ?`,
    )
    .get(tgId) as { r: number };
  return Number(row.r) || 0;
}
