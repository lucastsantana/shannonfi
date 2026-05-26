import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import {
  BR_MONTHLY_EXEMPTION_LIMIT_BRL,
  BR_HOLIDAYS,
} from '../constants';

export interface TaxEvent {
  tradeId: string;
  tradeDateBRT: string;         // YYYY-MM-DD
  monthBRT: string;             // YYYY-MM
  direction: 'BUY_SOL' | 'SELL_SOL';
  grossProceedsBrl: number;     // Gross BRL value of sold SOL (solSold * solBrlRate)
  costBasisBrl: number;         // Cost basis of the sold SOL in BRL
  realizedGainBrl: number;      // Net gain = grossProceeds - costBasis
  cumMonthlyGainBrl: number;    // Running cumulative gain for the month
  exempt: boolean;              // true if cumMonthlyGain ≤ R$35,000
  paymentDeadline: string | null; // Last BR business day of following month, or null if exempt
}

export interface MonthlySummary {
  monthBRT: string;
  totalRealizedGainBrl: number;
  totalGrossProceedsBrl: number;
  tradeCount: number;
  exempt: boolean;
  paymentDeadline: string | null;
}

/**
 * Manages an append-only ledger of realized capital gain events for Brazilian tax reporting.
 * Only SELL_SOL trades are recorded (purchases do not realize gains under Brazilian law).
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

  /** Total gross BRL proceeds of SELL_SOL trades in the given month. */
  getMonthlyVolumeBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT && e.direction === 'SELL_SOL')
      .reduce((sum, e) => sum + e.grossProceedsBrl, 0);
  }

  /** Cumulative realized gain for the given month. */
  getMonthlyGainBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT && e.direction === 'SELL_SOL')
      .reduce((sum, e) => sum + e.realizedGainBrl, 0);
  }

  getMonthlySummary(monthBRT: string): MonthlySummary {
    const events = this.readEvents().filter(
      (e) => e.monthBRT === monthBRT && e.direction === 'SELL_SOL',
    );
    const totalGain = events.reduce((s, e) => s + e.realizedGainBrl, 0);
    const totalVolume = events.reduce((s, e) => s + e.grossProceedsBrl, 0);
    const exempt = totalGain <= BR_MONTHLY_EXEMPTION_LIMIT_BRL;
    return {
      monthBRT,
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

  /** Build a TaxEvent record given the trade details. Computes cumulative totals. */
  buildTaxEvent(params: {
    tradeId: string;
    tradeDateBRT: string;
    direction: 'BUY_SOL' | 'SELL_SOL';
    grossProceedsBrl: number;
    costBasisBrl: number;
    realizedGainBrl: number;
  }): TaxEvent {
    const monthBRT = params.tradeDateBRT.slice(0, 7); // "YYYY-MM"
    const priorMonthlyGain = this.getMonthlyGainBrl(monthBRT);
    const cumMonthlyGainBrl = priorMonthlyGain + params.realizedGainBrl;
    const exempt = cumMonthlyGainBrl <= BR_MONTHLY_EXEMPTION_LIMIT_BRL;
    return {
      tradeId: params.tradeId,
      tradeDateBRT: params.tradeDateBRT,
      monthBRT,
      direction: params.direction,
      grossProceedsBrl: params.grossProceedsBrl,
      costBasisBrl: params.costBasisBrl,
      realizedGainBrl: params.realizedGainBrl,
      cumMonthlyGainBrl,
      exempt,
      paymentDeadline: exempt ? null : this.computePaymentDeadline(monthBRT),
    };
  }
}
