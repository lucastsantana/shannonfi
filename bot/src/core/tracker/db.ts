/**
 * SQLite database singleton for Shannon's Demon bot.
 * Handles schema creation and initialization on startup.
 * Use getDb() to get the shared database instance.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

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
 */
export function getDbConfig(key: string, defaultValue?: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue ?? null;
}

/**
 * Set a config value by key.
 */
export function setDbConfig(key: string, value: string): void {
  const db = getDb();
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
      after_timestamp     TEXT
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
      exchange              TEXT NOT NULL DEFAULT 'mercadobitcoin'
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
      execution_error       TEXT
    );

    -- Create indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date_brt);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_tax_month ON tax_events(month_brt);
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON portfolio_snapshots(date_brt);
    CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
    CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
    CREATE INDEX IF NOT EXISTS idx_pending_rotation_status ON pending_rotation(status);
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

  logger.info('Database schema initialized');
}
