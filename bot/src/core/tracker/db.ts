/**
 * SQLite database singleton for Shannon's Demon bot.
 * Handles schema creation and initialization on startup.
 * Use getDb() to get the shared database instance.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';
import { DEFAULT_INITIAL_SHARES } from '../../constants';

let instance: Database.Database | null = null;
let lastPath: string | null = null;

/**
 * Get or create the shared SQLite database instance.
 * Safe to call multiple times — returns the same instance.
 * In tests, passing a different dbPath will create a new instance.
 */
export function getDb(dbPath?: string): Database.Database {
  const resolved = dbPath ?? path.resolve(__dirname, '../../../data/shannonfi.db');

  // If we already have an instance for this path, return it
  if (instance && lastPath === resolved) return instance;

  // Close previous instance if switching paths (e.g., in tests)
  if (instance && lastPath !== resolved) {
    instance.close();
    instance = null;
  }

  const dir = path.dirname(resolved);

  // Create data directory if it doesn't exist (skip for :memory:)
  if (resolved !== ':memory:') {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open or create the database
  instance = new Database(resolved);
  instance.pragma('journal_mode = WAL');  // Write-Ahead Logging for concurrent reads
  instance.pragma('foreign_keys = ON');    // Enforce foreign key constraints

  logger.info('Opening SQLite database', { path: resolved });
  runMigrations(instance);

  lastPath = resolved;
  return instance;
}

/**
 * Close the database connection (for testing).
 */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/**
 * Reset database (for testing in-memory instances).
 */
export function resetDb(): void {
  closeDb();
}

/**
 * Get a config value by key, with optional default.
 * Pass dbPath to target a specific instance's database; otherwise uses the
 * currently active singleton (whichever path was last opened via getDb()).
 */
export function getDbConfig(key: string, defaultValue?: string, dbPath?: string): string | null {
  const db = getDb(dbPath);
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue ?? null;
}

/**
 * Set a config value by key.
 * Pass dbPath to target a specific instance's database; otherwise uses the
 * currently active singleton (whichever path was last opened via getDb()).
 */
export function setDbConfig(key: string, value: string, dbPath?: string): void {
  const db = getDb(dbPath);
  const now = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO config (key, value, set_at) VALUES (?, ?, ?)').run(key, value, now);
}

/**
 * Rename a column on a table if it still exists under its old name.
 * No-op if the table already uses the new name (idempotent).
 */
function renameColumnIfExists(db: Database.Database, table: string, oldName: string, newName: string): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (columns.some((c) => c.name === oldName)) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
    logger.info('Renamed column', { table, from: oldName, to: newName });
  }
}

/**
 * Backfill legacy trades/snapshots rows (predating asset rotation support) with the
 * given asset. Only touches rows where base_asset is still NULL, so it's safe to call
 * on every startup — a no-op once the backfill has happened, and the right asset for
 * an instance's pre-rotation history (which was always one fixed asset before this
 * feature existed). Call with whatever asset is currently active for this instance.
 */
export function backfillBaseAsset(baseAsset: string, dbPath?: string): void {
  const db = getDb(dbPath);
  db.prepare('UPDATE trades SET base_asset = ? WHERE base_asset IS NULL').run(baseAsset);
  db.prepare('UPDATE portfolio_snapshots SET base_asset = ? WHERE base_asset IS NULL').run(baseAsset);
}

/**
 * Backfill fund-share accounting (nav_per_share/total_shares_outstanding) on
 * portfolio_snapshots rows that predate ShareLedgerService (nav_per_share IS NULL).
 * Anchors the instance at DEFAULT_INITIAL_SHARES (100) shares as of the first snapshot
 * with a positive total_value_brl, and rescales every other un-backfilled row against
 * that same share count — since no capital_flows exist yet for a not-yet-backfilled
 * instance, shares outstanding is constant across the whole backfilled span, so this
 * exactly reproduces (in nav/share terms) the total_value_brl return shape the instance
 * already had, rather than discarding pre-feature history.
 *
 * The first time this runs for an instance (capital_flows is still empty), it also
 * records that anchor's total_value_brl as a genesis DEPOSIT in capital_flows — the
 * instance's original funding becomes a real, browsable ledger entry (100 shares issued
 * at nav/share = anchor value ÷ 100) rather than something only implicit in the
 * snapshot columns.
 *
 * Separately (and on every call, not gated by the snapshot-backfill above having
 * anything left to do), also backfills trades.shares_outstanding/nav_per_share_before/
 * nav_per_share_after for any trade still missing them, using whichever capital_flows
 * row was in effect as of that trade's timestamp — this is what makes the dashboard's
 * trade-history table show real reference values for trades that predate
 * ShareLedgerService, rather than leaving them blank forever. Purely a reference field:
 * nothing else in the engine reads trades.shares_outstanding, so getting this slightly
 * wrong for an edge case is not a correctness risk the way the snapshot backfill is.
 *
 * Idempotent (only touches NULL rows; only ever inserts one genesis flow) — safe to
 * call on every startup.
 */
export function backfillShares(dbPath?: string): void {
  const db = getDb(dbPath);
  const rows = db
    .prepare('SELECT date_brt, timestamp, total_value_brl, exchange FROM portfolio_snapshots WHERE nav_per_share IS NULL ORDER BY date_brt ASC')
    .all() as { date_brt: string; timestamp: string; total_value_brl: number; exchange: string }[];

  const anchor = rows.find((r) => r.total_value_brl > 0);
  if (anchor) {
    const shares = DEFAULT_INITIAL_SHARES;
    const navPerShareAtAnchor = anchor.total_value_brl / shares;
    const existingFlows = (db.prepare('SELECT COUNT(*) as n FROM capital_flows').get() as { n: number }).n;

    const updateSnapshot = db.prepare(
      'UPDATE portfolio_snapshots SET total_shares_outstanding = ?, nav_per_share = ? WHERE date_brt = ?',
    );
    const insertGenesisFlow = db.prepare(`
      INSERT INTO capital_flows (
        id, timestamp, date_brt, type, brl_amount, nav_per_share_before, shares_delta,
        total_shares_after, total_value_brl_before, total_value_brl_after, exchange, note
      ) VALUES (?, ?, ?, 'DEPOSIT', ?, ?, ?, ?, 0, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const r of rows) {
        updateSnapshot.run(shares, r.total_value_brl / shares, r.date_brt);
      }
      if (existingFlows === 0) {
        insertGenesisFlow.run(
          uuidv4(), anchor.timestamp, anchor.date_brt, anchor.total_value_brl,
          navPerShareAtAnchor, shares, shares, anchor.total_value_brl, anchor.exchange,
          'Backfilled: initial portfolio value recorded as the inception deposit',
        );
      }
    });
    tx();

    logger.info('Backfilled fund-share accounting for pre-existing snapshots', {
      rowsBackfilled: rows.length,
      anchorDateBRT: anchor.date_brt,
      initialShares: shares,
      navPerShareAtAnchor,
      genesisFlowRecorded: existingFlows === 0,
    });
  }

  // The share count "in effect" for a trade is the latest capital_flows row at or before
  // its timestamp — except an instance's very first trade always fires a few minutes
  // *before* its first snapshot (persistSnapshot() runs at the end of the cycle the trade
  // was part of), so it will always predate the genesis flow by construction, not as some
  // rare fluke. Falling back to the earliest flow overall covers that: there's no share
  // count change between an instance's true inception and that first recorded flow, so
  // the genesis count applies retroactively to anything before it too.
  const tradesBackfilled = db.prepare(`
    UPDATE trades
    SET
      shares_outstanding = COALESCE(
        (SELECT total_shares_after FROM capital_flows cf WHERE cf.timestamp <= trades.timestamp ORDER BY cf.timestamp DESC LIMIT 1),
        (SELECT total_shares_after FROM capital_flows cf ORDER BY cf.timestamp ASC LIMIT 1)
      ),
      nav_per_share_before = before_total_value / COALESCE(
        (SELECT total_shares_after FROM capital_flows cf WHERE cf.timestamp <= trades.timestamp ORDER BY cf.timestamp DESC LIMIT 1),
        (SELECT total_shares_after FROM capital_flows cf ORDER BY cf.timestamp ASC LIMIT 1)
      ),
      nav_per_share_after = CASE WHEN after_total_value IS NOT NULL THEN after_total_value / COALESCE(
        (SELECT total_shares_after FROM capital_flows cf WHERE cf.timestamp <= trades.timestamp ORDER BY cf.timestamp DESC LIMIT 1),
        (SELECT total_shares_after FROM capital_flows cf ORDER BY cf.timestamp ASC LIMIT 1)
      ) ELSE NULL END
    WHERE shares_outstanding IS NULL
      AND EXISTS (SELECT 1 FROM capital_flows)
  `).run();

  if (tradesBackfilled.changes > 0) {
    logger.info('Backfilled fund-share reference fields on pre-existing trades', {
      tradesBackfilled: tradesBackfilled.changes,
    });
  }
}

/**
 * Add a column to a table if it doesn't already exist. No-op if present
 * (idempotent) — safe to call on every startup, same as runMigrations() itself.
 */
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info('Added column', { table, column });
  }
}

/**
 * Initialize database schema if tables don't exist.
 */
function runMigrations(db: Database.Database): void {
  // Create tables with IF NOT EXISTS for idempotency
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id                  TEXT PRIMARY KEY,
      client_order_id     TEXT NOT NULL,
      exchange_order_id   TEXT,
      exchange            TEXT NOT NULL DEFAULT 'mercadobitcoin',
      timestamp           TEXT NOT NULL,
      direction           TEXT NOT NULL,
      brl_amount_target   REAL NOT NULL,
      base_amount_filled  REAL,
      brl_amount_filled   REAL,
      fill_price          REAL,
      fee_brl             REAL,
      status              TEXT NOT NULL,
      dry_run             INTEGER NOT NULL DEFAULT 0,
      realized_gain_brl   REAL,
      trade_date_brt      TEXT,
      base_asset          TEXT,

      -- portfolioBefore (always present)
      before_base_balance  REAL NOT NULL,
      before_brl_balance  REAL NOT NULL,
      before_base_price    REAL NOT NULL,
      before_base_value    REAL NOT NULL,
      before_total_value  REAL NOT NULL,
      before_base_ratio_bps INTEGER NOT NULL,
      before_deviation_bps INTEGER NOT NULL,
      before_timestamp    TEXT NOT NULL,

      -- portfolioAfter (nullable)
      after_base_balance   REAL,
      after_brl_balance   REAL,
      after_base_price     REAL,
      after_base_value     REAL,
      after_total_value   REAL,
      after_base_ratio_bps INTEGER,
      after_deviation_bps INTEGER,
      after_timestamp     TEXT,

      -- fund-share accounting (see ShareLedgerService) — populated by RebalancerBot,
      -- null for trades recorded before this feature existed
      shares_outstanding    REAL,
      nav_per_share_before  REAL,
      nav_per_share_after   REAL
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      date_brt              TEXT PRIMARY KEY,
      timestamp             TEXT NOT NULL,
      total_value_brl       REAL NOT NULL,
      base_balance          REAL NOT NULL,
      brl_balance           REAL NOT NULL,
      base_price            REAL NOT NULL,
      base_ratio_bps        INTEGER NOT NULL,
      effective_threshold_bps INTEGER NOT NULL,
      rebalanced_today      INTEGER NOT NULL DEFAULT 0,
      exchange              TEXT NOT NULL DEFAULT 'mercadobitcoin',
      base_asset            TEXT,
      total_shares_outstanding REAL,
      nav_per_share          REAL
    );

    CREATE TABLE IF NOT EXISTS capital_flows (
      id                     TEXT PRIMARY KEY,
      timestamp              TEXT NOT NULL,
      date_brt               TEXT NOT NULL,
      type                   TEXT NOT NULL,
      brl_amount             REAL NOT NULL,
      nav_per_share_before   REAL NOT NULL,
      shares_delta           REAL NOT NULL,
      total_shares_after     REAL NOT NULL,
      total_value_brl_before REAL NOT NULL,
      total_value_brl_after  REAL NOT NULL,
      exchange               TEXT NOT NULL,
      note                   TEXT
    );

    CREATE TABLE IF NOT EXISTS tax_events (
      trade_id              TEXT PRIMARY KEY REFERENCES trades(id),
      trade_date_brt        TEXT NOT NULL,
      month_brt             TEXT NOT NULL,
      direction             TEXT NOT NULL,
      traded_volume_brl     REAL NOT NULL,
      gross_proceeds_brl    REAL NOT NULL,
      cost_basis_brl        REAL NOT NULL,
      realized_gain_brl     REAL NOT NULL,
      cum_monthly_sales_brl REAL NOT NULL,
      cum_monthly_gain_brl  REAL NOT NULL,
      exempt                INTEGER NOT NULL DEFAULT 1,
      payment_deadline      TEXT,
      exchange              TEXT NOT NULL DEFAULT 'mercadobitcoin'
    );

    CREATE TABLE IF NOT EXISTS cost_basis (
      asset                 TEXT PRIMARY KEY,
      average_cost_brl      REAL NOT NULL DEFAULT 0,
      total_base            REAL NOT NULL DEFAULT 0,
      last_updated          TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS config (
      key                   TEXT PRIMARY KEY,
      value                 TEXT NOT NULL,
      set_at                TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scans (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp             TEXT NOT NULL,
      window_days           INTEGER NOT NULL,
      total_scanned         INTEGER NOT NULL,
      status                TEXT NOT NULL DEFAULT 'COMPLETED',
      executed_at           TEXT,
      scan_data             TEXT NOT NULL,
      telegram_message_id   INTEGER
    );

    CREATE TABLE IF NOT EXISTS pending_rotation (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      from_symbol           TEXT NOT NULL,
      to_symbol             TEXT NOT NULL,
      approved_at           TEXT NOT NULL,
      executed_at           TEXT,
      status                TEXT NOT NULL DEFAULT 'APPROVED',
      execution_error       TEXT,
      scan_id               INTEGER REFERENCES scans(id),
      liquidation_trade_id  TEXT REFERENCES trades(id),
      reacquisition_trade_id TEXT REFERENCES trades(id),
      requested_by          TEXT NOT NULL DEFAULT 'telegram_manual'
    );

    -- Create indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date_brt);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_tax_month ON tax_events(month_brt);
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON portfolio_snapshots(date_brt);
    CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
    CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
    CREATE INDEX IF NOT EXISTS idx_pending_rotation_status ON pending_rotation(status);
    CREATE INDEX IF NOT EXISTS idx_capital_flows_date ON capital_flows(date_brt);
  `);

  // Migrate direction strings from legacy 'BUY_SOL'/'SELL_SOL' to 'BUY_BASE'/'SELL_BASE'
  db.exec(`
    UPDATE trades     SET direction = 'BUY_BASE'  WHERE direction = 'BUY_SOL';
    UPDATE trades     SET direction = 'SELL_BASE' WHERE direction = 'SELL_SOL';
    UPDATE tax_events SET direction = 'BUY_BASE'  WHERE direction = 'BUY_SOL';
    UPDATE tax_events SET direction = 'SELL_BASE' WHERE direction = 'SELL_SOL';
  `);

  // Migrate legacy 'sol_*'/'total_sol' columns to asset-agnostic 'base_*'/'total_base' names
  renameColumnIfExists(db, 'trades', 'sol_amount_filled', 'base_amount_filled');
  renameColumnIfExists(db, 'trades', 'before_sol_balance', 'before_base_balance');
  renameColumnIfExists(db, 'trades', 'before_sol_price', 'before_base_price');
  renameColumnIfExists(db, 'trades', 'before_sol_value', 'before_base_value');
  renameColumnIfExists(db, 'trades', 'before_sol_ratio_bps', 'before_base_ratio_bps');
  renameColumnIfExists(db, 'trades', 'after_sol_balance', 'after_base_balance');
  renameColumnIfExists(db, 'trades', 'after_sol_price', 'after_base_price');
  renameColumnIfExists(db, 'trades', 'after_sol_value', 'after_base_value');
  renameColumnIfExists(db, 'trades', 'after_sol_ratio_bps', 'after_base_ratio_bps');
  renameColumnIfExists(db, 'portfolio_snapshots', 'sol_balance', 'base_balance');
  renameColumnIfExists(db, 'portfolio_snapshots', 'sol_price', 'base_price');
  renameColumnIfExists(db, 'portfolio_snapshots', 'sol_ratio_bps', 'base_ratio_bps');
  renameColumnIfExists(db, 'cost_basis', 'total_sol', 'total_base');

  // Dynamic base-asset rotation: additive columns for instances that predate this feature.
  addColumnIfMissing(db, 'trades', 'base_asset', 'TEXT');
  addColumnIfMissing(db, 'portfolio_snapshots', 'base_asset', 'TEXT');
  addColumnIfMissing(db, 'pending_rotation', 'scan_id', 'INTEGER');
  addColumnIfMissing(db, 'pending_rotation', 'liquidation_trade_id', 'TEXT');
  addColumnIfMissing(db, 'pending_rotation', 'reacquisition_trade_id', 'TEXT');
  addColumnIfMissing(db, 'pending_rotation', 'requested_by', "TEXT NOT NULL DEFAULT 'telegram_manual'");

  // Fund-share (NAV-per-share) accounting: additive columns for instances that predate
  // this feature. portfolio_snapshots rows are backfilled by backfillShares() (see
  // below in this file) so the return/CAGR/drawdown series stays continuous; trades
  // rows are NOT backfilled — they're a per-trade reference/audit field for the
  // dashboard's trade table, nothing downstream depends on historical trades having
  // them, so older trades simply show blank rather than a fabricated value.
  addColumnIfMissing(db, 'portfolio_snapshots', 'total_shares_outstanding', 'REAL');
  addColumnIfMissing(db, 'portfolio_snapshots', 'nav_per_share', 'REAL');
  addColumnIfMissing(db, 'trades', 'shares_outstanding', 'REAL');
  addColumnIfMissing(db, 'trades', 'nav_per_share_before', 'REAL');
  addColumnIfMissing(db, 'trades', 'nav_per_share_after', 'REAL');

  logger.info('Database schema initialized');
}
