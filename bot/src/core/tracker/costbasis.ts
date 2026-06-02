/**
 * Cost basis service — backed by SQLite.
 * Tracks AVCO (average cost) basis for the base asset position in BRL.
 * Also dual-writes to JSON files for 15-day rolling backup.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { getDb } from './db';

export interface CostBasisLedger {
  base: {
    averageCostBrl: number;
    totalBase: number;
  };
  lastUpdated: string;
}

export class CostBasisService {
  private db: Database.Database;
  private retentionDays: number;
  private asset: string;
  private dataDir: string;

  constructor(dbPath: string | undefined, retentionDays: number, asset: string) {
    if (!asset) throw new Error('asset parameter is required');
    this.db = getDb(dbPath);
    this.asset = asset;
    this.retentionDays = retentionDays;
    // Derive data directory from dbPath to ensure isolation per instance
    const resolvedDbPath = dbPath ?? path.resolve(__dirname, '../../../data/shannonfi.db');
    this.dataDir = path.dirname(resolvedDbPath);
    // Ensure a row exists for this asset on first use
    this.db.prepare('INSERT OR IGNORE INTO cost_basis (asset) VALUES (?)').run(this.asset);
  }

  getLedger(): CostBasisLedger {
    const stmt = this.db.prepare(
      'SELECT average_cost_brl, total_sol, last_updated FROM cost_basis WHERE asset = ?'
    );
    const row = stmt.get(this.asset) as {
      average_cost_brl: number;
      total_sol: number;
      last_updated: string;
    } | undefined;

    if (!row) {
      return { base: { averageCostBrl: 0, totalBase: 0 }, lastUpdated: '' };
    }

    return {
      base: {
        averageCostBrl: row.average_cost_brl,
        totalBase: row.total_sol,
      },
      lastUpdated: row.last_updated,
    };
  }

  private save(ledger: CostBasisLedger): void {
    const lastUpdated = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE cost_basis
      SET average_cost_brl = ?, total_sol = ?, last_updated = ?
      WHERE asset = ?
    `);
    stmt.run(ledger.base.averageCostBrl, ledger.base.totalBase, lastUpdated, this.asset);
    this.writeCostBasisToJson(ledger);
  }

  private writeCostBasisToJson(ledger: CostBasisLedger): void {
    if (this.retentionDays === 0) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmpPath = path.join(this.dataDir, 'cost_basis.json.tmp');
      const targetPath = path.join(this.dataDir, 'cost_basis.json');
      fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2), 'utf-8');
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      logger.debug('Failed to write cost basis JSON', { error: (err as Error).message });
    }
  }

  /** Weighted average update after buying baseAcquired units for brlSpent BRL. */
  updateAfterBuy(baseAcquired: number, brlSpent: number): void {
    const ledger = this.getLedger();
    const { averageCostBrl, totalBase } = ledger.base;
    const newTotal = totalBase + baseAcquired;

    ledger.base = newTotal <= 0
      ? { averageCostBrl: 0, totalBase: 0 }
      : {
          averageCostBrl: (averageCostBrl * totalBase + brlSpent) / newTotal,
          totalBase: newTotal,
        };

    logger.debug('Cost basis updated (BUY)', {
      baseAcquired: baseAcquired.toFixed(6),
      brlSpent: brlSpent.toFixed(2),
      newAvgCostBrl: ledger.base.averageCostBrl.toFixed(2),
    });

    this.save(ledger);
  }

  /**
   * Updates position after selling baseSold units for brlReceived BRL.
   * Returns realized gain in BRL (can be negative for a loss).
   */
  updateAfterSell(baseSold: number, brlReceived: number): number {
    const ledger = this.getLedger();
    const { averageCostBrl, totalBase } = ledger.base;
    const realizedGainBrl = brlReceived - averageCostBrl * baseSold;
    const newTotal = Math.max(0, totalBase - baseSold);

    // AVCO property: average cost is unchanged for remaining position
    ledger.base = {
      averageCostBrl: newTotal > 0 ? averageCostBrl : 0,
      totalBase: newTotal,
    };

    logger.debug('Cost basis updated (SELL)', {
      baseSold: baseSold.toFixed(6),
      brlReceived: brlReceived.toFixed(2),
      realizedGainBrl: realizedGainBrl.toFixed(2),
    });

    this.save(ledger);
    return realizedGainBrl;
  }

  /** Pure preview — computes realized gain without persisting. */
  computeRealizedGainBrl(baseSold: number, brlReceived: number): number {
    return brlReceived - this.getLedger().base.averageCostBrl * baseSold;
  }
}
