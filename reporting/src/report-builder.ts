/**
 * Shared report data builder and commentary generator.
 * Used by both monthly-report.ts (Markdown) and pdf-report.ts (PDF).
 */

import { TradeHistoryService } from '../../bot/src/core/tracker/history';
import { TaxService } from '../../bot/src/core/tracker/tax';
import { CostBasisService } from '../../bot/src/core/tracker/costbasis';
import { MetricsService } from '../../bot/src/core/tracker/metrics';
import { BenchmarksService } from '../../bot/src/core/benchmarks';
import { loadConfig } from '../../bot/src/config';
import {
  ReportPayload, MonthlyMetrics, CumulativeMetrics, TradeRow, BenchmarkReturn,
} from './report-types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getPreviousMonthBRT(): string {
  const brtNow = new Date(new Date().toLocaleString('en-CA', { timeZone: 'America/Sao_Paulo' }));
  const y = brtNow.getFullYear();
  const m = brtNow.getMonth(); // 0-indexed
  if (m === 0) return `${y - 1}-12`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function monthLastDay(monthBRT: string): string {
  const [y, m] = monthBRT.split('-').map(Number);
  const last = new Date(y!, m!, 0); // day 0 of next month = last day of this month
  return `${y}-${String(m).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

export function fmtPct(n: number, decimals = 2): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

export function fmtBrl(n: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
}

/**
 * Walks backward from `endIdx` to find the start of the contiguous run of snapshots
 * sharing the same base asset as the snapshot at `endIdx` — i.e. the start of the
 * current "asset epoch." Snapshots with a null baseAsset (pre-rotation-support
 * history) are treated as `fallbackAsset`, so instances that have never rotated get
 * back the full original range (snapshots[0]), unchanged from before this existed.
 */
function findAssetEpochStart(
  snapshots: { baseAsset: string | null }[],
  endIdx: number,
  fallbackAsset: string,
): number {
  const endAsset = snapshots[endIdx]!.baseAsset ?? fallbackAsset;
  let startIdx = endIdx;
  while (startIdx > 0 && (snapshots[startIdx - 1]!.baseAsset ?? fallbackAsset) === endAsset) {
    startIdx--;
  }
  return startIdx;
}

export function computeMaxDrawdown(values: number[]): number {
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

// ─── Rule-based commentary ────────────────────────────────────────────────────

export function generateCommentary(p: ReportPayload): string {
  const { monthly, cumulative, benchmarks, taxSummary, portfolio } = p;
  const base = p.baseAsset;
  const pair = `${base}/BRL`;
  const paragraphs: string[] = [];

  // ── Paragraph 1: Overall performance this month ───────────────────────────
  const portfolioVsBase = monthly.monthlyReturnPct - monthly.baseOnlyReturnPct;
  let p1: string;
  if (monthly.isSparse) {
    p1 = `This report covers a partial month with only ${monthly.daysWithData} days of portfolio data, ` +
      `so figures should be interpreted with caution. ` +
      `The strategy recorded a return of ${fmtPct(monthly.monthlyReturnPct)} over the available period, ` +
      `while ${pair} moved ${fmtPct(monthly.baseOnlyReturnPct)} over the same window.`;
  } else if (Math.abs(portfolioVsBase) < 0.5) {
    p1 = `Shannon's Demon tracked closely with ${base}'s raw price move this month, ` +
      `with the portfolio returning ${fmtPct(monthly.monthlyReturnPct)} against a ${fmtPct(monthly.baseOnlyReturnPct)} ` +
      `move in ${pair}. When the two figures are this close it typically indicates a directional ` +
      `market where mean-reversion opportunities were limited — the strategy's edge comes from ` +
      `harvesting volatility around a mean, not from trending periods.`;
  } else if (portfolioVsBase > 0) {
    p1 = `The strategy outperformed a passive ${base} position this month, returning ` +
      `${fmtPct(monthly.monthlyReturnPct)} against a ${fmtPct(monthly.baseOnlyReturnPct)} move in ${pair}. ` +
      `This is the core Shannon's Demon effect: rebalancing captured the spread between ${base} price ` +
      `oscillations and the stable BRL leg, converting volatility into portfolio gains above what ` +
      `either asset delivered on its own.`;
  } else {
    p1 = `${base} outpaced the balanced portfolio this month — ${pair} moved ${fmtPct(monthly.baseOnlyReturnPct)} ` +
      `while the strategy returned ${fmtPct(monthly.monthlyReturnPct)}. This is expected during strongly ` +
      `trending periods: the 50/50 rebalancing discipline trims the winning asset as it rises, ` +
      `reducing upside participation in exchange for lower drawdown. The cost of that protection ` +
      `shows up in months like this one.`;
  }
  paragraphs.push(p1);

  // ── Paragraph 2: Benchmark context (CDI / IBOV) ───────────────────────────
  const hasCdi = benchmarks.cdi.available;
  const hasIbov = benchmarks.ibov.available;
  if (hasCdi || hasIbov) {
    const parts: string[] = [];
    if (hasCdi) {
      const cdiPct = benchmarks.cdi.monthlyReturn * 100;
      const vsRiskFree = monthly.monthlyReturnPct - cdiPct;
      if (vsRiskFree > 0.5) {
        parts.push(`The portfolio beat the CDI (Brazil's interbank risk-free rate) by ${fmtPct(vsRiskFree)}, ` +
          `meaning the strategy delivered a positive real spread over simply holding cash in a fixed-income fund this month.`);
      } else if (vsRiskFree < -0.5) {
        parts.push(`The portfolio returned ${fmtPct(Math.abs(vsRiskFree))} less than CDI this month. ` +
          `In periods of low ${base} volatility or directional moves, the strategy's risk premium over ` +
          `the risk-free rate can turn negative — this is a normal occurrence and expected to ` +
          `reverse over the full cycle.`);
      } else {
        parts.push(`Returns were roughly in line with CDI this month, suggesting the volatility premium ` +
          `was close to neutral — neither capturing excess gains nor lagging the risk-free benchmark meaningfully.`);
      }
    }
    if (hasIbov) {
      const ibovPct = benchmarks.ibov.monthlyReturn * 100;
      const vsIbov = monthly.monthlyReturnPct - ibovPct;
      if (ibovPct < -3) {
        parts.push(`IBOV fell sharply this month, providing useful context: the ${pair} balanced portfolio ` +
          `behaved as an uncorrelated asset class relative to Brazilian equities${vsIbov > 0 ? ', and outperformed IBOV' : ''}.`);
      } else if (vsIbov > 2) {
        parts.push(`The strategy also outperformed IBOV by ${fmtPct(vsIbov)}, underscoring the benefit of ` +
          `holding a volatile asset like ${base} alongside local currency.`);
      } else if (vsIbov < -2) {
        parts.push(`IBOV outperformed the portfolio by ${fmtPct(Math.abs(vsIbov))} this month, ` +
          `reflecting a period of relative strength in Brazilian equities.`);
      }
    }
    if (parts.length > 0) paragraphs.push(parts.join(' '));
  }

  // ── Paragraph 3: Rebalancing activity ─────────────────────────────────────
  let p3: string;
  if (monthly.rebalanceCount === 0) {
    p3 = `No rebalances were triggered this month. The portfolio drifted within the adaptive ` +
      `threshold throughout the period, indicating either a low-volatility environment or ` +
      `a directional move that kept the portfolio close to the 50/50 target without crossing ` +
      `the trigger. Zero-rebalance months minimise fees and preserve the position without sacrificing allocation discipline.`;
  } else if (monthly.rebalanceCount === 1) {
    const dir = p.trades[0]?.direction ?? '';
    const dirStr = dir.startsWith('Buy') ? `buying ${base} on a dip` : `selling ${base} into strength`;
    p3 = `One rebalance was executed this month — ${dirStr} — bringing the portfolio back to its ` +
      `50/50 target. A single rebalance is a healthy signal: enough volatility to generate an ` +
      `opportunity, but not so much churn that fees erode the gains.`;
  } else if (monthly.rebalanceCount <= 4) {
    p3 = `${monthly.rebalanceCount} rebalances were executed across ${monthly.buyCount} buys and ` +
      `${monthly.sellCount} sells, reflecting moderate volatility in the ${pair} price. Each ` +
      `rebalance represents the strategy mechanically buying low and selling high relative to ` +
      `the portfolio's own target allocation — the source of Shannon's Demon's long-run edge.`;
  } else {
    p3 = `${monthly.rebalanceCount} rebalances this month indicate elevated volatility in ${pair}, ` +
      `giving the strategy multiple opportunities to harvest the spread. High rebalance frequency ` +
      `is exactly when the strategy's compounding edge is strongest, though it also means higher ` +
      `cumulative fees (${fmtBrl(monthly.totalFeesBrl)} this month). Net of fees, frequent ` +
      `rebalancing in a volatile market tends to be a net positive for this strategy.`;
  }
  paragraphs.push(p3);

  // ── Paragraph 4: Drawdown & risk ──────────────────────────────────────────
  if (monthly.maxDrawdownPct > 5 || cumulative.maxDrawdownPct > 10) {
    let p4 = '';
    if (monthly.maxDrawdownPct > 5) {
      p4 += `A peak-to-trough drawdown of ${fmtPct(monthly.maxDrawdownPct)} occurred within the month. `;
    }
    if (cumulative.maxDrawdownPct > 10) {
      p4 += `The all-time maximum drawdown now stands at ${fmtPct(cumulative.maxDrawdownPct)}, ` +
        `which is worth monitoring as the strategy matures. `;
    }
    p4 += `The BRL leg provides a natural cushion during ${base} downturns — when ${base} falls sharply, ` +
      `the rebalancer buys more at lower prices, which is the mechanism that tends to recover ` +
      `drawdowns faster than a fully concentrated ${base} position would.`;
    paragraphs.push(p4);
  }

  // ── Paragraph 5: Tax / unrealized position ────────────────────────────────
  const lines: string[] = [];
  if (!taxSummary.exempt && taxSummary.totalSalesBrl > 0) {
    lines.push(`SELL proceeds crossed the R$35,000 monthly threshold this month, making the ` +
      `realized gain taxable under Lei 9.250/1995 Art. 21. A DARF payment is due by ` +
      `${taxSummary.paymentDeadline ?? 'the last business day of next month'} — ensure this is scheduled.`);
  }
  if (Math.abs(portfolio.unrealizedGainPct) > 5) {
    const direction = portfolio.unrealizedGainBrl >= 0 ? 'gain' : 'loss';
    lines.push(`The current ${base} position carries an unrealized ${direction} of ` +
      `${fmtBrl(Math.abs(portfolio.unrealizedGainBrl))} (${fmtPct(Math.abs(portfolio.unrealizedGainPct))}) ` +
      `against the AVCO cost basis of ${fmtBrl(portfolio.averageCostBrl)}/${base}. ` +
      `This unrealized ${direction} will only crystalise as a tax event if and when ${base} is sold.`);
  }
  if (lines.length > 0) paragraphs.push(lines.join(' '));

  return paragraphs.join('\n\n');
}

// ─── Report payload builder ────────────────────────────────────────────────────

export async function buildReportPayload(
  monthBRT: string,
  dbPath?: string,
): Promise<ReportPayload | null> {
  // Derive base asset + JSON retention from config (e.g. "HYPE-BRL" → "HYPE").
  // Needed up front since CostBasisService requires the asset symbol at construction.
  let baseAsset = 'BASE';
  let jsonRetentionDays = 15;
  try {
    const { loadConfig } = await import('../../bot/src/config');
    const cfg = loadConfig();
    baseAsset = cfg.symbol.split('-')[0] ?? 'BASE';
    jsonRetentionDays = cfg.jsonRetentionDays ?? 15;
  } catch { /* config may not be present in all environments */ }

  // Init services
  const history = new TradeHistoryService(dbPath, jsonRetentionDays);
  const tax = new TaxService(dbPath, jsonRetentionDays);
  const costBasis = new CostBasisService(dbPath, jsonRetentionDays, baseAsset);
  const metrics = new MetricsService(history);
  const benchmarks = new BenchmarksService();

  const allSnapshots = history.readSnapshots();
  const allTrades = history.readTrades();

  // Handle empty data
  if (allSnapshots.length === 0) {
    return null;
  }

  // Month date range
  const monthStart = `${monthBRT}-01`;
  const monthEnd = monthLastDay(monthBRT);

  const monthSnapshots = allSnapshots.filter(
    s => s.dateBRT >= monthStart && s.dateBRT <= monthEnd
  );

  // ── Monthly metrics ────────────────────────────────────────────────────────
  const daysWithData = monthSnapshots.length;
  const isSparse = daysWithData < 20;
  const firstSnap = monthSnapshots[0] ?? allSnapshots[allSnapshots.length - 1]!;
  const lastSnap = monthSnapshots[monthSnapshots.length - 1] ?? firstSnap;

  const startValueBrl = firstSnap.totalValueBrl;
  const endValueBrl = lastSnap.totalValueBrl;
  const monthlyReturnPct = startValueBrl > 0 ? ((endValueBrl - startValueBrl) / startValueBrl) * 100 : 0;

  // If a rotation happened mid-month, only compare the asset active at month-end's price
  // movement since the rotation — diffing across a rotation boundary would otherwise
  // produce a meaningless "return" mixing two different assets' prices.
  const lastSnapIdxInAll = allSnapshots.indexOf(lastSnap);
  const epochStartIdx = findAssetEpochStart(allSnapshots, lastSnapIdxInAll, baseAsset);
  const epochStart = allSnapshots[epochStartIdx]!;
  const baseCompareStart = epochStart.dateBRT > firstSnap.dateBRT ? epochStart : firstSnap;
  const baseOnlyReturnPct = baseCompareStart.basePrice > 0
    ? ((lastSnap.basePrice - baseCompareStart.basePrice) / baseCompareStart.basePrice) * 100
    : 0;
  const monthDrawdown = computeMaxDrawdown(monthSnapshots.map(s => s.totalValueBrl));

  const monthTrades = allTrades.filter(t => {
    const d = t.tradeDateBRT ?? t.timestamp.slice(0, 10);
    return d >= monthStart && d <= monthEnd && (t.status === 'FILLED' || t.status === 'DRY_RUN');
  });

  const monthly: MonthlyMetrics = {
    monthBRT,
    reportLabel: `${EN_MONTHS[parseInt(monthBRT.split('-')[1]!) - 1]} ${monthBRT.split('-')[0]}`,
    daysWithData,
    isSparse,
    startValueBrl,
    endValueBrl,
    monthlyReturnPct,
    basePriceStart: firstSnap.basePrice,
    basePriceEnd: lastSnap.basePrice,
    baseOnlyReturnPct,
    rebalanceCount: monthTrades.length,
    totalFeesBrl: monthTrades.reduce((s, t) => s + (t.feeBrl ?? 0), 0),
    buyCount: monthTrades.filter(t => t.direction === 'BUY_BASE').length,
    sellCount: monthTrades.filter(t => t.direction === 'SELL_BASE').length,
    maxDrawdownPct: monthDrawdown,
  };

  // ── Cumulative metrics ─────────────────────────────────────────────────────
  const m = metrics.computeMetrics(allSnapshots);
  const inceptionSnap = allSnapshots[0]!;
  const currentSnap = allSnapshots[allSnapshots.length - 1]!;

  // Same asset-epoch logic as the monthly figure above: if the instance has ever
  // rotated, "cumulative base-asset-only return" only makes sense since the most
  // recent rotation, not from inception across a different asset's price.
  const cumulativeEpochStartIdx = findAssetEpochStart(allSnapshots, allSnapshots.length - 1, baseAsset);
  const cumulativeEpochStart = allSnapshots[cumulativeEpochStartIdx]!;
  const baseOnlyCumulative = cumulativeEpochStart.basePrice > 0
    ? ((currentSnap.basePrice - cumulativeEpochStart.basePrice) / cumulativeEpochStart.basePrice) * 100
    : 0;

  const cumulative: CumulativeMetrics = {
    inceptionDate: inceptionSnap.dateBRT,
    totalDays: m.totalDays,
    totalReturnPct: m.totalReturnBrlPct,
    baseOnlyCumulativeReturnPct: baseOnlyCumulative,
    cagr: m.cagr,
    sharpeRatio: m.sharpeRatio,
    maxDrawdownPct: m.maxDrawdownPct,
    totalRebalances: m.totalRebalances,
    totalFeesBrl: m.totalFeesBrl,
  };

  // ── Trade rows ─────────────────────────────────────────────────────────────
  const trades: TradeRow[] = monthTrades.map(t => ({
    date: t.tradeDateBRT ?? t.timestamp.slice(0, 10),
    direction: t.direction === 'BUY_BASE' ? 'Buy (BRL→Base)' : 'Sell (Base→BRL)',
    brlAmount: t.brlAmountFilled ?? t.brlAmountTarget,
    fillPrice: t.fillPrice ?? 0,
    feeBrl: t.feeBrl ?? 0,
    realizedGainBrl: t.realizedGainBrl,
    driftBeforePct: t.portfolioBefore.deviationBps / 100,
  }));

  // ── Tax summary ────────────────────────────────────────────────────────────
  const taxSummary = tax.getMonthlySummary(monthBRT);

  // ── Portfolio / cost basis ─────────────────────────────────────────────────
  const ledger = costBasis.getLedger();
  const refSnap = allSnapshots[allSnapshots.length - 1]!;
  const unrealizedGainBrl = (refSnap.basePrice - ledger.base.averageCostBrl) * ledger.base.totalBase;
  const costTotal = ledger.base.averageCostBrl * ledger.base.totalBase;
  const unrealizedGainPct = costTotal > 0 ? (unrealizedGainBrl / costTotal) * 100 : 0;

  const portfolio = {
    baseBalance: refSnap.baseBalance,
    brlBalance: refSnap.brlBalance,
    basePrice: refSnap.basePrice,
    totalValueBrl: refSnap.totalValueBrl,
    averageCostBrl: ledger.base.averageCostBrl,
    unrealizedGainBrl,
    unrealizedGainPct,
  };

  // ── External benchmarks (parallel, graceful failure) ──────────────────────
  const inceptionDate = inceptionSnap.dateBRT;
  const [cdiM, cdiC, ibovM, ibovC] = await Promise.allSettled([
    benchmarks.fetchCdi(monthStart, monthEnd),
    benchmarks.fetchCdi(inceptionDate, monthEnd),
    benchmarks.fetchIbov(monthStart, monthEnd),
    benchmarks.fetchIbov(inceptionDate, monthEnd),
  ]);

  const cdiMonthly = cdiM.status === 'fulfilled' ? cdiM.value : { monthlyReturn: 0, cumulativeReturn: 0, available: false, source: 'BACEN SGS 12' };
  const cdiCumul = cdiC.status === 'fulfilled' ? cdiC.value : { monthlyReturn: 0, cumulativeReturn: 0, available: false, source: 'BACEN SGS 12' };
  const ibovMonthly = ibovM.status === 'fulfilled' ? ibovM.value : { monthlyReturn: 0, cumulativeReturn: 0, available: false, source: 'Yahoo Finance ^BVSP' };
  const ibovCumul = ibovC.status === 'fulfilled' ? ibovC.value : { monthlyReturn: 0, cumulativeReturn: 0, available: false, source: 'Yahoo Finance ^BVSP' };

  // When inception is within the report month, the cumulative range equals the monthly range.
  // Fall back to monthly data for the cumulative column in that case.
  const cdiCumulFinal = cdiCumul.available ? cdiCumul : cdiMonthly;
  const ibovCumulFinal = ibovCumul.available ? ibovCumul : ibovMonthly;

  const benchmarkData = {
    cdi: {
      monthlyReturn: cdiMonthly.monthlyReturn,
      cumulativeReturn: cdiCumulFinal.cumulativeReturn,
      available: cdiMonthly.available,
      source: cdiMonthly.source,
    },
    ibov: {
      monthlyReturn: ibovMonthly.monthlyReturn,
      cumulativeReturn: ibovCumulFinal.cumulativeReturn,
      available: ibovMonthly.available,
      source: ibovMonthly.source,
    },
  };

  // ── Build payload ──────────────────────────────────────────────────────────
  const payload: ReportPayload = {
    monthBRT,
    baseAsset,
    monthly,
    cumulative,
    benchmarks: benchmarkData,
    taxSummary: {
      totalSalesBrl: taxSummary.totalSalesBrl,
      totalRealizedGainBrl: taxSummary.totalRealizedGainBrl,
      tradeCount: taxSummary.tradeCount,
      exempt: taxSummary.exempt,
      paymentDeadline: taxSummary.paymentDeadline,
    },
    portfolio,
    trades,
    generatedAt: new Date().toISOString(),
  };

  return payload;
}
