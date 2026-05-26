import { PortfolioSnapshot, TradeRecord } from '../../adapters/types';
import { TradeHistoryService } from './history';
import { logger } from './logger';

export interface TrackRecordMetrics {
  periodStart: string;
  periodEnd: string;
  totalDays: number;
  totalReturnBrlPct: number;
  cagr: number | null;
  maxDrawdownPct: number;
  sharpeRatio: number | null;
  totalRebalances: number;
  totalFeesBrl: number;
  avgDaysBetweenRebalances: number | null;
  daysSinceLastRebalance: number | null;
  lastRebalanceDate: string | null;
}

export class MetricsService {
  constructor(private history: TradeHistoryService) {}

  computeMetrics(snapshots: PortfolioSnapshot[]): TrackRecordMetrics {
    const trades = this.history.readTrades();
    const filled = trades.filter(
      (t): t is TradeRecord =>
        t.status === 'FILLED' || t.status === 'DRY_RUN',
    );
    const sorted = [...snapshots].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (sorted.length === 0) return this.emptyMetrics();

    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const initialBrl = first.totalValueBrl;
    const finalBrl = last.totalValueBrl;

    const totalDays = Math.max(
      1,
      Math.round(
        (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 86_400_000,
      ),
    );

    const totalReturnBrlPct = initialBrl > 0 ? ((finalBrl - initialBrl) / initialBrl) * 100 : 0;
    const cagr =
      initialBrl > 0 && totalDays > 0
        ? (Math.pow(finalBrl / initialBrl, 365 / totalDays) - 1) * 100
        : null;

    const values = sorted.map((s) => s.totalValueBrl);
    const maxDrawdownPct = this.computeMaxDrawdown(values);
    const sharpeRatio = this.computeSharpe(values);

    const totalFeesBrl = filled.reduce((s, t) => s + (t.feeBrl ?? 0), 0);
    const rebalanceDates = filled
      .map((t) => new Date(t.timestamp).getTime())
      .sort((a, b) => a - b);

    let avgDaysBetweenRebalances: number | null = null;
    if (rebalanceDates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < rebalanceDates.length; i++) {
        gaps.push((rebalanceDates[i]! - rebalanceDates[i - 1]!) / 86_400_000);
      }
      avgDaysBetweenRebalances = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    }

    const lastRebalance = filled.length > 0 ? filled[filled.length - 1]! : null;
    const daysSinceLastRebalance = lastRebalance
      ? (Date.now() - new Date(lastRebalance.timestamp).getTime()) / 86_400_000
      : null;

    return {
      periodStart: first.timestamp,
      periodEnd: last.timestamp,
      totalDays,
      totalReturnBrlPct,
      cagr,
      maxDrawdownPct,
      sharpeRatio,
      totalRebalances: filled.length,
      totalFeesBrl,
      avgDaysBetweenRebalances,
      daysSinceLastRebalance,
      lastRebalanceDate: lastRebalance?.timestamp ?? null,
    };
  }

  private computeMaxDrawdown(values: number[]): number {
    if (values.length === 0) return 0;
    let peak = values[0]!;
    let maxDD = 0;
    for (const v of values) {
      if (v > peak) peak = v;
      const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }
    return maxDD;
  }

  private computeSharpe(values: number[]): number | null {
    if (values.length < 3) return null;
    const returns: number[] = [];
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]!;
      if (prev <= 0) continue;
      returns.push((values[i]! - prev) / prev);
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance =
      returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return null;
    return (mean / stdDev) * Math.sqrt(365);
  }

  private emptyMetrics(): TrackRecordMetrics {
    return {
      periodStart: '',
      periodEnd: '',
      totalDays: 0,
      totalReturnBrlPct: 0,
      cagr: null,
      maxDrawdownPct: 0,
      sharpeRatio: null,
      totalRebalances: 0,
      totalFeesBrl: 0,
      avgDaysBetweenRebalances: null,
      daysSinceLastRebalance: null,
      lastRebalanceDate: null,
    };
  }

  printReport(snapshots: PortfolioSnapshot[]): void {
    const m = this.computeMetrics(snapshots);
    const trades = this.history.readTrades();
    const filled = trades.filter(
      (t) => t.status === 'FILLED' || t.status === 'DRY_RUN',
    );

    if (snapshots.length === 0 && filled.length === 0) {
      logger.info('No data to report');
      return;
    }

    const sign = (n: number) => (n >= 0 ? '+' : '');
    console.log("\n=== Shannon's Demon — Track Record ===");
    console.log(`Period:               ${m.periodStart.slice(0, 10)} → ${m.periodEnd.slice(0, 10)} (${m.totalDays}d)`);
    console.log(`Return (BRL):         ${sign(m.totalReturnBrlPct)}${m.totalReturnBrlPct.toFixed(2)}%`);
    if (m.cagr != null) console.log(`CAGR (BRL):           ${sign(m.cagr)}${m.cagr.toFixed(2)}%`);
    console.log(`Max Drawdown:         -${m.maxDrawdownPct.toFixed(2)}%`);
    if (m.sharpeRatio != null) console.log(`Sharpe Ratio:         ${m.sharpeRatio.toFixed(3)}`);
    console.log(`Rebalances:           ${m.totalRebalances}`);
    console.log(`Total Fees (BRL):     R$${m.totalFeesBrl.toFixed(2)}`);
    if (m.avgDaysBetweenRebalances != null) {
      console.log(`Avg Days/Rebalance:   ${m.avgDaysBetweenRebalances.toFixed(1)}`);
    }
    if (m.daysSinceLastRebalance != null) {
      console.log(`Days Since Last:      ${m.daysSinceLastRebalance.toFixed(1)}`);
    }
    console.log('='.repeat(50));
  }
}
