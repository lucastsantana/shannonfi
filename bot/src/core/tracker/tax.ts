import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { BR_MONTHLY_EXEMPTION_LIMIT_BRL, BR_HOLIDAYS } from '../../constants';

export interface TaxEvent {
  tradeId: string;
  tradeDateBRT: string;           // YYYY-MM-DD
  monthBRT: string;               // YYYY-MM
  direction: 'BUY_SOL' | 'SELL_SOL';
  tradedVolumeBrl: number;        // BRL proceeds (SELL only; 0 for BUY)
  grossProceedsBrl: number;       // same as tradedVolumeBrl
  costBasisBrl: number;           // cost basis in BRL (SELL only; 0 for BUY)
  realizedGainBrl: number;        // proceeds - costBasis (SELL only; 0 for BUY)
  // Cumulative monthly totals used for exemption tracking
  cumMonthlySalesBrl: number;     // running SELL proceeds this month (domestic exemption basis)
  cumMonthlyVolumeBrl: number;    // running total both directions (Coinbase volume-cap basis)
  cumMonthlyGainBrl: number;      // running SELL gains this month
  exempt: boolean;                // true if cumMonthlySalesBrl <= R$35,000
  paymentDeadline: string | null; // last BR business day of following month, or null if exempt
  exchange: 'coinbase' | 'mercadobitcoin';
}

export interface MonthlySummary {
  monthBRT: string;
  totalSalesBrl: number;
  totalVolumeBrl: number;         // both directions (for Coinbase volume cap tracking)
  totalRealizedGainBrl: number;
  tradeCount: number;
  exempt: boolean;
  paymentDeadline: string | null;
}

/**
 * Append-only ledger of all rebalance trades for Brazilian tax reporting.
 *
 * Domestic exchange (Mercado Bitcoin):
 *   Only SELL_SOL gross proceeds count toward the R$35,000 monthly exemption
 *   (Lei 9.250/1995 Art. 21). BUY_SOL does not count.
 *
 * Foreign exchange (Coinbase):
 *   Lei 14.754/2023 applies — flat 15% annual rate, no monthly exemption.
 *   cumMonthlyVolumeBrl (both directions) is tracked for the discretionary
 *   volume cap when neverExceedExemptionLimit=true.
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
      exchange: event.exchange,
      gainBrl: event.realizedGainBrl.toFixed(2),
      exempt: event.exempt,
    });
  }

  /** Gross BRL proceeds from SELL trades this month (domestic exemption threshold). */
  getMonthlySalesBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT && e.direction === 'SELL_SOL')
      .reduce((s, e) => s + e.tradedVolumeBrl, 0);
  }

  /** Total BRL traded volume both directions (Coinbase volume-cap tracking). */
  getMonthlyVolumeBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT)
      .reduce((s, e) => s + e.tradedVolumeBrl, 0);
  }

  getMonthlyGainBrl(monthBRT: string): number {
    return this.readEvents()
      .filter((e) => e.monthBRT === monthBRT && e.direction === 'SELL_SOL')
      .reduce((s, e) => s + e.realizedGainBrl, 0);
  }

  getMonthlySummary(monthBRT: string): MonthlySummary {
    const events = this.readEvents().filter((e) => e.monthBRT === monthBRT);
    const sells = events.filter((e) => e.direction === 'SELL_SOL');
    const totalSales = sells.reduce((s, e) => s + e.tradedVolumeBrl, 0);
    const totalVolume = events.reduce((s, e) => s + e.tradedVolumeBrl, 0);
    const totalGain = sells.reduce((s, e) => s + e.realizedGainBrl, 0);
    const exempt = totalSales <= BR_MONTHLY_EXEMPTION_LIMIT_BRL;
    return {
      monthBRT,
      totalSalesBrl: totalSales,
      totalVolumeBrl: totalVolume,
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
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const lastDay = new Date(nextYear, nextMonth, 0).getDate();
    for (let d = lastDay; d >= 1; d--) {
      const dateStr = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
      if (dow !== 0 && dow !== 6 && !BR_HOLIDAYS.has(dateStr)) return dateStr;
    }
    return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
  }

  buildTaxEvent(params: {
    tradeId: string;
    tradeDateBRT: string;
    direction: 'BUY_SOL' | 'SELL_SOL';
    tradedVolumeBrl: number;
    grossProceedsBrl: number;
    costBasisBrl: number;
    realizedGainBrl: number;
    exchange: 'coinbase' | 'mercadobitcoin';
  }): TaxEvent {
    const monthBRT = params.tradeDateBRT.slice(0, 7);
    const priorSales = this.getMonthlySalesBrl(monthBRT);
    const priorVolume = this.getMonthlyVolumeBrl(monthBRT);
    const priorGain = this.getMonthlyGainBrl(monthBRT);

    const cumMonthlySalesBrl =
      params.direction === 'SELL_SOL' ? priorSales + params.tradedVolumeBrl : priorSales;
    const cumMonthlyVolumeBrl = priorVolume + params.tradedVolumeBrl;
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
      cumMonthlyVolumeBrl,
      cumMonthlyGainBrl,
      exempt,
      paymentDeadline: exempt ? null : this.computePaymentDeadline(monthBRT),
      exchange: params.exchange,
    };
  }
}
