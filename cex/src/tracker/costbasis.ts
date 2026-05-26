import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface CostBasisLedger {
  sol: {
    averageCostBrl: number; // average BRL paid per SOL
    totalSol: number;       // total SOL held
  };
  usd: {
    averageCostBrl: number; // average BRL per USD held (FX basis)
    totalUsd: number;       // total USD held
  };
  lastUpdated: string; // ISO 8601
}

const EMPTY_LEDGER: CostBasisLedger = {
  sol: { averageCostBrl: 0, totalSol: 0 },
  usd: { averageCostBrl: 0, totalUsd: 0 },
  lastUpdated: new Date(0).toISOString(),
};

/**
 * Tracks average-cost BRL basis for SOL and USD allocations.
 * Uses AVCO (average cost) method, which is standard for Brazilian crypto tax.
 * Persists state to a JSON file so cost basis survives restarts.
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
      return { ...EMPTY_LEDGER };
    }
  }

  private saveLedger(ledger: CostBasisLedger): void {
    ledger.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.filePath, JSON.stringify(ledger, null, 2));
    logger.debug('Cost basis ledger updated', {
      solAvgBrl: ledger.sol.averageCostBrl.toFixed(4),
      totalSol: ledger.sol.totalSol.toFixed(6),
      usdAvgBrl: ledger.usd.averageCostBrl.toFixed(4),
      totalUsd: ledger.usd.totalUsd.toFixed(2),
    });
  }

  /**
   * Update cost basis after a BUY_SOL trade.
   * AVCO: new avg = (existing_cost + new_cost) / total_quantity
   */
  updateAfterBuy(solAcquired: number, usdSpent: number, usdBrlRate: number, solBrlRate: number): void {
    const ledger = this.getLedger();

    // SOL basis: weighted average of existing + newly acquired
    const existingCost = ledger.sol.averageCostBrl * ledger.sol.totalSol;
    const newCost = solAcquired * solBrlRate;
    const newTotalSol = ledger.sol.totalSol + solAcquired;
    ledger.sol.totalSol = newTotalSol;
    ledger.sol.averageCostBrl = newTotalSol > 0
      ? (existingCost + newCost) / newTotalSol
      : 0;

    // USD basis: reduce by spent amount; keep same average (FX basis unchanged)
    ledger.usd.totalUsd = Math.max(0, ledger.usd.totalUsd - usdSpent);
    // If USD balance drops to zero, reset average
    if (ledger.usd.totalUsd === 0) ledger.usd.averageCostBrl = 0;

    // Suppress unused variable warning — usdBrlRate used for symmetry with updateAfterSell
    void usdBrlRate;

    this.saveLedger(ledger);
  }

  /**
   * Update cost basis after a SELL_SOL trade.
   * Returns the realized capital gain in BRL for the sold SOL.
   */
  updateAfterSell(
    solSold: number,
    usdReceived: number,
    usdBrlRate: number,
    solBrlRate: number,
  ): number {
    const ledger = this.getLedger();

    const realizedGainBrl = this.computeRealizedGainBrl(
      solSold,
      solBrlRate,
      ledger.sol.averageCostBrl,
    );

    // Reduce SOL position
    ledger.sol.totalSol = Math.max(0, ledger.sol.totalSol - solSold);
    if (ledger.sol.totalSol === 0) ledger.sol.averageCostBrl = 0;

    // Increase USD position at current FX rate (AVCO for USD basis)
    const existingUsdCost = ledger.usd.averageCostBrl * ledger.usd.totalUsd;
    const newUsdCost = usdReceived * usdBrlRate;
    const newTotalUsd = ledger.usd.totalUsd + usdReceived;
    ledger.usd.totalUsd = newTotalUsd;
    ledger.usd.averageCostBrl = newTotalUsd > 0
      ? (existingUsdCost + newUsdCost) / newTotalUsd
      : 0;

    this.saveLedger(ledger);
    return realizedGainBrl;
  }

  /**
   * Pure function: compute realized gain without modifying state.
   * Useful for previewing the gain before deciding whether to cap the trade.
   */
  computeRealizedGainBrl(
    solSold: number,
    solBrlRate: number,
    averageCostBrl?: number,
  ): number {
    const basis = averageCostBrl ?? this.getLedger().sol.averageCostBrl;
    // Gain = (current price - average cost) * quantity sold
    return (solBrlRate - basis) * solSold;
  }
}
