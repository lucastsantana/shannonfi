/**
 * LaTeX/Beamer template for monthly PDF reports.
 * Generates a complete Beamer presentation with Shannon Capital branding
 * and full regulatory disclaimer.
 */

import { ReportPayload } from './report-types';
import { fmtPct, fmtBrl, EN_MONTHS } from './report-builder';

// ─── LaTeX Escape Utility ──────────────────────────────────────────────────────

const LATEX_ESCAPES: Array<[RegExp, string]> = [
  [/\\/g,  '\\textbackslash{}'],  // MUST be first
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

function coloredReturn(value: number, formatted: string): string {
  return value >= 0
    ? `\\textcolor{Success}{${formatted}}`
    : `\\textcolor{Danger}{${formatted}}`;
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
  ].join('\n\n');

  return `${buildPreamble(monthLabel, genDate)}

\\begin{document}

${slides}

\\end{document}
`;
}

// ─── Preamble ─────────────────────────────────────────────────────────────────

function buildPreamble(monthLabel: string, genDate: string): string {
  return `\\documentclass[aspectratio=169,10pt]{beamer}

% ── Packages ──────────────────────────────────────────────────────────────────
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{inconsolata}
\\usepackage{booktabs}
\\usepackage{microtype}
\\usepackage{xcolor}
\\usepackage{tikz}
\\usepackage{array}
\\usepackage{colortbl}

% ── Color Palette ─────────────────────────────────────────────────────────────
\\definecolor{Navy}{HTML}{0A2540}       % deep navy — primary brand
\\definecolor{Gold}{HTML}{C49A19}       % gold — accent & decorative
\\definecolor{PageBg}{HTML}{FAFAFA}     % near-white page background
\\definecolor{TableHdr}{HTML}{EEF2F7}   % light blue-grey for table shading
\\definecolor{RuleColor}{HTML}{CBD5E1}  % light border / rule color
\\definecolor{BodyText}{HTML}{0A2540}   % dark navy body text
\\definecolor{MutedText}{HTML}{6B7280}  % muted grey for secondary text
\\definecolor{Success}{HTML}{059669}    % financial green
\\definecolor{Danger}{HTML}{DC2626}     % financial red

% ── Theme Base ────────────────────────────────────────────────────────────────
\\usetheme{default}
\\setbeamertemplate{navigation symbols}{}
\\setbeamercolor{background canvas}{bg=PageBg}
\\setbeamercolor{normal text}{fg=BodyText}
\\setbeamercolor{frametitle}{fg=white,bg=Navy}
\\setbeamercolor{structure}{fg=Navy}
\\setbeamercolor{alerted text}{fg=Danger}
\\setbeamercolor{block title}{fg=white,bg=Navy}
\\setbeamercolor{block body}{fg=BodyText,bg=TableHdr}

% ── Frame Title ───────────────────────────────────────────────────────────────
% Navy bar + gold underline. Uses beamercolorbox — no fragile TikZ overlay.
\\setbeamertemplate{frametitle}{%
  \\nointerlineskip
  \\begin{beamercolorbox}[%
    wd=\\paperwidth,ht=2.6ex,dp=1.0ex,%
    leftskip=1.2cm,rightskip=1.2cm]{frametitle}%
    \\usebeamerfont{frametitle}\\insertframetitle%
  \\end{beamercolorbox}%
  \\nointerlineskip
  {\\color{Gold}\\hrule height 1.5pt}%
}

% ── Footline ──────────────────────────────────────────────────────────────────
% Light separator rule + copyright / page number. No TikZ — reliable stacking.
\\setbeamertemplate{footline}{%
  \\nointerlineskip
  {\\color{RuleColor}\\hrule height 0.4pt}%
  \\begin{beamercolorbox}[%
    wd=\\paperwidth,ht=2.2ex,dp=0.8ex,%
    leftskip=0.8cm,rightskip=0.8cm]{normal text}%
    {\\tiny\\color{MutedText}\\textcopyright{} Shannon Capital --- Confidential}%
    \\hfill
    {\\tiny\\color{MutedText}\\insertframenumber\\,/\\,\\inserttotalframenumber}%
  \\end{beamercolorbox}%
}

% ── Typography ────────────────────────────────────────────────────────────────
\\setbeamerfont{frametitle}{size=\\normalsize,series=\\bfseries}
\\setbeamerfont{title}{size=\\LARGE,series=\\bfseries}
\\setbeamerfont{subtitle}{size=\\small,series=\\mdseries}
\\setbeamersize{text margin left=1.2cm,text margin right=1.2cm}

% Paragraph spacing — Beamer defaults parskip to 0; restore readable breathing room
\\setlength{\\parskip}{0.45em}
\\setlength{\\parindent}{0pt}

% ── Metadata ──────────────────────────────────────────────────────────────────
\\title{Shannon's Demon}
\\subtitle{Monthly Performance Report --- ${escLtx(monthLabel)}}
\\author{Shannon Capital}
\\date{${escLtx(genDate)} BRT}
\\institute{}`;
}

// ─── Slide Builders ───────────────────────────────────────────────────────────

function buildSlide1_Title(monthLabel: string, genDate: string): string {
  // Full-bleed dark title: set background color, then reset for remaining slides.
  // TikZ is used only for the thin gold accent bars at top/bottom edges (no text overlap).
  return `\\setbeamercolor{background canvas}{bg=Navy}
\\begin{frame}[plain]
\\begin{tikzpicture}[remember picture,overlay]
  \\fill[Gold] (current page.north west) rectangle ([yshift=-0.18cm]current page.north east);
  \\fill[Gold] (current page.south west) rectangle ([yshift=0.09cm]current page.south east);
\\end{tikzpicture}
\\vspace{2.0cm}
\\begin{center}
  {\\color{white}\\fontsize{26}{32}\\selectfont\\bfseries Shannon's Demon}\\\\[0.4cm]
  {\\color{Gold}\\rule{7cm}{0.6pt}}\\\\[0.35cm]
  {\\color{white!70!black}\\normalsize\\mdseries Monthly Performance Report}\\\\[0.15cm]
  {\\color{Gold}\\large\\bfseries ${escLtx(monthLabel)}}\\\\[1.0cm]
  {\\color{white!50!black}\\small Shannon Capital}\\\\[0.1cm]
  {\\color{white!35!black}\\scriptsize Generated: ${escLtx(genDate)} BRT}
\\end{center}
\\end{frame}
\\setbeamercolor{background canvas}{bg=PageBg}`;
}

function buildSlide2_ExecutiveSummary(commentary: string): string {
  const paragraphs = commentary.split('\n\n');
  const displayText = paragraphs.slice(0, 2).join('\n\n');
  const hasMore = paragraphs.length > 2;

  return `\\begin{frame}{Executive Summary}
\\vspace{0.4em}
{\\small\\color{BodyText}
${escLtx(displayText)}
}${hasMore ? '\n\\vspace{0.4em}\n{\\scriptsize\\color{MutedText}\\textit{See full commentary in the accompanying Markdown report.}}' : ''}
\\end{frame}`;
}

function buildSlide3_MonthPerformance(p: ReportPayload, monthLabel: string): string {
  const monthReturnStr  = coloredReturn(p.monthly.monthlyReturnPct,  escPct(p.monthly.monthlyReturnPct));
  const solReturnStr    = coloredReturn(p.monthly.baseOnlyReturnPct,   escPct(p.monthly.baseOnlyReturnPct));
  const cdiMonthly = p.benchmarks.cdi.available
    ? coloredReturn(p.benchmarks.cdi.monthlyReturn * 100, escPct(p.benchmarks.cdi.monthlyReturn * 100))
    : 'N/A';
  const ibovMonthly = p.benchmarks.ibov.available
    ? coloredReturn(p.benchmarks.ibov.monthlyReturn * 100, escPct(p.benchmarks.ibov.monthlyReturn * 100))
    : 'N/A';
  const maxDD = `\\textcolor{Danger}{$-$${p.monthly.maxDrawdownPct.toFixed(2)}\\%}`;

  return `\\begin{frame}{Month Performance: ${escLtx(monthLabel)}}
\\vspace{0.3em}
\\begin{center}
\\arrayrulecolor{RuleColor}
\\begin{tabular}{@{\\hspace{0.5em}}l@{\\hspace{2em}}r@{\\hspace{0.5em}}}
\\toprule
\\rowcolor{Navy}\\textcolor{white}{\\textbf{Metric}} & \\textcolor{white}{\\textbf{Value}} \\\\
\\midrule
Portfolio Return       & ${monthReturnStr} \\\\
SOL/BRL Price Change   & ${solReturnStr} \\\\
CDI (month)            & ${cdiMonthly} \\\\
IBOV (month)           & ${ibovMonthly} \\\\
Days with Data         & ${p.monthly.daysWithData} \\\\
Rebalances             & ${p.monthly.rebalanceCount} (${p.monthly.buyCount} buys, ${p.monthly.sellCount} sells) \\\\
Fees Paid              & ${escBrl(p.monthly.totalFeesBrl)} \\\\
Max Drawdown           & ${maxDD} \\\\
Portfolio Start        & ${escBrl(p.monthly.startValueBrl)} \\\\
Portfolio End          & ${escBrl(p.monthly.endValueBrl)} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide4_RebalanceHistory(p: ReportPayload): string {
  if (p.trades.length === 0) {
    return `\\begin{frame}{Rebalance History}
\\vspace{1.5em}
\\begin{center}
{\\color{MutedText}\\itshape No rebalances this month.}
\\end{center}
\\end{frame}`;
  }

  const sizeCmd = p.trades.length > 6 ? '\\footnotesize' : '\\small';
  const tradeRows = p.trades.map(t => {
    const dirColor = t.direction.includes('Buy') ? 'Success' : 'Danger';
    const dirStr = t.direction.includes('Buy') ? 'Buy' : 'Sell';
    const realizedStr = t.realizedGainBrl != null
      ? coloredReturn(t.realizedGainBrl, escBrl(t.realizedGainBrl))
      : '{\\color{MutedText}---}';
    const driftColor = t.driftBeforePct > 5 ? 'Danger' : 'BodyText';
    return `${t.date} & \\textcolor{${dirColor}}{${dirStr}} & ${escBrl(t.brlAmount)} & ${escBrl(t.fillPrice)}/SOL & ${escBrl(t.feeBrl)} & ${realizedStr} & {\\color{${driftColor}}${t.driftBeforePct.toFixed(2)}\\%} \\\\`;
  }).join('\n');

  return `\\begin{frame}{Rebalance History}
\\vspace{0.3em}
${sizeCmd}
\\begin{center}
\\arrayrulecolor{RuleColor}
\\begin{tabular}{@{\\hspace{0.3em}}l l r r r r r@{\\hspace{0.3em}}}
\\toprule
\\rowcolor{Navy}\\textcolor{white}{\\textbf{Date}} & \\textcolor{white}{\\textbf{Dir}} & \\textcolor{white}{\\textbf{Amount}} & \\textcolor{white}{\\textbf{Fill Price}} & \\textcolor{white}{\\textbf{Fee}} & \\textcolor{white}{\\textbf{P\\&L}} & \\textcolor{white}{\\textbf{Drift}} \\\\
\\midrule
${tradeRows}
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide5_BenchmarkComparison(p: ReportPayload): string {
  const sdMonthly  = coloredReturn(p.monthly.monthlyReturnPct,                  escPct(p.monthly.monthlyReturnPct));
  const sdCumul    = coloredReturn(p.cumulative.totalReturnPct,                  escPct(p.cumulative.totalReturnPct));
  const solMonthly = coloredReturn(p.monthly.baseOnlyReturnPct,                   escPct(p.monthly.baseOnlyReturnPct));
  const solCumul   = coloredReturn(p.cumulative.baseOnlyCumulativeReturnPct,       escPct(p.cumulative.baseOnlyCumulativeReturnPct));

  const cdiMonthly = p.benchmarks.cdi.available
    ? coloredReturn(p.benchmarks.cdi.monthlyReturn * 100,    escPct(p.benchmarks.cdi.monthlyReturn * 100))
    : 'N/A';
  const cdiCumul = p.benchmarks.cdi.available
    ? coloredReturn(p.benchmarks.cdi.cumulativeReturn * 100, escPct(p.benchmarks.cdi.cumulativeReturn * 100))
    : 'N/A';
  const ibovMonthly = p.benchmarks.ibov.available
    ? coloredReturn(p.benchmarks.ibov.monthlyReturn * 100,    escPct(p.benchmarks.ibov.monthlyReturn * 100))
    : 'N/A';
  const ibovCumul = p.benchmarks.ibov.available
    ? coloredReturn(p.benchmarks.ibov.cumulativeReturn * 100, escPct(p.benchmarks.ibov.cumulativeReturn * 100))
    : 'N/A';

  return `\\begin{frame}{Benchmark Comparison (Since Inception)}
\\vspace{0.3em}
\\begin{center}
\\arrayrulecolor{RuleColor}
\\begin{tabular}{@{\\hspace{0.5em}}l@{\\hspace{2em}}r@{\\hspace{2em}}r@{\\hspace{0.5em}}}
\\toprule
\\rowcolor{Navy}\\textcolor{white}{\\textbf{Benchmark}} & \\textcolor{white}{\\textbf{This Month}} & \\textcolor{white}{\\textbf{Since Inception}} \\\\
\\midrule
Shannon's Demon  & ${sdMonthly}   & ${sdCumul}   \\\\
SOL Buy-and-Hold & ${solMonthly}  & ${solCumul}  \\\\
CDI              & ${cdiMonthly}  & ${cdiCumul}  \\\\
IBOV             & ${ibovMonthly} & ${ibovCumul} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide6_TaxSummary(p: ReportPayload): string {
  const statusStr = p.taxSummary.exempt
    ? `{\\color{Success}Exempt (sales $\\leq$ R\\$35{,}000)}`
    : `{\\color{Danger}\\textbf{Taxable --- DARF required}}`;
  const deadline = p.taxSummary.paymentDeadline ?? '---';

  return `\\begin{frame}{Tax Summary (Lei 9.250/1995 Art.~21)}
\\vspace{0.3em}
\\begin{center}
\\arrayrulecolor{RuleColor}
\\begin{tabular}{@{\\hspace{0.5em}}l@{\\hspace{2em}}r@{\\hspace{0.5em}}}
\\toprule
\\rowcolor{Navy}\\textcolor{white}{\\textbf{Metric}} & \\textcolor{white}{\\textbf{Value}} \\\\
\\midrule
Gross SELL Proceeds & ${escBrl(p.taxSummary.totalSalesBrl)} \\\\
Realized Gain       & ${coloredReturn(p.taxSummary.totalRealizedGainBrl, escBrl(p.taxSummary.totalRealizedGainBrl))} \\\\
Trades              & ${p.taxSummary.tradeCount} \\\\
Status              & ${statusStr} \\\\
Payment Deadline    & ${escLtx(deadline)} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide7_CurrentPortfolio(p: ReportPayload): string {
  const baseValue    = p.portfolio.baseBalance * p.portfolio.basePrice;
  const unrealizedStr = coloredReturn(
    p.portfolio.unrealizedGainPct,
    `${escBrl(p.portfolio.unrealizedGainBrl)} (${escPct(p.portfolio.unrealizedGainPct)})`,
  );

  return `\\begin{frame}{Current Portfolio}
\\vspace{0.3em}
\\begin{center}
\\arrayrulecolor{RuleColor}
\\begin{tabular}{@{\\hspace{0.5em}}l@{\\hspace{2em}}r@{\\hspace{2em}}r@{\\hspace{0.5em}}}
\\toprule
\\rowcolor{Navy}\\textcolor{white}{\\textbf{Asset}} & \\textcolor{white}{\\textbf{Quantity}} & \\textcolor{white}{\\textbf{Value (BRL)}} \\\\
\\midrule
Base             & ${p.portfolio.baseBalance.toFixed(6)} & ${escBrl(baseValue)} \\\\
BRL              & {\\color{MutedText}---}              & ${escBrl(p.portfolio.brlBalance)} \\\\
\\textbf{Total}  & {\\color{MutedText}---}              & \\textbf{${escBrl(p.portfolio.totalValueBrl)}} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\vspace{0.6em}
\\begin{tabular}{@{}ll}
  \\textbf{Average Cost (AVCO):} & ${escBrl(p.portfolio.averageCostBrl)}/unit \\\\[0.2em]
  \\textbf{Unrealized P\\&L:}     & ${unrealizedStr} \\\\
\\end{tabular}
\\end{frame}`;
}

function buildSlide8_CumulativeTrackRecord(p: ReportPayload): string {
  const cagrStr   = p.cumulative.cagr        != null ? coloredReturn(p.cumulative.cagr,        escPct(p.cumulative.cagr))        : 'N/A';
  const sharpeStr = p.cumulative.sharpeRatio  != null ? p.cumulative.sharpeRatio.toFixed(3) : 'N/A';
  const totalRet  = coloredReturn(p.cumulative.totalReturnPct, escPct(p.cumulative.totalReturnPct));
  const maxDD     = `\\textcolor{Danger}{$-$${p.cumulative.maxDrawdownPct.toFixed(2)}\\%}`;

  return `\\begin{frame}{Cumulative Track Record}
\\vspace{0.3em}
\\begin{center}
\\arrayrulecolor{RuleColor}
\\begin{tabular}{@{\\hspace{0.5em}}l@{\\hspace{2em}}r@{\\hspace{0.5em}}}
\\toprule
\\rowcolor{Navy}\\textcolor{white}{\\textbf{Metric}} & \\textcolor{white}{\\textbf{Value}} \\\\
\\midrule
Since              & ${escLtx(p.cumulative.inceptionDate)} \\\\
Total Days         & ${p.cumulative.totalDays} \\\\
Total Return       & ${totalRet} \\\\
CAGR               & ${cagrStr} \\\\
Sharpe Ratio       & ${sharpeStr} \\\\
Max Drawdown       & ${maxDD} \\\\
Total Rebalances   & ${p.cumulative.totalRebalances} \\\\
Total Fees         & ${escBrl(p.cumulative.totalFeesBrl)} \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\end{frame}`;
}

function buildSlide9_Disclaimer(): string {
  // allowframebreaks auto-continues onto a second slide if content overflows.
  // Font size and color are set as switches (not a brace group) so the splitter
  // can find paragraph break points and carry settings across frame continuations.
  return `\\begin{frame}[allowframebreaks]{Important Disclosures}
\\scriptsize
\\color{BodyText}
\\setlength{\\parskip}{0.5em}

\\textcolor{Navy}{\\textbf{NOT INVESTMENT ADVICE}} \\quad
This material has been prepared by Shannon Capital for informational purposes
only. It does not constitute an offer, solicitation, or recommendation to buy
or sell any financial instrument or digital asset.

\\textcolor{Navy}{\\textbf{PAST PERFORMANCE}} \\quad
Past performance does not guarantee future results. Returns shown are historical
and may not be representative of future performance.

\\textcolor{Navy}{\\textbf{RISK FACTORS}} \\quad
This strategy involves investment in highly volatile digital assets. Risks
include: (i)~extreme price volatility and potential total loss of capital;
(ii)~liquidity risk --- positions may not be exitable at prevailing market
prices; (iii)~no guarantee of positive returns; (iv)~the strategy may
underperform a passive buy-and-hold position or risk-free rate (CDI) during
sustained directional markets; (v)~operational risks including exchange
downtime, API failures, and software errors.

\\textcolor{Navy}{\\textbf{REGULATORY}} \\quad
This material has not been reviewed or approved by any regulatory authority
(CVM or otherwise). Shannon Capital is an independent asset manager. This
document does not constitute investment advice within the meaning of Lei
6.385/1976 or applicable CVM regulations. Recipients should obtain independent
financial, legal, and tax advice before making any investment decision.

\\textcolor{Navy}{\\textbf{TAX}} \\quad
Tax information relating to Lei 9.250/1995 Art.~21 is provided for illustrative
purposes only and does not constitute tax advice. Recipients are solely
responsible for their own tax compliance obligations.

\\vspace{0.3em}
{\\color{MutedText}\\textcopyright{} Shannon Capital. Confidential ---
Not for distribution. All rights reserved. Unauthorized reproduction or
redistribution is prohibited.}

\\end{frame}`;
}
