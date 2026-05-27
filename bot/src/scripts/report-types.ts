/** Types for the monthly performance report. */

export interface BenchmarkReturn {
  monthlyReturn: number;    // fractional (0.03 = 3%)
  cumulativeReturn: number; // fractional, from inception to month-end
  available: boolean;
  source: string;
}

export interface MonthlyMetrics {
  monthBRT: string;
  reportLabel: string;          // e.g. "May 2026"
  daysWithData: number;
  isSparse: boolean;            // true when daysWithData < 20
  startValueBrl: number;
  endValueBrl: number;
  monthlyReturnPct: number;
  solPriceStart: number;
  solPriceEnd: number;
  solOnlyReturnPct: number;     // pure buy-and-hold SOL return for the month
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
  solOnlyCumulativeReturnPct: number;
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
    solBalance: number;
    brlBalance: number;
    solPrice: number;
    totalValueBrl: number;
    averageCostBrl: number;
    unrealizedGainBrl: number;
    unrealizedGainPct: number;
  };
  trades: TradeRow[];
  generatedAt: string;
}
