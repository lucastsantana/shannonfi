/**
 * Tax tracking service — backed by SQLite.
 * Brazilian tax compliance (Lei 9.250/1995 Art. 21) for domestic crypto trading.
 * Also dual-writes to JSON files for 15-day rolling backup.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { BR_MONTHLY_EXEMPTION_LIMIT_BRL, BR_HOLIDAYS } from '../../constants';
import { getDb } from './db';
import { loadConfig } from '../../config';

export interface TaxEvent {
  tradeId: string;
  tradeDateBRT: string;           // YYYY-MM-DD
  monthBRT: string;               // YYYY-MM
  direction: 'BUY_BASE' | 'SELL_BASE';
  tradedVolumeBrl: number;        // BRL proceeds (SELL only; 0 for BUY)
  grossProceedsBrl: number;       // same as tradedVolumeBrl
  costBasisBrl: number;           // cost basis in BRL (SELL only; 0 for BUY)
  realizedGainBrl: number;        // proceeds - costBasis (SELL only; 0 for BUY)
  cumMonthlySalesBrl: number;     // running SELL proceeds this month
  cumMonthlyGainBrl: number;      // running SELL gains this month
  exempt: boolean;                // true if cumMonthlySalesBrl <= R$35,000
  paymentDeadline: string | null; // last BR business day of following month, or null if exempt
  exchange: 'mercadobitcoin' | 'binance';
}

export interface MonthlySummary {
  monthBRT: string;
  totalSalesBrl: number;
  totalRealizedGainBrl: number;
  tradeCount: number;
  exempt: boolean;
  paymentDeadline: string | null;
}

/**
 * Tracks tax events for Brazilian compliance (Lei 9.250/1995 Art. 21).
 * Only SELL_BASE gross proceeds count toward the R$35,000 monthly exemption.
 * BUY_BASE does not count.
 */
export class TaxService {
  private db: Database.Database;
  private retentionDays: number;
  private dataDir: string;

  constructor(dbPath?: string, retentionDays: number = 15) {
    this.db = getDb(dbPath);
    this.retentionDays = retentionDays;
    // Derive data directory from dbPath to ensure isolation per instance.
    // In-memory paths (":memory:" or ":memory:?...") have no real directory —
    // path.dirname() would resolve them to the process cwd, spilling JSON
    // backups into the repo working tree during tests.
    const isInMemory = !dbPath || dbPath.startsWith(':memory:');
    const resolvedDbPath = isInMemory ? path.resolve(__dirname, '../../../data/shannonfi.db') : dbPath;
    this.dataDir = path.dirname(resolvedDbPath);

    // Warn if BR_HOLIDAYS coverage has expired
    const maxYear = Math.max(...[...BR_HOLIDAYS].map(d => parseInt(d.slice(0, 4))));
    if (new Date().getFullYear() > maxYear) {
      logger.warn('BR_HOLIDAYS may be out of date — payment deadlines may be inaccurate', {
        coverage: `through ${maxYear}`,
        currentYear: new Date().getFullYear(),
      });
    }
  }

  readEvents(): TaxEvent[] {
    const stmt = this.db.prepare('SELECT * FROM tax_events ORDER BY trade_date_brt ASC');
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      tradeId: row.trade_id,
      tradeDateBRT: row.trade_date_brt,
      monthBRT: row.month_brt,
      direction: row.direction,
      tradedVolumeBrl: row.traded_volume_brl,
      grossProceedsBrl: row.gross_proceeds_brl,
      costBasisBrl: row.cost_basis_brl,
      realizedGainBrl: row.realized_gain_brl,
      cumMonthlySalesBrl: row.cum_monthly_sales_brl,
      cumMonthlyGainBrl: row.cum_monthly_gain_brl,
      exempt: row.exempt === 1,
      paymentDeadline: row.payment_deadline,
      exchange: row.exchange,
    } as TaxEvent));
  }

  appendTaxEvent(event: TaxEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO tax_events (
        trade_id, trade_date_brt, month_brt, direction, traded_volume_brl,
        gross_proceeds_brl, cost_basis_brl, realized_gain_brl,
        cum_monthly_sales_brl, cum_monthly_gain_brl, exempt, payment_deadline, exchange
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.tradeId,
      event.tradeDateBRT,
      event.monthBRT,
      event.direction,
      event.tradedVolumeBrl,
      event.grossProceedsBrl,
      event.costBasisBrl,
      event.realizedGainBrl,
      event.cumMonthlySalesBrl,
      event.cumMonthlyGainBrl,
      event.exempt ? 1 : 0,
      event.paymentDeadline,
      event.exchange,
    );

    logger.debug('Tax event persisted', {
      tradeId: event.tradeId,
      month: event.monthBRT,
      exchange: event.exchange,
      gainBrl: event.realizedGainBrl.toFixed(2),
      exempt: event.exempt,
    });
    this.writeTaxEventsToJson();
  }

  private writeTaxEventsToJson(): void {
    if (this.retentionDays === 0) return;
    try {
      const events = this.readEvents();
      const cutoff = this.getCutoffDateBrt();
      const filtered = events.filter((e) => e.tradeDateBRT >= cutoff);
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmpPath = path.join(this.dataDir, 'tax_events.json.tmp');
      const targetPath = path.join(this.dataDir, 'tax_events.json');
      fs.writeFileSync(tmpPath, JSON.stringify(filtered, null, 2), 'utf-8');
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      logger.debug('Failed to write tax events JSON', { error: (err as Error).message });
    }
  }

  private getCutoffDateBrt(): string {
    const d = new Date();
    d.setDate(d.getDate() - this.retentionDays);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  /** Gross BRL proceeds from SELL trades this month (domestic exemption threshold). */
  getMonthlySalesBrl(monthBRT: string): number {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(traded_volume_brl), 0) as total
      FROM tax_events
      WHERE month_brt = ? AND direction = 'SELL_BASE'
    `);
    const result = stmt.get(monthBRT) as { total: number };
    return result.total;
  }

  /** Total realized gain from SELL trades this month. */
  getMonthlyGainBrl(monthBRT: string): number {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(realized_gain_brl), 0) as total
      FROM tax_events
      WHERE month_brt = ? AND direction = 'SELL_BASE'
    `);
    const result = stmt.get(monthBRT) as { total: number };
    return result.total;
  }

  getMonthlySummary(monthBRT: string): MonthlySummary {
    const stmtSells = this.db.prepare(`
      SELECT
        COALESCE(SUM(traded_volume_brl), 0) as total_sales,
        COALESCE(SUM(realized_gain_brl), 0) as total_gain
      FROM tax_events
      WHERE month_brt = ? AND direction = 'SELL_BASE'
    `);
    const sellsResult = stmtSells.get(monthBRT) as { total_sales: number; total_gain: number };

    const stmtCount = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM tax_events
      WHERE month_brt = ?
    `);
    const countResult = stmtCount.get(monthBRT) as { count: number };

    const totalSales = sellsResult.total_sales;
    const exempt = totalSales <= BR_MONTHLY_EXEMPTION_LIMIT_BRL;

    return {
      monthBRT,
      totalSalesBrl: totalSales,
      totalRealizedGainBrl: sellsResult.total_gain,
      tradeCount: countResult.count,
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
    direction: 'BUY_BASE' | 'SELL_BASE';
    tradedVolumeBrl: number;
    grossProceedsBrl: number;
    costBasisBrl: number;
    realizedGainBrl: number;
    exchange: 'mercadobitcoin' | 'binance';
  }): TaxEvent {
    const monthBRT = params.tradeDateBRT.slice(0, 7);
    const priorSales = this.getMonthlySalesBrl(monthBRT);
    const priorGain = this.getMonthlyGainBrl(monthBRT);

    const cumMonthlySalesBrl =
      params.direction === 'SELL_BASE'
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
      exchange: params.exchange,
    };
  }
}
