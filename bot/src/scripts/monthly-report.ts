#!/usr/bin/env node
/**
 * Monthly performance report generator.
 * Assembles data from SQLite, fetches CDI/IBOV benchmarks, and generates
 * rule-based executive commentary. Writes Markdown to bot/data/reports/YYYY-MM.md.
 *
 * Usage:
 *   ts-node src/scripts/monthly-report.ts [--month YYYY-MM] [--config path]
 */

import * as fs from 'fs';
import * as path from 'path';
import { TradeHistoryService } from '../core/tracker/history';
import { TaxService } from '../core/tracker/tax';
import { CostBasisService } from '../core/tracker/costbasis';
import { MetricsService } from '../core/tracker/metrics';
import { BenchmarksService } from '../core/benchmarks';
import { loadConfig } from '../config';
import {
  ReportPayload, MonthlyMetrics, CumulativeMetrics, TradeRow, BenchmarkReturn,
} from './report-types';

// ─── Constants ────────────────────────────────────────────────────────────────

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPreviousMonthBRT(): string {
  const brtNow = new Date(new Date().toLocaleString('en-CA', { timeZone: 'America/Sao_Paulo' }));
  const y = brtNow.getFullYear();
  const m = brtNow.getMonth(); // 0-indexed
  if (m === 0) return `${y - 1}-12`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthLastDay(monthBRT: string): string {
  const [y, m] = monthBRT.split('-').map(Number);
  const last = new Date(y!, m!, 0); // day 0 of next month = last day of this month
  return `${y}-${String(m).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

function fmtPct(n: number, decimals = 2): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

function fmtBrl(n: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
}

function computeMaxDrawdown(values: number[]): number {
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

function generateCommentary(p: ReportPayload): string {
  const { monthly, cumulative, benchmarks, taxSummary, portfolio } = p;
  const paragraphs: string[] = [];

  // ── Paragraph 1: Overall performance this month ───────────────────────────
  const portfolioVsSol = monthly.monthlyReturnPct - monthly.solOnlyReturnPct;
  let p1: string;
  if (monthly.isSparse) {
    p1 = `This report covers a partial month with only ${monthly.daysWithData} days of portfolio data, ` +
      `so figures should be interpreted with caution. ` +
      `The strategy recorded a return of ${fmtPct(monthly.monthlyReturnPct)} over the available period, ` +
      `while SOL/BRL moved ${fmtPct(monthly.solOnlyReturnPct)} over the same window.`;
  } else if (Math.abs(portfolioVsSol) < 0.5) {
    p1 = `Shannon's Demon tracked closely with SOL's raw price move this month, ` +
      `with the portfolio returning ${fmtPct(monthly.monthlyReturnPct)} against a ${fmtPct(monthly.solOnlyReturnPct)} ` +
      `move in SOL/BRL. When the two figures are this close it typically indicates a directional ` +
      `market where mean-reversion opportunities were limited — the strategy's edge comes from ` +
      `harvesting volatility around a mean, not from trending periods.`;
  } else if (portfolioVsSol > 0) {
    p1 = `The strategy outperformed a passive SOL position this month, returning ` +
      `${fmtPct(monthly.monthlyReturnPct)} against a ${fmtPct(monthly.solOnlyReturnPct)} move in SOL/BRL. ` +
      `This is the core Shannon's Demon effect: rebalancing captured the spread between SOL price ` +
      `oscillations and the stable BRL leg, converting volatility into portfolio gains above what ` +
      `either asset delivered on its own.`;
  } else {
    p1 = `SOL outpaced the balanced portfolio this month — SOL/BRL moved ${fmtPct(monthly.solOnlyReturnPct)} ` +
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
          `In periods of low SOL volatility or directional moves, the strategy's risk premium over ` +
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
        parts.push(`IBOV fell sharply this month, providing useful context: the SOL/BRL balanced portfolio ` +
          `behaved as an uncorrelated asset class relative to Brazilian equities${vsIbov > 0 ? ', and outperformed IBOV' : ''}.`);
      } else if (vsIbov > 2) {
        parts.push(`The strategy also outperformed IBOV by ${fmtPct(vsIbov)}, underscoring the benefit of ` +
          `holding a volatile, globally-priced asset like SOL alongside local currency.`);
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
    const dirStr = dir.startsWith('Buy') ? 'buying SOL on a dip' : 'selling SOL into strength';
    p3 = `One rebalance was executed this month — ${dirStr} — bringing the portfolio back to its ` +
      `50/50 target. A single rebalance is a healthy signal: enough volatility to generate an ` +
      `opportunity, but not so much churn that fees erode the gains.`;
  } else if (monthly.rebalanceCount <= 4) {
    p3 = `${monthly.rebalanceCount} rebalances were executed across ${monthly.buyCount} buys and ` +
      `${monthly.sellCount} sells, reflecting moderate volatility in the SOL/BRL price. Each ` +
      `rebalance represents the strategy mechanically buying low and selling high relative to ` +
      `the portfolio's own target allocation — the source of Shannon's Demon's long-run edge.`;
  } else {
    p3 = `${monthly.rebalanceCount} rebalances this month indicate elevated volatility in SOL/BRL, ` +
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
    p4 += `The BRL leg provides a natural cushion during SOL downturns — when SOL falls sharply, ` +
      `the rebalancer buys more at lower prices, which is the mechanism that tends to recover ` +
      `drawdowns faster than a fully concentrated SOL position would.`;
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
    lines.push(`The current SOL position carries an unrealized ${direction} of ` +
      `${fmtBrl(Math.abs(portfolio.unrealizedGainBrl))} (${fmtPct(Math.abs(portfolio.unrealizedGainPct))}) ` +
      `against the AVCO cost basis of ${fmtBrl(portfolio.averageCostBrl)}/SOL. ` +
      `This unrealized ${direction} will only crystalise as a tax event if and when SOL is sold.`);
  }
  if (lines.length > 0) paragraphs.push(lines.join(' '));

  return paragraphs.join('\n\n');
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderReport(p: ReportPayload, commentary: string): string {
  const [y, m] = p.monthBRT.split('-');
  const label = `${EN_MONTHS[parseInt(m!) - 1]} ${y}`;
  const genDate = new Date(p.generatedAt);
  const genStr = genDate.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', dateStyle: 'medium', timeStyle: 'short' }) + ' BRT';

  const sparseWarning = p.monthly.isSparse
    ? `\n> **Warning:** Incomplete data for this month (${p.monthly.daysWithData} days of data). Metrics may not be representative.\n`
    : '';

  const commentarySection = commentary;

  const tradesTable = p.trades.length === 0
    ? '_No rebalances this month._'
    : [
        '| Date | Direction | Amount (BRL) | Fill Price | Fee (BRL) | Realized Gain (BRL) | Drift Before |',
        '|------|-----------|-------------|------------|-----------|---------------------|-------------|',
        ...p.trades.map(t =>
          `| ${t.date} | ${t.direction} | ${fmtBrl(t.brlAmount)} | ${fmtBrl(t.fillPrice)}/SOL | ${fmtBrl(t.feeBrl)} | ${t.realizedGainBrl != null ? fmtBrl(t.realizedGainBrl) : '—'} | ${fmtPct(t.driftBeforePct)} |`
        ),
      ].join('\n');

  const ibovMonthly = p.benchmarks.ibov.available ? fmtPct(p.benchmarks.ibov.monthlyReturn * 100) : 'N/A';
  const ibovCumul = p.benchmarks.ibov.available ? fmtPct(p.benchmarks.ibov.cumulativeReturn * 100) : 'N/A';
  const cdiMonthly = p.benchmarks.cdi.available ? fmtPct(p.benchmarks.cdi.monthlyReturn * 100) : 'N/A';
  const cdiCumul = p.benchmarks.cdi.available ? fmtPct(p.benchmarks.cdi.cumulativeReturn * 100) : 'N/A';

  const taxStatus = p.taxSummary.exempt ? '✓ Exempt (sales ≤ R$35,000)' : '⚠ Taxable — DARF required';
  const taxDeadline = p.taxSummary.paymentDeadline ?? '—';

  const cagrStr = p.cumulative.cagr != null ? fmtPct(p.cumulative.cagr) : 'N/A';
  const sharpeStr = p.cumulative.sharpeRatio != null ? p.cumulative.sharpeRatio.toFixed(3) : 'N/A';

  return `# Shannon's Demon — Monthly Report: ${label}
_Generated on ${genStr}_
${sparseWarning}
---

## Executive Summary

${commentarySection}

---

## Month Performance (${label})

| Metric | Value |
|--------|-------|
| Portfolio Return | ${fmtPct(p.monthly.monthlyReturnPct)} |
| SOL/BRL Price Change | ${fmtPct(p.monthly.solOnlyReturnPct)} |
| CDI (month) | ${cdiMonthly} |
| IBOV (month) | ${ibovMonthly} |
| Days with Data | ${p.monthly.daysWithData} |
| Rebalances | ${p.monthly.rebalanceCount} (${p.monthly.buyCount} buys, ${p.monthly.sellCount} sells) |
| Fees Paid | ${fmtBrl(p.monthly.totalFeesBrl)} |
| Max Drawdown (month) | -${p.monthly.maxDrawdownPct.toFixed(2)}% |
| Portfolio Start | ${fmtBrl(p.monthly.startValueBrl)} |
| Portfolio End | ${fmtBrl(p.monthly.endValueBrl)} |

---

## Rebalance History

${tradesTable}

---

## Benchmark Comparison (since inception)

| Benchmark | This Month | Since Inception |
|-----------|-----------|-----------------|
| Shannon's Demon | ${fmtPct(p.monthly.monthlyReturnPct)} | ${fmtPct(p.cumulative.totalReturnPct)} |
| SOL Buy-and-Hold | ${fmtPct(p.monthly.solOnlyReturnPct)} | ${fmtPct(p.cumulative.solOnlyCumulativeReturnPct)} |
| CDI | ${cdiMonthly} | ${cdiCumul} |
| IBOV | ${ibovMonthly} | ${ibovCumul} |

---

## Tax Summary (Lei 9.250/1995 Art. 21)

| Metric | Value |
|--------|-------|
| Gross SELL Proceeds | ${fmtBrl(p.taxSummary.totalSalesBrl)} |
| Realized Gain | ${fmtBrl(p.taxSummary.totalRealizedGainBrl)} |
| Trades | ${p.taxSummary.tradeCount} |
| Status | ${taxStatus} |
| Payment Deadline | ${taxDeadline} |

---

## Current Portfolio

| Asset | Quantity | Reference Price | Value (BRL) |
|-------|----------|----------------|-------------|
| SOL | ${p.portfolio.solBalance.toFixed(6)} | ${fmtBrl(p.portfolio.solPrice)}/SOL | ${fmtBrl(p.portfolio.solBalance * p.portfolio.solPrice)} |
| BRL | ${fmtBrl(p.portfolio.brlBalance)} | — | ${fmtBrl(p.portfolio.brlBalance)} |
| **Total** | — | — | **${fmtBrl(p.portfolio.totalValueBrl)}** |

**Average Cost (AVCO):** ${fmtBrl(p.portfolio.averageCostBrl)}/SOL
**Unrealized P&L:** ${fmtBrl(p.portfolio.unrealizedGainBrl)} (${fmtPct(p.portfolio.unrealizedGainPct)})

---

## Cumulative Track Record

| Metric | Value |
|--------|-------|
| Since | ${p.cumulative.inceptionDate} |
| Total Days | ${p.cumulative.totalDays} |
| Total Return | ${fmtPct(p.cumulative.totalReturnPct)} |
| CAGR | ${cagrStr} |
| Sharpe Ratio | ${sharpeStr} |
| Max Drawdown | -${p.cumulative.maxDrawdownPct.toFixed(2)}% |
| Total Rebalances | ${p.cumulative.totalRebalances} |
| Total Fees | ${fmtBrl(p.cumulative.totalFeesBrl)} |

---

_Strategy: Shannon's Demon (50/50 SOL/BRL). Exchange: Mercado Bitcoin._
_Data source: local SQLite database. CDI: ${p.benchmarks.cdi.source}. IBOV: ${p.benchmarks.ibov.source}._
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const monthIdx = args.indexOf('--month');
  const monthArg = monthIdx !== -1 ? args[monthIdx + 1] : undefined;
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  const monthBRT = monthArg ?? getPreviousMonthBRT();
  if (!/^\d{4}-\d{2}$/.test(monthBRT)) {
    console.error(`Invalid month format: ${monthBRT}. Expected YYYY-MM.`);
    process.exit(1);
  }

  console.log(`\n=== Shannon's Demon — Monthly Report: ${monthBRT} ===\n`);

  // Load config
  let dbPath: string | undefined;
  try {
    const config = loadConfig(configPath);
    dbPath = config.dbPath;
  } catch {
    // Config may not exist in CI; use service defaults
  }

  // Init services
  const history = new TradeHistoryService(dbPath);
  const tax = new TaxService(dbPath);
  const costBasis = new CostBasisService(dbPath);
  const metrics = new MetricsService(history);
  const benchmarks = new BenchmarksService();

  const allSnapshots = history.readSnapshots();
  const allTrades = history.readTrades();

  // Month date range
  const monthStart = `${monthBRT}-01`;
  const monthEnd = monthLastDay(monthBRT);

  const monthSnapshots = allSnapshots.filter(
    s => s.dateBRT >= monthStart && s.dateBRT <= monthEnd
  );

  // ── Handle empty data ──────────────────────────────────────────────────────
  if (allSnapshots.length === 0) {
    console.warn('No snapshot data found in database. Writing stub report.');
    const reportsDir = path.resolve(__dirname, '../../data/reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const stub = `# Shannon's Demon — Monthly Report: ${monthBRT}\n\n> No data available. The bot has not recorded any portfolio snapshots yet.\n`;
    fs.writeFileSync(path.join(reportsDir, `${monthBRT}.md`), stub, 'utf-8');
    console.log(`Stub report written to: data/reports/${monthBRT}.md`);
    return;
  }

  // ── Monthly metrics ────────────────────────────────────────────────────────
  const daysWithData = monthSnapshots.length;
  const isSparse = daysWithData < 20;
  const firstSnap = monthSnapshots[0] ?? allSnapshots[allSnapshots.length - 1]!;
  const lastSnap = monthSnapshots[monthSnapshots.length - 1] ?? firstSnap;

  const startValueBrl = firstSnap.totalValueBrl;
  const endValueBrl = lastSnap.totalValueBrl;
  const monthlyReturnPct = startValueBrl > 0 ? ((endValueBrl - startValueBrl) / startValueBrl) * 100 : 0;
  const solOnlyReturnPct = firstSnap.solPrice > 0 ? ((lastSnap.solPrice - firstSnap.solPrice) / firstSnap.solPrice) * 100 : 0;
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
    solPriceStart: firstSnap.solPrice,
    solPriceEnd: lastSnap.solPrice,
    solOnlyReturnPct,
    rebalanceCount: monthTrades.length,
    totalFeesBrl: monthTrades.reduce((s, t) => s + (t.feeBrl ?? 0), 0),
    buyCount: monthTrades.filter(t => t.direction === 'BUY_SOL').length,
    sellCount: monthTrades.filter(t => t.direction === 'SELL_SOL').length,
    maxDrawdownPct: monthDrawdown,
  };

  // ── Cumulative metrics ─────────────────────────────────────────────────────
  const m = metrics.computeMetrics(allSnapshots);
  const inceptionSnap = allSnapshots[0]!;
  const currentSnap = allSnapshots[allSnapshots.length - 1]!;
  const solOnlyCumulative = inceptionSnap.solPrice > 0
    ? ((currentSnap.solPrice - inceptionSnap.solPrice) / inceptionSnap.solPrice) * 100
    : 0;

  const cumulative: CumulativeMetrics = {
    inceptionDate: inceptionSnap.dateBRT,
    totalDays: m.totalDays,
    totalReturnPct: m.totalReturnBrlPct,
    solOnlyCumulativeReturnPct: solOnlyCumulative,
    cagr: m.cagr,
    sharpeRatio: m.sharpeRatio,
    maxDrawdownPct: m.maxDrawdownPct,
    totalRebalances: m.totalRebalances,
    totalFeesBrl: m.totalFeesBrl,
  };

  // ── Trade rows ─────────────────────────────────────────────────────────────
  const trades: TradeRow[] = monthTrades.map(t => ({
    date: t.tradeDateBRT ?? t.timestamp.slice(0, 10),
    direction: t.direction === 'BUY_SOL' ? 'Buy (BRL→SOL)' : 'Sell (SOL→BRL)',
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
  const unrealizedGainBrl = (refSnap.solPrice - ledger.sol.averageCostBrl) * ledger.sol.totalSol;
  const costTotal = ledger.sol.averageCostBrl * ledger.sol.totalSol;
  const unrealizedGainPct = costTotal > 0 ? (unrealizedGainBrl / costTotal) * 100 : 0;

  const portfolio = {
    solBalance: refSnap.solBalance,
    brlBalance: refSnap.brlBalance,
    solPrice: refSnap.solPrice,
    totalValueBrl: refSnap.totalValueBrl,
    averageCostBrl: ledger.sol.averageCostBrl,
    unrealizedGainBrl,
    unrealizedGainPct,
  };

  // ── External benchmarks (parallel, graceful failure) ──────────────────────
  console.log('Fetching external benchmarks...');
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

  if (!benchmarkData.cdi.available) console.warn('CDI data unavailable — will show N/A in report');
  if (!benchmarkData.ibov.available) console.warn('IBOV data unavailable — will show N/A in report');

  // ── Build payload ──────────────────────────────────────────────────────────
  const payload: ReportPayload = {
    monthBRT,
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

  // ── Generate commentary ────────────────────────────────────────────────────
  const commentary = generateCommentary(payload);

  // ── Write report ───────────────────────────────────────────────────────────
  const reportsDir = path.resolve(__dirname, '../../data/reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outputPath = path.join(reportsDir, `${monthBRT}.md`);
  const markdown = renderReport(payload, commentary);
  fs.writeFileSync(outputPath, markdown, 'utf-8');

  console.log(`\nReport written to: data/reports/${monthBRT}.md`);
  if (isSparse) {
    console.warn(`Note: Only ${daysWithData} days of data for ${monthBRT} — report marked as sparse.`);
  }
}

main().catch(err => {
  console.error('Report generation failed:', (err as Error).message);
  process.exit(1);
});
