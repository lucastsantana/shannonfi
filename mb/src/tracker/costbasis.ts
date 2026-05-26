import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface CostBasisLedger {
  sol: {
    averageCostBrl: number;  // average BRL paid per SOL
    totalSol: number;
  };
  lastUpdated: string;
}

const EMPTY_LEDGER: CostBasisLedger = {
  sol: { averageCostBrl: 0, totalSol: 0 },
  lastUpdated: '',
};

/**
 * Tracks average cost basis (AVCO method) for the SOL position in BRL.
 * No FX conversion needed — Mercado Bitcoin trades SOL/BRL directly.
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
      return { ...EMPTY_LEDGER, sol: { ...EMPTY_LEDGER.sol } };
    }
  }

  private save(ledger: CostBasisLedger): void {
    ledger.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(ledger, null, 2));
  }

  /**
   * Weighted average update after buying solAcquired SOL for brlSpent BRL.
   */
  updateAfterBuy(solAcquired: number, brlSpent: number): void {
    const ledger = this.getLedger();
    const { averageCostBrl, totalSol } = ledger.sol;

    const newTotal = totalSol + solAcquired;
    if (newTotal <= 0) {
      ledger.sol = { averageCostBrl: 0, totalSol: 0 };
    } else {
      const newAvgCost =
        (averageCostBrl * totalSol + brlSpent) / newTotal;
      ledger.sol = { averageCostBrl: newAvgCost, totalSol: newTotal };
    }

    logger.debug('Cost basis updated (BUY)', {
      solAcquired: solAcquired.toFixed(6),
      brlSpent: brlSpent.toFixed(2),
      newAvgCostBrl: ledger.sol.averageCostBrl.toFixed(2),
      newTotalSol: ledger.sol.totalSol.toFixed(6),
    });

    this.save(ledger);
  }

  /**
   * Updates SOL position after selling solSold SOL for brlReceived BRL.
   * Returns realized gain in BRL = (fillPrice - avgCost) * solSold.
   */
  updateAfterSell(solSold: number, brlReceived: number): number {
    const ledger = this.getLedger();
    const { averageCostBrl, totalSol } = ledger.sol;

    const costBasisForSale = averageCostBrl * solSold;
    const realizedGainBrl = brlReceived - costBasisForSale;

    const newTotal = Math.max(0, totalSol - solSold);
    // Average cost basis is unchanged for remaining position (AVCO property)
    ledger.sol = { averageCostBrl: newTotal > 0 ? averageCostBrl : 0, totalSol: newTotal };

    logger.debug('Cost basis updated (SELL)', {
      solSold: solSold.toFixed(6),
      brlReceived: brlReceived.toFixed(2),
      costBasisForSale: costBasisForSale.toFixed(2),
      realizedGainBrl: realizedGainBrl.toFixed(2),
    });

    this.save(ledger);
    return realizedGainBrl;
  }

  /**
   * Pure preview — computes realized gain without persisting.
   */
  computeRealizedGainBrl(solSold: number, brlReceived: number): number {
    const { averageCostBrl } = this.getLedger().sol;
    return brlReceived - averageCostBrl * solSold;
  }
}
