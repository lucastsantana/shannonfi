/**
 * Cost basis service — backed by SQLite.
 * Tracks AVCO (average cost) basis for the SOL position in BRL.
 * Also dual-writes to JSON files for 15-day rolling backup.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { getDb } from './db';
import { loadConfig } from '../../config';

const DATA_DIR = path.resolve(__dirname, '../../../data');

export interface CostBasisLedger {
  sol: {
    averageCostBrl: number;
    totalSol: number;
  };
  lastUpdated: string;
}

export class CostBasisService {
  private db: Database.Database;
  private retentionDays: number;

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
    try {
      const config = loadConfig();
      this.retentionDays = config.jsonRetentionDays ?? 15;
    } catch {
      this.retentionDays = 15; // default
    }
  }

  getLedger(): CostBasisLedger {
    const stmt = this.db.prepare(
      'SELECT average_cost_brl, total_sol, last_updated FROM cost_basis WHERE asset = ?'
    );
    const row = stmt.get('SOL') as {
      average_cost_brl: number;
      total_sol: number;
      last_updated: string;
    } | undefined;

    if (!row) {
      return { sol: { averageCostBrl: 0, totalSol: 0 }, lastUpdated: '' };
    }

    return {
      sol: {
        averageCostBrl: row.average_cost_brl,
        totalSol: row.total_sol,
      },
      lastUpdated: row.last_updated,
    };
  }

  private save(ledger: CostBasisLedger): void {
    const lastUpdated = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE cost_basis
      SET average_cost_brl = ?, total_sol = ?, last_updated = ?
      WHERE asset = 'SOL'
    `);
    stmt.run(ledger.sol.averageCostBrl, ledger.sol.totalSol, lastUpdated);
    this.writeCostBasisToJson(ledger);
  }

  private writeCostBasisToJson(ledger: CostBasisLedger): void {
    if (this.retentionDays === 0) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'cost_basis.json'), JSON.stringify(ledger, null, 2), 'utf-8');
    } catch (err) {
      logger.debug('Failed to write cost basis JSON', { error: (err as Error).message });
    }
  }

  /** Weighted average update after buying solAcquired SOL for brlSpent BRL. */
  updateAfterBuy(solAcquired: number, brlSpent: number): void {
    const ledger = this.getLedger();
    const { averageCostBrl, totalSol } = ledger.sol;
    const newTotal = totalSol + solAcquired;

    ledger.sol = newTotal <= 0
      ? { averageCostBrl: 0, totalSol: 0 }
      : {
          averageCostBrl: (averageCostBrl * totalSol + brlSpent) / newTotal,
          totalSol: newTotal,
        };

    logger.debug('Cost basis updated (BUY)', {
      solAcquired: solAcquired.toFixed(6),
      brlSpent: brlSpent.toFixed(2),
      newAvgCostBrl: ledger.sol.averageCostBrl.toFixed(2),
    });

    this.save(ledger);
  }

  /**
   * Updates SOL position after selling solSold SOL for brlReceived BRL.
   * Returns realized gain in BRL (can be negative for a loss).
   */
  updateAfterSell(solSold: number, brlReceived: number): number {
    const ledger = this.getLedger();
    const { averageCostBrl, totalSol } = ledger.sol;
    const realizedGainBrl = brlReceived - averageCostBrl * solSold;
    const newTotal = Math.max(0, totalSol - solSold);

    // AVCO property: average cost is unchanged for remaining position
    ledger.sol = {
      averageCostBrl: newTotal > 0 ? averageCostBrl : 0,
      totalSol: newTotal,
    };

    logger.debug('Cost basis updated (SELL)', {
      solSold: solSold.toFixed(6),
      brlReceived: brlReceived.toFixed(2),
      realizedGainBrl: realizedGainBrl.toFixed(2),
    });

    this.save(ledger);
    return realizedGainBrl;
  }

  /** Pure preview — computes realized gain without persisting. */
  computeRealizedGainBrl(solSold: number, brlReceived: number): number {
    return brlReceived - this.getLedger().sol.averageCostBrl * solSold;
  }
}
