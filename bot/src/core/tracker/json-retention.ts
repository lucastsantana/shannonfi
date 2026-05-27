/**
 * JSON retention service — maintains a 15-day rolling backup of trade data.
 *
 * After SQLite migration, this service provides a dual-write pattern:
 * 1. Write data to SQLite (primary store)
 * 2. Also write to JSON files (rolling 15-day backup)
 * 3. Periodically prune JSON records older than retention window
 *
 * On recovery, if SQLite is corrupted, the last 15 days are in JSON.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const DATA_DIR = path.resolve(__dirname, '../../../data');

export interface JsonRetentionConfig {
  retentionDays: number;  // days to keep; 0 = disable JSON backup
}

export class JsonRetentionService {
  private retentionDays: number;

  constructor(config: JsonRetentionConfig) {
    this.retentionDays = config.retentionDays;
  }

  /**
   * Write trade records to JSON, pruning older than retention window.
   */
  writeTradeHistory(records: any[]): void {
    if (this.retentionDays === 0) return; // Disabled

    const filePath = path.join(DATA_DIR, 'trade_history.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Keep only records from the last N days
    const cutoff = this.getCutoffDate();
    const filtered = records.filter((r) => {
      const ts = new Date(r.timestamp);
      return ts >= cutoff;
    });

    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
    logger.debug('Wrote trade history to JSON', { path: filePath, count: filtered.length });
  }

  /**
   * Write portfolio snapshots to JSON, pruning older than retention window.
   */
  writePortfolioSnapshots(records: any[]): void {
    if (this.retentionDays === 0) return;

    const filePath = path.join(DATA_DIR, 'portfolio_snapshots.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const cutoff = this.getCutoffDateBrt();
    const filtered = records.filter((r) => r.dateBRT >= cutoff);

    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
    logger.debug('Wrote portfolio snapshots to JSON', { path: filePath, count: filtered.length });
  }

  /**
   * Write tax events to JSON, pruning older than retention window.
   */
  writeTaxEvents(records: any[]): void {
    if (this.retentionDays === 0) return;

    const filePath = path.join(DATA_DIR, 'tax_events.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const cutoff = this.getCutoffDateBrt();
    const filtered = records.filter((r) => r.tradeDateBRT >= cutoff);

    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
    logger.debug('Wrote tax events to JSON', { path: filePath, count: filtered.length });
  }

  /**
   * Write cost basis to JSON (always current, no pruning).
   */
  writeCostBasis(record: any): void {
    if (this.retentionDays === 0) return;

    const filePath = path.join(DATA_DIR, 'cost_basis.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });

    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    logger.debug('Wrote cost basis to JSON', { path: filePath });
  }

  private getCutoffDate(): Date {
    const d = new Date();
    d.setDate(d.getDate() - this.retentionDays);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private getCutoffDateBrt(): string {
    const cutoff = this.getCutoffDate();
    return cutoff.toISOString().slice(0, 10); // YYYY-MM-DD
  }
}
