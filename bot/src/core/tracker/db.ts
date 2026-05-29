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
      sol_amount_filled   REAL,
      brl_amount_filled   REAL,
      fill_price          REAL,
      fee_brl             REAL,
      status              TEXT NOT NULL,
      dry_run             INTEGER NOT NULL DEFAULT 0,
      realized_gain_brl   REAL,
      trade_date_brt      TEXT,

      -- portfolioBefore (always present)
      before_sol_balance  REAL NOT NULL,
      before_brl_balance  REAL NOT NULL,
      before_sol_price    REAL NOT NULL,
      before_sol_value    REAL NOT NULL,
      before_total_value  REAL NOT NULL,
      before_sol_ratio_bps INTEGER NOT NULL,
      before_deviation_bps INTEGER NOT NULL,
      before_timestamp    TEXT NOT NULL,

      -- portfolioAfter (nullable)
      after_sol_balance   REAL,
      after_brl_balance   REAL,
      after_sol_price     REAL,
      after_sol_value     REAL,
      after_total_value   REAL,
      after_sol_ratio_bps INTEGER,
      after_deviation_bps INTEGER,
      after_timestamp     TEXT
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      date_brt              TEXT PRIMARY KEY,
      timestamp             TEXT NOT NULL,
      total_value_brl       REAL NOT NULL,
      sol_balance           REAL NOT NULL,
      brl_balance           REAL NOT NULL,
      sol_price             REAL NOT NULL,
      sol_ratio_bps         INTEGER NOT NULL,
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
      total_sol             REAL NOT NULL DEFAULT 0,
      last_updated          TEXT NOT NULL DEFAULT ''
    );

    -- Create indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date_brt);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_tax_month ON tax_events(month_brt);
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON portfolio_snapshots(date_brt);
  `);

  // Migrate direction strings from legacy 'BUY_SOL'/'SELL_SOL' to 'BUY_BASE'/'SELL_BASE'
  db.exec(`
    UPDATE trades     SET direction = 'BUY_BASE'  WHERE direction = 'BUY_SOL';
    UPDATE trades     SET direction = 'SELL_BASE' WHERE direction = 'SELL_SOL';
    UPDATE tax_events SET direction = 'BUY_BASE'  WHERE direction = 'BUY_SOL';
    UPDATE tax_events SET direction = 'SELL_BASE' WHERE direction = 'SELL_SOL';
  `);

  logger.info('Database schema initialized');
}
