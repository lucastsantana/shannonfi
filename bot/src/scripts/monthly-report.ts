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
import { ReportPayload } from './report-types';
import {
  buildReportPayload, generateCommentary, getPreviousMonthBRT,
  fmtPct, fmtBrl, EN_MONTHS,
} from './report-builder';

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
    const { loadConfig } = await import('../config');
    const config = loadConfig(configPath);
    dbPath = config.dbPath;
  } catch {
    // Config may not exist in CI; use service defaults
  }

  // Build report payload
  const payload = await buildReportPayload(monthBRT, dbPath);

  if (!payload) {
    console.warn('No snapshot data found in database. Writing stub report.');
    const reportsDir = path.resolve(__dirname, '../../data/reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const stub = `# Shannon's Demon — Monthly Report: ${monthBRT}\n\n> No data available. The bot has not recorded any portfolio snapshots yet.\n`;
    fs.writeFileSync(path.join(reportsDir, `${monthBRT}.md`), stub, 'utf-8');
    console.log(`Stub report written to: data/reports/${monthBRT}.md`);
    return;
  }

  // Generate commentary
  const commentary = generateCommentary(payload);

  // Write report
  const reportsDir = path.resolve(__dirname, '../../data/reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outputPath = path.join(reportsDir, `${monthBRT}.md`);
  const markdown = renderReport(payload, commentary);
  fs.writeFileSync(outputPath, markdown, 'utf-8');

  console.log(`\nReport written to: data/reports/${monthBRT}.md`);
  if (payload.monthly.isSparse) {
    console.warn(`Note: Only ${payload.monthly.daysWithData} days of data for ${monthBRT} — report marked as sparse.`);
  }
}

main().catch(err => {
  console.error('Report generation failed:', (err as Error).message);
  process.exit(1);
});
