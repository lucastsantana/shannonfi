/** Types for the monthly performance report. */

import { BenchmarkReturn } from '../../bot/src/core/benchmarks';

export type { BenchmarkReturn };

export interface MonthlyMetrics {
  monthBRT: string;
  reportLabel: string;          // e.g. "May 2026"
  daysWithData: number;
  isSparse: boolean;            // true when daysWithData < 20
  startValueBrl: number;
  endValueBrl: number;
  monthlyReturnPct: number;
  basePriceStart: number;
  basePriceEnd: number;
  baseOnlyReturnPct: number;    // pure buy-and-hold base asset return for the month
  rebalanceCount: number;
  totalFeesBrl: number;
  buyCount: number;
  sellCount: number;
  maxDrawdownPct: number;
}

export interface CumulativeMetrics {
  inceptionDate: string;
  totalDays: number;
  totalReturnPct: number;
  baseOnlyCumulativeReturnPct: number;
  cagr: number | null;
  sharpeRatio: number | null;
  maxDrawdownPct: number;
  totalRebalances: number;
  totalFeesBrl: number;
}

export interface TradeRow {
  date: string;
  direction: string;
  brlAmount: number;
  fillPrice: number;
  feeBrl: number;
  realizedGainBrl: number | null;
  driftBeforePct: number;
}

export interface ReportPayload {
  monthBRT: string;
  monthly: MonthlyMetrics;
  cumulative: CumulativeMetrics;
  benchmarks: {
    cdi: BenchmarkReturn;
    ibov: BenchmarkReturn;
  };
  taxSummary: {
    totalSalesBrl: number;
    totalRealizedGainBrl: number;
    tradeCount: number;
    exempt: boolean;
    paymentDeadline: string | null;
  };
  portfolio: {
    baseBalance: number;
    brlBalance: number;
    basePrice: number;
    totalValueBrl: number;
    averageCostBrl: number;
    unrealizedGainBrl: number;
    unrealizedGainPct: number;
  };
  trades: TradeRow[];
  generatedAt: string;
}
