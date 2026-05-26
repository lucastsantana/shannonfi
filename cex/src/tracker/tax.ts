import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import {
  BR_MONTHLY_EXEMPTION_LIMIT_BRL,
  BR_HOLIDAYS,
} from '../constants';

export interface TaxEvent {
  tradeId: string;
  tradeDateBRT: string;          // YYYY-MM-DD
  monthBRT: string;              // YYYY-MM
  direction: 'BUY_SOL' | 'SELL_SOL';
  tradedVolumeBrl: number;       // BRL value of the trade: solQty*solBrlRate (SELL) or usdQty*usdBrlRate (BUY)
  tradedVolumeUsd: number;       // USD value of the trade (for reference)
  grossProceedsBrl: number;      // Same as tradedVolumeBrl (kept for SELL compatibility; 0 for BUY)
  costBasisBrl: number;          // Cost basis of the sold SOL in BRL (SELL only; 0 for BUY)
  realizedGainBrl: number;       // Net gain = grossProceeds - costBasis (SELL only; 0 for BUY)
  cumMonthlyVolumeBrl: number;   // Running cumulative traded volume for the month (both directions)
  cumMonthlyGainBrl: number;     // Running cumulative gain for the month (SELL only)
  exempt: boolean;               // true if cumMonthlyVolume ≤ R$35,000
  paymentDeadline: string | null; // Last BR business day of following month, or null if exempt
}

export interface MonthlySummary {
  monthBRT: string;
  totalTradedVolumeBrl: number;  // All trades (both directions) counted toward the R$35k limit
  totalRealizedGainBrl: number;  // Only SELL_SOL trades
  totalGrossProceedsBrl: number; // Alias for totalTradedVolumeBrl (backwards compat)
  tradeCount: number;
  exempt: boolean;
  paymentDeadline: string | null;
}

/**
 * Manages an append-only ledger of all rebalance trades for Brazilian tax reporting.
 * Both BUY_SOL and SELL_SOL count toward the R$35,000 monthly traded-volume exemption.
 * Realized gains (for capital gains tax) are computed only on SELL_SOL trades.
 */
export class TaxService {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([], null, 2));
    }
  }

  readEvents(): TaxEvent[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as TaxEvent[];
    } catch {
      return [];
    }
  }

  appendTaxEvent(event: TaxEvent): void {
    const events = this.readEvents();
    events.push(event);
    fs.writeFileSync(this.filePath, JSON.stringify(events, null, 2));
    logger.debug('Tax event persisted', {
      tradeId: event.tradeId,
      month: event.monthBRT,
      gainBrl: event.realizedGainBrl.toFixed(2),
      exempt: event.exempt,
    });
  }

  /**
   * Total BRL traded volume for the month — both BUY_SOL and SELL_SOL count
   * toward the R$35,000 monthly exemption limit under Brazilian law.
   */
  getMonthlyVolumeBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT)
      .reduce((sum, e) => sum + e.tradedVolumeBrl, 0);
  }

  /** Cumulative realized gain for the month (SELL_SOL only). */
  getMonthlyGainBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT && e.direction === 'SELL_SOL')
      .reduce((sum, e) => sum + e.realizedGainBrl, 0);
  }

  getMonthlySummary(monthBRT: string): MonthlySummary {
    const events = this.readEvents().filter((e) => e.monthBRT === monthBRT);
    const totalVolume = events.reduce((s, e) => s + e.tradedVolumeBrl, 0);
    const totalGain = events
      .filter((e) => e.direction === 'SELL_SOL')
      .reduce((s, e) => s + e.realizedGainBrl, 0);
    const exempt = totalVolume <= BR_MONTHLY_EXEMPTION_LIMIT_BRL;
    return {
      monthBRT,
      totalTradedVolumeBrl: totalVolume,
      totalRealizedGainBrl: totalGain,
      totalGrossProceedsBrl: totalVolume,
      tradeCount: events.length,
      exempt,
      paymentDeadline: exempt ? null : this.computePaymentDeadline(monthBRT),
    };
  }

  /**
   * Returns the last Brazilian business day of the month following monthBRT.
   * monthBRT format: "YYYY-MM"
   */
  computePaymentDeadline(monthBRT: string): string {
    const [yearStr, monthStr] = monthBRT.split('-') as [string, string];
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10); // 1-indexed

    // Following month
    const followingMonth = month === 12 ? 1 : month + 1;
    const followingYear = month === 12 ? year + 1 : year;

    // Last day of the following month
    const lastDay = new Date(followingYear, followingMonth, 0).getDate();

    // Walk back from the last day until we find a business day
    let candidate = lastDay;
    while (candidate >= 1) {
      const dateStr = `${String(followingYear).padStart(4, '0')}-${String(followingMonth).padStart(2, '0')}-${String(candidate).padStart(2, '0')}`;
      const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=Sun,6=Sat
      if (dow !== 0 && dow !== 6 && !BR_HOLIDAYS.has(dateStr)) {
        return dateStr;
      }
      candidate--;
    }
    // Fallback: should never happen for a valid month
    return `${String(followingYear).padStart(4, '0')}-${String(followingMonth).padStart(2, '0')}-01`;
  }

  /**
   * Build a TaxEvent for any trade direction.
   * tradedVolumeBrl: for SELL_SOL = solQty * solBrlRate; for BUY_SOL = usdQty * usdBrlRate.
   * tradedVolumeUsd: the USD notional of the trade (for reference).
   * grossProceedsBrl / costBasisBrl / realizedGainBrl: only meaningful for SELL_SOL (pass 0 for BUY).
   */
  buildTaxEvent(params: {
    tradeId: string;
    tradeDateBRT: string;
    direction: 'BUY_SOL' | 'SELL_SOL';
    tradedVolumeBrl: number;
    tradedVolumeUsd: number;
    grossProceedsBrl: number;
    costBasisBrl: number;
    realizedGainBrl: number;
  }): TaxEvent {
    const monthBRT = params.tradeDateBRT.slice(0, 7); // "YYYY-MM"
    const priorMonthlyVolume = this.getMonthlyVolumeBrl(monthBRT);
    const cumMonthlyVolumeBrl = priorMonthlyVolume + params.tradedVolumeBrl;
    const priorMonthlyGain = this.getMonthlyGainBrl(monthBRT);
    const cumMonthlyGainBrl = priorMonthlyGain + params.realizedGainBrl;
    // Exemption is based on total traded volume, not just gains
    const exempt = cumMonthlyVolumeBrl <= BR_MONTHLY_EXEMPTION_LIMIT_BRL;
    return {
      tradeId: params.tradeId,
      tradeDateBRT: params.tradeDateBRT,
      monthBRT,
      direction: params.direction,
      tradedVolumeBrl: params.tradedVolumeBrl,
      tradedVolumeUsd: params.tradedVolumeUsd,
      grossProceedsBrl: params.grossProceedsBrl,
      costBasisBrl: params.costBasisBrl,
      realizedGainBrl: params.realizedGainBrl,
      cumMonthlyVolumeBrl,
      cumMonthlyGainBrl,
      exempt,
      paymentDeadline: exempt ? null : this.computePaymentDeadline(monthBRT),
    };
  }
}
