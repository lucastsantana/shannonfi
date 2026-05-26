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
  tradedVolumeBrl: number;       // gross BRL proceeds (SELL only; 0 for BUY)
  grossProceedsBrl: number;      // same as tradedVolumeBrl
  costBasisBrl: number;          // cost basis of sold SOL in BRL (SELL only; 0 for BUY)
  realizedGainBrl: number;       // proceeds - costBasis (SELL only; 0 for BUY)
  cumMonthlySalesBrl: number;    // running total of SELL proceeds this month
  cumMonthlyGainBrl: number;     // running total of SELL gains this month
  exempt: boolean;               // true if cumMonthlySalesBrl <= R$35,000
  paymentDeadline: string | null; // last BR business day of following month, or null if exempt
}

export interface MonthlySummary {
  monthBRT: string;
  totalSalesBrl: number;         // gross proceeds of SELL_SOL trades only
  totalRealizedGainBrl: number;
  tradeCount: number;
  exempt: boolean;
  paymentDeadline: string | null;
}

/**
 * Manages an append-only ledger of trades for Brazilian tax reporting.
 *
 * Under Brazilian domestic exchange rules (Lei 9.250/1995 Art. 21):
 * - Only SELL_SOL trades (alienações) count toward the R$35,000 monthly exemption
 * - BUY_SOL purchases do NOT count toward the exemption threshold
 * - If total monthly sales exceed R$35,000, the entire month's gains are taxable
 * - Tax is due by the last business day of the following month (via DARF)
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
      direction: event.direction,
      gainBrl: event.realizedGainBrl.toFixed(2),
      exempt: event.exempt,
    });
  }

  /**
   * Total gross BRL proceeds from SELL_SOL trades this month.
   * Only sales count toward the R$35,000 exemption threshold.
   */
  getMonthlySalesBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT && e.direction === 'SELL_SOL')
      .reduce((sum, e) => sum + e.tradedVolumeBrl, 0);
  }

  getMonthlyGainBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT && e.direction === 'SELL_SOL')
      .reduce((sum, e) => sum + e.realizedGainBrl, 0);
  }

  getMonthlySummary(monthBRT: string): MonthlySummary {
    const events = this.readEvents().filter((e) => e.monthBRT === monthBRT);
    const sells = events.filter((e) => e.direction === 'SELL_SOL');
    const totalSales = sells.reduce((s, e) => s + e.tradedVolumeBrl, 0);
    const totalGain = sells.reduce((s, e) => s + e.realizedGainBrl, 0);
    const exempt = totalSales <= BR_MONTHLY_EXEMPTION_LIMIT_BRL;
    return {
      monthBRT,
      totalSalesBrl: totalSales,
      totalRealizedGainBrl: totalGain,
      tradeCount: events.length,
      exempt,
      paymentDeadline: exempt ? null : this.computePaymentDeadline(monthBRT),
    };
  }

  computePaymentDeadline(monthBRT: string): string {
    const [yearStr, monthStr] = monthBRT.split('-') as [string, string];
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const followingMonth = month === 12 ? 1 : month + 1;
    const followingYear = month === 12 ? year + 1 : year;

    const lastDay = new Date(followingYear, followingMonth, 0).getDate();

    let candidate = lastDay;
    while (candidate >= 1) {
      const dateStr = `${String(followingYear).padStart(4, '0')}-${String(followingMonth).padStart(2, '0')}-${String(candidate).padStart(2, '0')}`;
      const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
      if (dow !== 0 && dow !== 6 && !BR_HOLIDAYS.has(dateStr)) {
        return dateStr;
      }
      candidate--;
    }
    return `${String(followingYear).padStart(4, '0')}-${String(followingMonth).padStart(2, '0')}-01`;
  }

  buildTaxEvent(params: {
    tradeId: string;
    tradeDateBRT: string;
    direction: 'BUY_SOL' | 'SELL_SOL';
    tradedVolumeBrl: number;    // 0 for BUY
    grossProceedsBrl: number;   // 0 for BUY
    costBasisBrl: number;       // 0 for BUY
    realizedGainBrl: number;    // 0 for BUY
  }): TaxEvent {
    const monthBRT = params.tradeDateBRT.slice(0, 7);
    const priorSales = this.getMonthlySalesBrl(monthBRT);
    const priorGain = this.getMonthlyGainBrl(monthBRT);

    // Only SELL trades count toward the exemption limit
    const cumMonthlySalesBrl =
      params.direction === 'SELL_SOL'
        ? priorSales + params.tradedVolumeBrl
        : priorSales;

    const cumMonthlyGainBrl = priorGain + params.realizedGainBrl;
    const exempt = cumMonthlySalesBrl <= BR_MONTHLY_EXEMPTION_LIMIT_BRL;

    return {
      tradeId: params.tradeId,
      tradeDateBRT: params.tradeDateBRT,
      monthBRT,
      direction: params.direction,
      tradedVolumeBrl: params.tradedVolumeBrl,
      grossProceedsBrl: params.grossProceedsBrl,
      costBasisBrl: params.costBasisBrl,
      realizedGainBrl: params.realizedGainBrl,
      cumMonthlySalesBrl,
      cumMonthlyGainBrl,
      exempt,
      paymentDeadline: exempt ? null : this.computePaymentDeadline(monthBRT),
    };
  }
}
