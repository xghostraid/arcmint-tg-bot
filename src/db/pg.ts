import pg from 'pg';

let pool: pg.Pool | null = null;

export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.includes('postgres'));
}

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
    });
    pool.on('connect', (client) => {
      client.query('SET search_path TO tgbot, public').catch(() => {});
    });
    pool.on('error', (err) => {
      console.error('[pg] pool error', err.message);
    });
  }
  return pool;
}

function toPg(sql: string): string {
  let n = 0;
  return sql
    .replace(/INSERT OR IGNORE/gi, 'INSERT')
    .replace(/\?/g, () => `$${++n}`);
}

export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const text = toPg(sql);
  const returning =
    /^\s*INSERT\s/i.test(sql) && !/RETURNING/i.test(sql) ? `${text} RETURNING *` : text;
  const res = await getPool().query(returning, params);
  return res.rows.map(numify) as T[];
}

function numify<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && /^-?\d+$/.test(v) && /(^id$|_id$|_at$|bps$|count$)/.test(k)) {
      const n = Number(v);
      if (Number.isSafeInteger(n)) out[k] = n;
    }
  }
  return out as T;
}

export async function q1<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await q<T>(sql, params);
  return rows[0];
}

export async function qrun(
  sql: string,
  params: unknown[] = [],
): Promise<{ changes: number; lastInsertRowid: number }> {
  const text = toPg(sql);
  const needsId = /^\s*INSERT\s/i.test(sql) && !/RETURNING/i.test(sql);
  const res = await getPool().query(needsId ? `${text} RETURNING id` : text, params);
  const id = Number(res.rows[0]?.id || 0);
  return { changes: res.rowCount ?? 0, lastInsertRowid: id };
}

export const BOT_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS tgbot;
CREATE TABLE IF NOT EXISTS tgbot.users (
  tg_id BIGINT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  slippage_bps INT NOT NULL DEFAULT 100,
  active_wallet INTEGER NOT NULL DEFAULT 0,
  referrer_tg_id BIGINT,
  ref_code TEXT,
  lang TEXT NOT NULL DEFAULT 'en'
);
CREATE TABLE IF NOT EXISTS tgbot.wallets (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL REFERENCES tgbot.users(tg_id),
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  enc_pk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tgbot.fee_events (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  referrer_tg_id BIGINT,
  trade_usdc TEXT NOT NULL,
  fee_total TEXT NOT NULL,
  fee_treasury TEXT NOT NULL,
  fee_referral TEXT NOT NULL,
  swap_tx TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tgbot.known_tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  decimals INT NOT NULL DEFAULT 18,
  first_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tgbot.user_tokens (
  tg_id BIGINT NOT NULL,
  token_address TEXT NOT NULL,
  PRIMARY KEY (tg_id, token_address)
);
CREATE TABLE IF NOT EXISTS tgbot.cost_basis (
  tg_id BIGINT NOT NULL,
  token_address TEXT NOT NULL,
  tokens_raw TEXT NOT NULL DEFAULT '0',
  cost_usdc TEXT NOT NULL DEFAULT '0',
  realized_usdc TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (tg_id, token_address)
);
CREATE TABLE IF NOT EXISTS tgbot.trades (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
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
CREATE TABLE IF NOT EXISTS tgbot.watchlist (
  tg_id BIGINT NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT 'TOKEN',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (tg_id, token_address)
);
CREATE INDEX IF NOT EXISTS idx_wallets_tg ON tgbot.wallets(tg_id);
CREATE INDEX IF NOT EXISTS idx_fee_events_tg ON tgbot.fee_events(tg_id);
CREATE INDEX IF NOT EXISTS idx_fee_events_ref ON tgbot.fee_events(referrer_tg_id);
CREATE INDEX IF NOT EXISTS idx_trades_tg ON tgbot.trades(tg_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchlist_tg ON tgbot.watchlist(tg_id);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON tgbot.users(referrer_tg_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON tgbot.users(ref_code) WHERE ref_code IS NOT NULL;
`;

let schemaReady = false;
export async function ensureBotSchema(): Promise<void> {
  if (schemaReady) return;
  await getPool().query(BOT_SCHEMA);
  schemaReady = true;
  console.log('[db] postgres ready');
}
