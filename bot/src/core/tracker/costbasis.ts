import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface CostBasisLedger {
  sol: {
    averageCostBrl: number;  // BRL paid per SOL on average (AVCO method)
    totalSol: number;
  };
  lastUpdated: string;
}

const EMPTY_LEDGER: CostBasisLedger = {
  sol: { averageCostBrl: 0, totalSol: 0 },
  lastUpdated: '',
};

/**
 * Tracks AVCO (average cost) basis for the SOL position in BRL.
 *
 * Always receives BRL amounts — the Coinbase adapter converts USD→BRL before
 * calling these methods, so this service never needs to know about USD.
 */
export class CostBasisService {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(EMPTY_LEDGER, null, 2));
    }
  }

  getLedger(): CostBasisLedger {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as CostBasisLedger;
    } catch {
      return { sol: { averageCostBrl: 0, totalSol: 0 }, lastUpdated: '' };
    }
  }

  private save(ledger: CostBasisLedger): void {
    ledger.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(ledger, null, 2));
  }

  /** Weighted average update after buying solAcquired SOL for brlSpent BRL. */
  updateAfterBuy(solAcquired: number, brlSpent: number): void {
    const ledger = this.getLedger();
    const { averageCostBrl, totalSol } = ledger.sol;
    const newTotal = totalSol + solAcquired;
    ledger.sol = newTotal <= 0
      ? { averageCostBrl: 0, totalSol: 0 }
      : { averageCostBrl: (averageCostBrl * totalSol + brlSpent) / newTotal, totalSol: newTotal };
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
    ledger.sol = { averageCostBrl: newTotal > 0 ? averageCostBrl : 0, totalSol: newTotal };
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
