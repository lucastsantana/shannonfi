#!/usr/bin/env node
/**
 * Monthly performance report generator.
 * Assembles data from SQLite, fetches CDI/IBOV benchmarks, and calls Claude
 * to write an executive commentary. Writes Markdown to bot/data/reports/YYYY-MM.md.
 *
 * Usage:
 *   ts-node src/scripts/monthly-report.ts [--month YYYY-MM] [--config path] [--no-claude]
 */

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
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

const SYSTEM_PROMPT = `You are a quantitative portfolio analyst writing a concise monthly performance commentary for the Shannon's Demon strategy — a volatility-harvesting portfolio rebalancer that maintains a 50/50 SOL/BRL allocation on Mercado Bitcoin.

Write 3–5 paragraphs in clear, professional English. Do NOT repeat numbers that are already in the accompanying tables. Focus on:
- Qualitative interpretation of the month's performance in context
- How the strategy compares to benchmarks and what drove the difference
- Observations about rebalancing activity and what it reveals about market conditions
- Forward-looking considerations based on the data (without making financial predictions)

Tone: analytical but accessible, not overly technical. Audience: the strategy owner tracking performance over 12 months.`;

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

function benchmarkPct(b: BenchmarkReturn, useMonthly: boolean): string {
  if (!b.available) return 'N/A';
  return fmtPct((useMonthly ? b.monthlyReturn : b.cumulativeReturn) * 100);
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

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderReport(p: ReportPayload, commentary: string | null): string {
  const [y, m] = p.monthBRT.split('-');
  const label = `${EN_MONTHS[parseInt(m!) - 1]} ${y}`;
  const genDate = new Date(p.generatedAt);
  const genStr = genDate.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', dateStyle: 'medium', timeStyle: 'short' }) + ' BRT';

  const sparseWarning = p.monthly.isSparse
    ? `\n> **Warning:** Incomplete data for this month (${p.monthly.daysWithData} days of data). Metrics may not be representative.\n`
    : '';

  const commentarySection = commentary
    ? commentary
    : '> *Executive commentary unavailable (ANTHROPIC_API_KEY not configured or API error).*';

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
  const noClaude = args.includes('--no-claude');
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
  let apiKey: string | undefined;
  try {
    const config = loadConfig(configPath);
    dbPath = config.dbPath;
    apiKey = config.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'];
  } catch {
    // Config may not exist in CI; fall back to env
    apiKey = process.env['ANTHROPIC_API_KEY'];
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

  const benchmarkData = {
    cdi: {
      monthlyReturn: cdiMonthly.monthlyReturn,
      cumulativeReturn: cdiCumul.cumulativeReturn,
      available: cdiMonthly.available && cdiCumul.available,
      source: cdiMonthly.source,
    },
    ibov: {
      monthlyReturn: ibovMonthly.monthlyReturn,
      cumulativeReturn: ibovCumul.cumulativeReturn,
      available: ibovMonthly.available && ibovCumul.available,
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

  // ── Claude commentary ──────────────────────────────────────────────────────
  let commentary: string | null = null;
  if (!noClaude && apiKey) {
    console.log('Generating executive commentary via Claude...');
    try {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Here is the monthly report data for Shannon's Demon strategy:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nWrite the Executive Summary commentary.`,
          },
        ],
      });
      if (response.content[0]?.type === 'text') {
        commentary = response.content[0].text;
      }
    } catch (err) {
      console.warn(`Claude API error: ${(err as Error).message}. Report will be generated without commentary.`);
    }
  } else if (!noClaude && !apiKey) {
    console.warn('ANTHROPIC_API_KEY not set. Report will be generated without commentary. Pass --no-claude to suppress this warning.');
  }

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
