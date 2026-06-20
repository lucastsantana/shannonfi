/**
 * Investor-facing monthly PDF report — HTML generator.
 * Renders the same dark "retro CRT" theme as the live dashboard (shared via
 * bot/src/publishers/theme.ts) into a static, print-optimized document that
 * Playwright rasterizes to PDF in pdf-report.ts. No live JS, no theme toggle,
 * no Chart.js — just a single page-flow document meant to be printed once.
 */

import { GOOGLE_FONTS_HTML, DARK_THEME_VARS, SHARED_TEXT_CLASSES } from '../../bot/src/publishers/theme';
import { ReportPayload } from './report-types';
import { fmtPct, fmtBrl } from './report-builder';

function gainCls(n: number): string {
  if (n > 0.005) return 'gain';
  if (n < -0.005) return 'loss';
  return 'neut';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Splits commentary into `<p>` blocks on blank lines (Claude and the rule-based generator both use this convention). */
function renderCommentary(commentary: string): string {
  return commentary
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('\n      ');
}

export function buildReportHtml(payload: ReportPayload, commentary: string, commentarySource: 'claude' | 'rule-based'): string {
  const p = payload;
  const genDate = new Date(p.generatedAt).toLocaleString('en-US', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const tradeRows = p.trades.length === 0
    ? `<tr><td colspan="6" class="dim ctr">No rebalances this month</td></tr>`
    : p.trades.map((t) => {
        const isBuy = t.direction.startsWith('Buy');
        return `
        <tr>
          <td>${esc(t.date)}</td>
          <td class="${isBuy ? 'buy' : 'sell'}">${esc(t.direction)}</td>
          <td class="num">${esc(fmtBrl(t.brlAmount))}</td>
          <td class="num">${esc(fmtBrl(t.fillPrice))}</td>
          <td class="num loss">&#8722;${esc(fmtBrl(t.feeBrl))}</td>
          <td class="num ${t.realizedGainBrl != null ? gainCls(t.realizedGainBrl) : 'dim'}">${t.realizedGainBrl != null ? esc(fmtBrl(t.realizedGainBrl)) : '&#8212;'}</td>
        </tr>`;
      }).join('');

  const benchRows = [
    { label: "SHANNON'S DEMON", cls: 'mag', monthly: p.monthly.monthlyReturnPct, cumul: p.cumulative.totalReturnPct },
    { label: `${p.baseAsset} (BUY &amp; HOLD)`, cls: 'yel', monthly: p.monthly.baseOnlyReturnPct, cumul: p.cumulative.baseOnlyCumulativeReturnPct },
    ...(p.benchmarks.cdi.available ? [{ label: 'CDI', cls: 'cyan', monthly: p.benchmarks.cdi.monthlyReturn * 100, cumul: p.benchmarks.cdi.cumulativeReturn * 100 }] : []),
    ...(p.benchmarks.ibov.available ? [{ label: 'IBOVESPA', cls: 'cyan', monthly: p.benchmarks.ibov.monthlyReturn * 100, cumul: p.benchmarks.ibov.cumulativeReturn * 100 }] : []),
  ].map((r) => `
        <tr>
          <td class="${r.cls}">${r.label}</td>
          <td class="num ${gainCls(r.monthly)}">${esc(fmtPct(r.monthly))}</td>
          <td class="num ${gainCls(r.cumul)}">${esc(fmtPct(r.cumul))}</td>
        </tr>`).join('');

  const sparseWarning = p.monthly.isSparse
    ? `<div class="warn-bar">&#9888; PARTIAL MONTH — only ${p.monthly.daysWithData} days of portfolio data available. Figures below should be read with that in mind.</div>`
    : '';

  const taxCls = p.taxSummary.exempt ? 'gain' : 'loss';
  const taxLabel = p.taxSummary.exempt ? '&#10003; EXEMPT' : '&#9888; TAXABLE';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Shannon's Demon — Monthly Report — ${esc(p.monthly.reportLabel)}</title>
${GOOGLE_FONTS_HTML.trim()}
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  :root {${DARK_THEME_VARS}
  }

  @page { size: A4; margin: 14mm 12mm; }

  body {
    background: var(--bg);
    color: var(--g);
    font-family: var(--fn);
    font-size: 10.5px;
    line-height: 1.5;
  }

  ${SHARED_TEXT_CLASSES.trim()}

  .wrap { max-width: 100%; }

  .hdr {
    text-align: center;
    border: 2px solid var(--b);
    padding: 18px 12px 14px;
    margin-bottom: 14px;
    background: var(--p);
  }
  .hdr-title {
    font-family: var(--ft);
    font-size: 2.6em;
    letter-spacing: 4px;
    color: var(--m);
    text-shadow: 0 0 6px var(--m);
  }
  .hdr-sub {
    font-family: var(--ft);
    font-size: .85em;
    letter-spacing: 6px;
    color: var(--c);
    margin: 4px 0;
  }
  .hdr-meta { color: var(--y); letter-spacing: 2px; font-size: .82em; margin-top: 4px; }
  .hdr-confidential {
    display: inline-block; margin-top: 8px; padding: 3px 10px;
    border: 1px solid var(--r); color: var(--r); letter-spacing: 2px; font-size: .7em;
  }
  .hdr-gen { color: var(--d); font-size: .68em; margin-top: 6px; }

  .warn-bar {
    border: 1px solid var(--r); background: rgba(var(--r-rgb),.08); color: var(--r);
    padding: 8px 12px; margin-bottom: 14px; font-size: .82em; letter-spacing: .5px;
  }

  .sec { margin-bottom: 14px; page-break-inside: avoid; }
  .sec-hdr {
    font-family: var(--ft); font-size: 1.2em; letter-spacing: 1.5px; color: var(--m);
    text-shadow: 0 0 4px var(--m); border: 1px solid var(--b); border-bottom: none;
    padding: 6px 12px; background: var(--hdr2-bg);
  }

  .prose { border: 1px solid var(--b); background: var(--p); padding: 14px 16px; }
  .prose p { margin-bottom: 8px; color: var(--g); }
  .prose p:last-child { margin-bottom: 0; }

  .scores {
    display: grid; grid-template-columns: repeat(4, 1fr);
    border: 1px solid var(--b); background: var(--p);
  }
  .score { text-align: center; padding: 10px 6px; border-right: 1px solid var(--b); }
  .score:last-child { border-right: none; }
  .score-lbl { color: var(--d); font-size: .65em; letter-spacing: 1.5px; text-transform: uppercase; }
  .score-val { font-family: var(--ft); font-size: 1.7em; margin-top: 4px; }

  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .panel { border: 1px solid var(--b); background: var(--p); padding: 12px 14px; }
  .panel-hdr {
    font-family: var(--ft); font-size: 1.05em; letter-spacing: 1px; color: var(--m);
    border-bottom: 1px solid var(--b); padding-bottom: 5px; margin-bottom: 7px;
  }
  .sr { display: flex; justify-content: space-between; align-items: baseline; padding: 3px 0; border-bottom: 1px solid rgba(var(--b-rgb),.28); }
  .sl { color: var(--d); }
  .sv { color: var(--c); }

  table { width: 100%; border-collapse: collapse; }
  .tbl { border: 1px solid var(--b); background: var(--p); }
  .tbl thead th {
    background: var(--hdr3-bg); color: var(--y); text-transform: uppercase;
    font-size: .68em; letter-spacing: 1px; padding: 5px 8px; border-bottom: 1px solid var(--b);
    border-right: 1px solid rgba(var(--b-rgb),.35); text-align: left;
  }
  .tbl thead th.num { text-align: right; }
  .tbl tbody tr { border-bottom: 1px solid rgba(var(--b-rgb),.32); }
  .tbl td { padding: 4px 8px; border-right: 1px solid rgba(var(--b-rgb),.28); }
  .tbl td:last-child, .tbl th:last-child { border-right: none; }
  .num { text-align: right; }
  .ctr { text-align: center; }

  .disclaimer {
    border: 1px solid var(--r); background: rgba(var(--r-rgb),.05); color: var(--g);
    padding: 10px 12px; font-size: .68em; line-height: 1.5;
  }
  .disclaimer strong { color: var(--r); }

  .ftr { text-align: center; color: var(--d); font-size: .64em; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--B); }
  .commentary-src { color: var(--d); font-size: .6em; letter-spacing: .5px; text-align: right; margin-top: 6px; }
</style>
</head>
<body>
<div class="wrap">

  <header class="hdr">
    <div class="hdr-title">&#9878; SHANNON'S DEMON</div>
    <div class="hdr-sub">MONTHLY INVESTOR REPORT</div>
    <div class="hdr-meta">${esc(p.baseAsset)}-BRL &nbsp;&#183;&nbsp; ${esc(p.monthly.reportLabel).toUpperCase()}</div>
    <div class="hdr-confidential">CONFIDENTIAL &mdash; FOR INVESTOR USE ONLY</div>
    <div class="hdr-gen">Generated ${esc(genDate)} BRT</div>
  </header>

  ${sparseWarning}

  <section class="sec">
    <div class="sec-hdr">&#128202; EXECUTIVE SUMMARY</div>
    <div class="prose">
      ${renderCommentary(commentary)}
    </div>
    <div class="commentary-src">Commentary generated by: ${commentarySource === 'claude' ? 'Claude (Anthropic)' : 'rule-based fallback (Claude unavailable this run)'}</div>
  </section>

  <section class="sec">
    <div class="scores">
      <div class="score">
        <div class="score-lbl">MONTHLY RETURN</div>
        <div class="score-val ${gainCls(p.monthly.monthlyReturnPct)}">${esc(fmtPct(p.monthly.monthlyReturnPct))}</div>
      </div>
      <div class="score">
        <div class="score-lbl">CUMULATIVE RETURN</div>
        <div class="score-val ${gainCls(p.cumulative.totalReturnPct)}">${esc(fmtPct(p.cumulative.totalReturnPct))}</div>
      </div>
      <div class="score">
        <div class="score-lbl">SHARPE RATIO</div>
        <div class="score-val">${p.cumulative.sharpeRatio != null ? p.cumulative.sharpeRatio.toFixed(2) : '&#8212;'}</div>
      </div>
      <div class="score">
        <div class="score-lbl">MAX DRAWDOWN</div>
        <div class="score-val loss">${esc(fmtPct(-p.cumulative.maxDrawdownPct))}</div>
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="panels">
      <div class="panel">
        <div class="panel-hdr">&#128197; THIS MONTH</div>
        <div class="sr"><span class="sl">PORTFOLIO START &#8594; END</span><span class="sv">${esc(fmtBrl(p.monthly.startValueBrl))} &#8594; ${esc(fmtBrl(p.monthly.endValueBrl))}</span></div>
        <div class="sr"><span class="sl">${esc(p.baseAsset)} PRICE START &#8594; END</span><span class="sv">${esc(fmtBrl(p.monthly.basePriceStart))} &#8594; ${esc(fmtBrl(p.monthly.basePriceEnd))}</span></div>
        <div class="sr"><span class="sl">REBALANCES</span><span class="sv">${p.monthly.rebalanceCount} (${p.monthly.buyCount} buy / ${p.monthly.sellCount} sell)</span></div>
        <div class="sr"><span class="sl">FEES PAID</span><span class="sv loss">&#8722;${esc(fmtBrl(p.monthly.totalFeesBrl))}</span></div>
        <div class="sr"><span class="sl">MAX DRAWDOWN (MONTH)</span><span class="sv loss">${esc(fmtPct(-p.monthly.maxDrawdownPct))}</span></div>
      </div>
      <div class="panel">
        <div class="panel-hdr">&#128202; CUMULATIVE TRACK RECORD</div>
        <div class="sr"><span class="sl">INCEPTION</span><span class="sv">${esc(p.cumulative.inceptionDate)}</span></div>
        <div class="sr"><span class="sl">DAYS ACTIVE</span><span class="sv">${p.cumulative.totalDays}</span></div>
        <div class="sr"><span class="sl">CAGR</span><span class="sv ${p.cumulative.cagr != null ? gainCls(p.cumulative.cagr) : ''}">${p.cumulative.cagr != null ? esc(fmtPct(p.cumulative.cagr)) : '&#8212;'}</span></div>
        <div class="sr"><span class="sl">TOTAL REBALANCES</span><span class="sv">${p.cumulative.totalRebalances}</span></div>
        <div class="sr"><span class="sl">TOTAL FEES PAID</span><span class="sv loss">&#8722;${esc(fmtBrl(p.cumulative.totalFeesBrl))}</span></div>
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-hdr">&#9878; BENCHMARK COMPARISON</div>
    <table class="tbl">
      <thead><tr><th scope="col">STRATEGY</th><th scope="col" class="num">MONTHLY RETURN</th><th scope="col" class="num">CUMULATIVE RETURN</th></tr></thead>
      <tbody>${benchRows}</tbody>
    </table>
  </section>

  <section class="sec">
    <div class="sec-hdr">&#9889; TRADE HISTORY &mdash; ${esc(p.monthly.reportLabel).toUpperCase()}</div>
    <table class="tbl">
      <thead><tr>
        <th scope="col">DATE</th><th scope="col">ACTION</th><th scope="col" class="num">BRL AMOUNT</th>
        <th scope="col" class="num">FILL PRICE</th><th scope="col" class="num">FEE</th><th scope="col" class="num">REALIZED GAIN</th>
      </tr></thead>
      <tbody>${tradeRows}</tbody>
    </table>
  </section>

  <section class="sec">
    <div class="panels">
      <div class="panel">
        <div class="panel-hdr">&#128272; TAX STATUS (LEI 9.250/1995 ART. 21)</div>
        <div class="sr"><span class="sl">SELL PROCEEDS THIS MONTH</span><span class="sv">${esc(fmtBrl(p.taxSummary.totalSalesBrl))}</span></div>
        <div class="sr"><span class="sl">REALIZED GAIN THIS MONTH</span><span class="sv ${gainCls(p.taxSummary.totalRealizedGainBrl)}">${esc(fmtBrl(p.taxSummary.totalRealizedGainBrl))}</span></div>
        <div class="sr"><span class="sl">STATUS</span><span class="sv ${taxCls}">${taxLabel}</span></div>
        ${!p.taxSummary.exempt ? `<div class="sr"><span class="sl">DARF DEADLINE</span><span class="sv loss">${esc(p.taxSummary.paymentDeadline ?? '&#8212;')}</span></div>` : ''}
      </div>
      <div class="panel">
        <div class="panel-hdr">&#128176; CURRENT POSITION</div>
        <div class="sr"><span class="sl">${esc(p.baseAsset)} BALANCE</span><span class="sv">${p.portfolio.baseBalance.toFixed(6)} ${esc(p.baseAsset)}</span></div>
        <div class="sr"><span class="sl">BRL BALANCE</span><span class="sv">${esc(fmtBrl(p.portfolio.brlBalance))}</span></div>
        <div class="sr"><span class="sl">TOTAL VALUE</span><span class="sv cyan">${esc(fmtBrl(p.portfolio.totalValueBrl))}</span></div>
        <div class="sr"><span class="sl">AVG COST BASIS</span><span class="sv">${esc(fmtBrl(p.portfolio.averageCostBrl))} / ${esc(p.baseAsset)}</span></div>
        <div class="sr"><span class="sl">UNREALIZED GAIN</span><span class="sv ${gainCls(p.portfolio.unrealizedGainBrl)}">${esc(fmtBrl(p.portfolio.unrealizedGainBrl))} (${esc(fmtPct(p.portfolio.unrealizedGainPct))})</span></div>
      </div>
    </div>
  </section>

  <div class="disclaimer">
    <strong>&#9888; NOT FINANCIAL ADVICE.</strong> This report is for informational purposes only and does not
    constitute investment, tax, legal, or accounting advice, nor a recommendation or solicitation to buy, sell,
    or hold any asset. Past performance — including every figure in this report — is not indicative of future
    results. Cryptocurrency trading involves substantial risk of loss, including total loss of capital.
    Tax information referencing Lei 9.250/1995 Art. 21 is a general, non-exhaustive summary as understood at
    the time this report was generated and does not account for your individual circumstances; consult a
    licensed accountant or tax professional before making any filing decisions. All figures are generated
    automatically from this strategy's own trade and price history and are provided "as is," without warranty
    of any kind. Use this report, and act on anything in it, entirely at your own risk.
  </div>

  <div class="ftr">SHANNON'S DEMON &#9612; ${esc(p.baseAsset)}-BRL &#9612; ${esc(p.monthly.reportLabel)} &nbsp;&#183;&nbsp; &copy; ${new Date().getFullYear()} Lucas Santana</div>

</div>
</body>
</html>`;
}
