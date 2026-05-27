/**
 * LaTeX/Beamer template for monthly PDF reports.
 * Generates a complete Beamer presentation with colorblind-friendly palette,
 * Shannon Capital branding, and full regulatory disclaimer.
 */

import { execSync } from 'child_process';
import { ReportPayload } from './report-types';
import { fmtPct, fmtBrl, EN_MONTHS } from './report-builder';

// ─── LaTeX Escape Utility ──────────────────────────────────────────────────────

const LATEX_ESCAPES: Array<[RegExp, string]> = [
  [/\\/g,  '\\textbackslash{}'],  // MUST be first (before other escapes that use \)
  [/\{/g,  '\\{'],
  [/\}/g,  '\\}'],
  [/\$/g,  '\\$'],
  [/&/g,   '\\&'],
  [/%/g,   '\\%'],
  [/#/g,   '\\#'],
  [/_/g,   '\\_'],
  [/~/g,   '\\textasciitilde{}'],
  [/\^/g,  '\\textasciicircum{}'],
];

function escLtx(s: string): string {
  return LATEX_ESCAPES.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

function escBrl(n: number): string {
  return escLtx(fmtBrl(n));
}

function escPct(n: number, decimals = 2): string {
  return escLtx(fmtPct(n, decimals));
}

// ─── Theme Detection ──────────────────────────────────────────────────────────

function hasMetropolisTheme(): boolean {
  try {
    execSync('kpsewhich beamerthememetropolis.sty', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── Main Document Generator ──────────────────────────────────────────────────

export function buildLatexDocument(payload: ReportPayload, commentary: string): string {
  const parts = payload.monthBRT.split('-');
  const y = parts[0]!;
  const m = parts[1]!;
  const monthLabel = `${EN_MONTHS[parseInt(m) - 1]} ${y}`;
  const genDate = new Date(payload.generatedAt).toLocaleString('en-US', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const metropolis = hasMetropolisTheme();

  // ── Build slides ───────────────────────────────────────────────────────────
  const slides = [
    buildSlide1_Title(monthLabel, genDate),
    buildSlide2_ExecutiveSummary(commentary),
    buildSlide3_MonthPerformance(payload, monthLabel),
    buildSlide4_RebalanceHistory(payload),
    buildSlide5_BenchmarkComparison(payload),
    buildSlide6_TaxSummary(payload),
    buildSlide7_CurrentPortfolio(payload),
    buildSlide8_CumulativeTrackRecord(payload),
    buildSlide9_Disclaimer(),
  ].join('\n');

  // ── Assemble document ──────────────────────────────────────────────────────
  return `${buildPreamble(monthLabel, genDate, metropolis)}

\\begin{document}

${slides}

\\end{document}
`;
}

// ─── Preamble ─────────────────────────────────────────────────────────────────

function buildPreamble(monthLabel: string, genDate: string, metropolis: boolean): string {
  const themeBlock = metropolis
    ? `% ── Metropolis Theme ──────────────────────────────────────────────────────
\\usetheme{metropolis}
\\metroset{block=fill}
\\setbeamercolor{alerted text}{fg=OIVermillion}
\\setbeamercolor{progress bar}{fg=OIVermillion,bg=OIDeepBlue}`
    : `% ── Madrid Theme (fallback) ───────────────────────────────────────────────
\\usetheme{Madrid}
\\usecolortheme{default}
\\setbeamercolor{palette primary}{bg=OIDeepBlue,fg=white}
\\setbeamercolor{palette secondary}{bg=OIDeepBlue!80,fg=white}
\\setbeamercolor{palette tertiary}{bg=OIDeepBlue!60,fg=white}
\\setbeamercolor{palette quaternary}{bg=OIDeepBlue!40,fg=white}
\\setbeamercolor{structure}{fg=OIDeepBlue}
\\setbeamercolor{title}{fg=white,bg=OIDeepBlue}
\\setbeamercolor{frametitle}{fg=white,bg=OIDeepBlue}
\\setbeamercolor{block title}{fg=white,bg=OIDeepBlue}
\\setbeamercolor{block body}{bg=LightBg}`;

  return `\\documentclass[aspectratio=169,10pt]{beamer}

% ── Packages ──────────────────────────────────────────────────────────────────
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{booktabs}
\\usepackage{microtype}
\\usepackage{xcolor}
\\usepackage{graphicx}

% ── Okabe-Ito Colorblind-Friendly Palette ─────────────────────────────────────
\\definecolor{OIDeepBlue}{HTML}{0072B2}
\\definecolor{OIVermillion}{HTML}{D55E00}
\\definecolor{OIGreen}{HTML}{009E73}
\\definecolor{OISkyBlue}{HTML}{56B4E9}
\\definecolor{OIOrange}{HTML}{E69F00}
\\definecolor{OIYellow}{HTML}{F0E442}
\\definecolor{OIBlack}{HTML}{000000}
\\definecolor{LightBg}{HTML}{F5F5F5}

${themeBlock}

% ── Footer (copyright on every slide) ──────────────────────────────────────────
\\setbeamertemplate{footline}{%
  \\leavevmode%
  \\hbox{%
    \\begin{beamercolorbox}[wd=\\paperwidth,ht=2.5ex,dp=1.5ex,leftskip=0.5em]{palette secondary}%
      {\\tiny \\textcopyright{} Shannon Capital --- Confidential. Not for distribution.%
       \\hfill \\insertframenumber{} / \\inserttotalframenumber\\hspace*{0.5em}}%
    \\end{beamercolorbox}}%
  \\vskip0pt%
}
\\setbeamertemplate{navigation symbols}{}

% ── Typography ────────────────────────────────────────────────────────────────
\\setbeamerfont{title}{size=\\large,series=\\bfseries}
\\setbeamerfont{frametitle}{size=\\normalsize,series=\\bfseries}

% ── Metadata ───────────────────────────────────────────────────────────────────
\\title{Shannon's Demon}
\\subtitle{Monthly Performance Report --- ${escLtx(monthLabel)}}
\\author{Shannon Capital}
\\date{Generated: ${escLtx(genDate)} BRT}
\\institute{}
`;
}

// ─── Slide Builders ───────────────────────────────────────────────────────────

function buildSlide1_Title(monthLabel: string, genDate: string): string {
  return `\\begin{frame}
\\titlepage
\\end{frame}`;
}

function buildSlide2_ExecutiveSummary(commentary: string): string {
  // Limit to first 2 paragraphs; add note if longer
  const paragraphs = commentary.split('\n\n');
  const displayText = paragraphs.slice(0, 2).join('\n\n');
  const hasMore = paragraphs.length > 2;

  return `\\begin{frame}{Executive Summary}
\\begin{block}{}
\\small
${escLtx(displayText)}
${hasMore ? '\n\n\\textit{See full commentary in the accompanying Markdown report.}' : ''}
\\end{block}
\\end{frame}`;
}

function buildSlide3_MonthPerformance(p: ReportPayload, monthLabel: string): string {
  const monthReturn = p.monthly.monthlyReturnPct;
  const monthReturnStr = monthReturn >= 0
    ? `\\textcolor{OIDeepBlue}{${escPct(monthReturn)}}`
    : `\\textcolor{OIVermillion}{${escPct(monthReturn)}}`;

  const solReturn = p.monthly.solOnlyReturnPct;
  const solReturnStr = solReturn >= 0
    ? `\\textcolor{OIDeepBlue}{${escPct(solReturn)}}`
    : `\\textcolor{OIVermillion}{${escPct(solReturn)}}`;

  const cdiMonthly = p.benchmarks.cdi.available
    ? `\\textcolor{OIDeepBlue}{${escPct(p.benchmarks.cdi.monthlyReturn * 100)}}`
    : 'N/A';

  const ibovMonthly = p.benchmarks.ibov.available
    ? `\\textcolor{OIDeepBlue}{${escPct(p.benchmarks.ibov.monthlyReturn * 100)}}`
    : 'N/A';

  const maxDD = p.monthly.maxDrawdownPct >= 0
    ? `\\textcolor{OIVermillion}{-${p.monthly.maxDrawdownPct.toFixed(2)}\\%}`
    : `\\textcolor{OIVermillion}{${p.monthly.maxDrawdownPct.toFixed(2)}\\%}`;

  return `\\begin{frame}{Month Performance: ${escLtx(monthLabel)}}
\\begin{center}
\\begin{tabular}{lr}
\\toprule
\\textbf{Metric} & \\textbf{Value} \\\\
\\midrule
Portfolio Return & ${monthReturnStr} \\\\
SOL/BRL Price Change & ${solReturnStr} \\\\
CDI (month) & ${cdiMonthly} \\\\
IBOV (month) & ${ibovMonthly} \\\\
Days with Data & ${p.monthly.daysWithData} \\\\
Rebalances & ${p.monthly.rebalanceCount} (${p.monthly.buyCount} buys, ${p.monthly.sellCount} sells) \\\\
Fees Paid & ${escBrl(p.monthly.totalFeesBrl)} \\\\
Max Drawdown & ${maxDD} \\\\
Portfolio Start & ${escBrl(p.monthly.startValueBrl)} \\\\
Portfolio End & ${escBrl(p.monthly.endValueBrl)} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide4_RebalanceHistory(p: ReportPayload): string {
  if (p.trades.length === 0) {
    return `\\begin{frame}{Rebalance History}
\\begin{center}
\\textit{No rebalances this month.}
\\end{center}
\\end{frame}`;
  }

  const fontCmd = p.trades.length > 8 ? '\\small' : '';
  const tradeRows = p.trades.map(t => {
    const dirStr = t.direction.includes('Buy') ? 'Buy' : 'Sell';
    const realizedGainStr = t.realizedGainBrl != null ? escBrl(t.realizedGainBrl) : '—';
    return `${t.date} & ${dirStr} & ${escBrl(t.brlAmount)} & ${escBrl(t.fillPrice)}/SOL & ${escBrl(t.feeBrl)} & ${realizedGainStr} & ${t.driftBeforePct.toFixed(2)}\\% \\\\`;
  }).join('\n');

  return `\\begin{frame}{Rebalance History}
${fontCmd}
\\begin{center}
\\begin{tabular}{lllllll}
\\toprule
\\textbf{Date} & \\textbf{Dir} & \\textbf{Amount (BRL)} & \\textbf{Fill Price} & \\textbf{Fee (BRL)} & \\textbf{Realized Gain} & \\textbf{Drift} \\\\
\\midrule
${tradeRows}
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide5_BenchmarkComparison(p: ReportPayload): string {
  const sdMonthly = escPct(p.monthly.monthlyReturnPct);
  const sdCumul = escPct(p.cumulative.totalReturnPct);
  const solMonthly = escPct(p.monthly.solOnlyReturnPct);
  const solCumul = escPct(p.cumulative.solOnlyCumulativeReturnPct);

  const cdiMonthly = p.benchmarks.cdi.available
    ? escPct(p.benchmarks.cdi.monthlyReturn * 100)
    : 'N/A';
  const cdiCumul = p.benchmarks.cdi.available
    ? escPct(p.benchmarks.cdi.cumulativeReturn * 100)
    : 'N/A';

  const ibovMonthly = p.benchmarks.ibov.available
    ? escPct(p.benchmarks.ibov.monthlyReturn * 100)
    : 'N/A';
  const ibovCumul = p.benchmarks.ibov.available
    ? escPct(p.benchmarks.ibov.cumulativeReturn * 100)
    : 'N/A';

  return `\\begin{frame}{Benchmark Comparison (Since Inception)}
\\begin{center}
\\begin{tabular}{lrr}
\\toprule
\\textbf{Benchmark} & \\textbf{This Month} & \\textbf{Since Inception} \\\\
\\midrule
Shannon's Demon & ${sdMonthly} & ${sdCumul} \\\\
SOL Buy-and-Hold & ${solMonthly} & ${solCumul} \\\\
CDI & ${cdiMonthly} & ${cdiCumul} \\\\
IBOV & ${ibovMonthly} & ${ibovCumul} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide6_TaxSummary(p: ReportPayload): string {
  const statusStr = p.taxSummary.exempt
    ? 'Exempt (sales \\(\\leq\\) R\\$35{,}000)'
    : `\\textcolor{OIVermillion}{Taxable --- DARF required}`;

  const deadline = p.taxSummary.paymentDeadline ?? '—';

  return `\\begin{frame}{Tax Summary (Lei 9.250/1995 Art. 21)}
\\begin{center}
\\begin{tabular}{lr}
\\toprule
\\textbf{Metric} & \\textbf{Value} \\\\
\\midrule
Gross SELL Proceeds & ${escBrl(p.taxSummary.totalSalesBrl)} \\\\
Realized Gain & ${escBrl(p.taxSummary.totalRealizedGainBrl)} \\\\
Trades & ${p.taxSummary.tradeCount} \\\\
Status & ${statusStr} \\\\
Payment Deadline & ${escLtx(deadline)} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide7_CurrentPortfolio(p: ReportPayload): string {
  const solValue = p.portfolio.solBalance * p.portfolio.solPrice;
  const unrealizedStr = p.portfolio.unrealizedGainPct >= 0
    ? `\\textcolor{OIDeepBlue}{${escBrl(p.portfolio.unrealizedGainBrl)} (${escPct(p.portfolio.unrealizedGainPct)})}`
    : `\\textcolor{OIVermillion}{${escBrl(p.portfolio.unrealizedGainBrl)} (${escPct(p.portfolio.unrealizedGainPct)})}`;

  return `\\begin{frame}{Current Portfolio}
\\begin{center}
\\begin{tabular}{lrr}
\\toprule
\\textbf{Asset} & \\textbf{Quantity} & \\textbf{Value (BRL)} \\\\
\\midrule
SOL & ${p.portfolio.solBalance.toFixed(6)} & ${escBrl(solValue)} \\\\
BRL & — & ${escBrl(p.portfolio.brlBalance)} \\\\
\\textbf{Total} & — & \\textbf{${escBrl(p.portfolio.totalValueBrl)}} \\\\
\\bottomrule
\\end{tabular}
\\end{center}

\\medskip
\\textbf{Average Cost (AVCO):} ${escBrl(p.portfolio.averageCostBrl)}/SOL

\\medskip
\\textbf{Unrealized P\\&L:} ${unrealizedStr}
\\end{frame}`;
}

function buildSlide8_CumulativeTrackRecord(p: ReportPayload): string {
  const cagrStr = p.cumulative.cagr != null ? escPct(p.cumulative.cagr) : 'N/A';
  const sharpeStr = p.cumulative.sharpeRatio != null ? p.cumulative.sharpeRatio.toFixed(3) : 'N/A';
  const maxDD = `\\textcolor{OIVermillion}{-${p.cumulative.maxDrawdownPct.toFixed(2)}\\%}`;

  return `\\begin{frame}{Cumulative Track Record}
\\begin{center}
\\begin{tabular}{lr}
\\toprule
\\textbf{Metric} & \\textbf{Value} \\\\
\\midrule
Since & ${escLtx(p.cumulative.inceptionDate)} \\\\
Total Days & ${p.cumulative.totalDays} \\\\
Total Return & ${escPct(p.cumulative.totalReturnPct)} \\\\
CAGR & ${cagrStr} \\\\
Sharpe Ratio & ${sharpeStr} \\\\
Max Drawdown & ${maxDD} \\\\
Total Rebalances & ${p.cumulative.totalRebalances} \\\\
Total Fees & ${escBrl(p.cumulative.totalFeesBrl)} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide9_Disclaimer(): string {
  return `\\begin{frame}[allowframebreaks]{Important Disclosures}
\\begin{block}{}
\\tiny

\\textbf{NOT INVESTMENT ADVICE.} This material has been prepared by Shannon Capital for informational purposes only. It does not constitute an offer, solicitation, or recommendation to buy or sell any financial instrument or digital asset.

\\medskip
\\textbf{PAST PERFORMANCE.} Past performance does not guarantee future results. Returns shown are historical and may not be representative of future performance.

\\medskip
\\textbf{RISK FACTORS.} This strategy involves investment in highly volatile digital assets. Risks include: (i)~extreme price volatility and potential total loss of capital; (ii)~liquidity risk --- positions may not be exitable at prevailing market prices; (iii)~no guarantee of positive returns; (iv)~the strategy may underperform a passive buy-and-hold position or risk-free rate (CDI) during sustained directional markets; (v)~operational risks including exchange downtime, API failures, and software errors.

\\medskip
\\textbf{REGULATORY.} This material has not been reviewed or approved by any regulatory authority (CVM or otherwise). Shannon Capital is an independent asset manager. This document does not constitute investment advice within the meaning of Lei 6.385/1976 or applicable CVM regulations. Recipients should obtain independent financial, legal, and tax advice before making any investment decision.

\\medskip
\\textbf{TAX.} Tax information relating to Lei 9.250/1995 Art.~21 is provided for illustrative purposes only and does not constitute tax advice. Recipients are solely responsible for their own tax compliance obligations.

\\medskip
\\textcopyright{} Shannon Capital. Confidential --- Not for distribution. All rights reserved. Unauthorized reproduction or redistribution is prohibited.

\\end{block}
\\end{frame}`;
}
