#!/usr/bin/env node
/**
 * Dashboard generator.
 * Reads all data from the local SQLite database and renders a self-contained
 * retro-style HTML portfolio dashboard with a live strategy chart and
 * client-side 30-second price updates via MB's public tickers API.
 *
 * Usage: ts-node src/scripts/generate-dashboard.ts --config configs/hype-mb.yaml
 * Output: <dbDir>/dashboard.html
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { getDb } from '../core/tracker/db';

// ─── Row types ────────────────────────────────────────────────────────────────

interface TradeRow {
  id: string;
  timestamp: string;
  direction: string;
  base_amount_filled: number;
  brl_amount_filled: number;
  fill_price: number;
  fee_brl: number;
  realized_gain_brl: number | null;
  before_total_value: number;
  after_total_value: number;
  before_deviation_bps: number;
  after_deviation_bps: number;
  trade_date_brt: string;
  status: string;
}

interface SnapshotRow {
  date_brt: string;
  timestamp: string;
  total_value_brl: number;
  base_balance: number;
  brl_balance: number;
  base_price: number;
  base_ratio_bps: number;
  effective_threshold_bps: number;
  rebalanced_today: number;
}

interface CostBasisRow {
  asset: string;
  average_cost_brl: number;
  total_base: number;
  last_updated: string;
}

interface TaxEventRow {
  trade_id: string;
  trade_date_brt: string;
  month_brt: string;
  direction: string;
  traded_volume_brl: number;
  realized_gain_brl: number;
  cum_monthly_sales_brl: number;
  exempt: number;
}

interface BenchmarkRow {
  date: string;
  price: number;
  shannonValue: number;
  bhHalfValue: number;
  bhAllInValue: number;
  excess: number;
  vsAllIn: number;
  rebalanced: boolean;
  isLive?: boolean;
}

interface MonthData { sales: number; gain: number; exempt: boolean; }

interface DashboardData {
  symbol: string;
  baseAsset: string;
  trades: TradeRow[];
  snapshots: SnapshotRow[];
  costBasis: CostBasisRow | null;
  currentPrice: number | null;
  generatedAt: string;
  benchmark: BenchmarkRow[];
  initialTotal: number;
  totalRealizedGain: number;
  totalFees: number;
  daysActive: number;
  monthlySales: Record<string, MonthData>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const res = await axios.get<Array<{ pair: string; last: string }>>(
      'https://api.mercadobitcoin.net/api/v4/tickers',
      { params: { symbols: symbol }, timeout: 6000 },
    );
    const ticker = res.data.find((t) => t.pair === symbol);
    return ticker ? parseFloat(ticker.last) : null;
  } catch {
    return null;
  }
}

function toBRT(iso: string): string {
  const brtMs = new Date(iso).getTime() - 3 * 60 * 60 * 1000;
  return new Date(brtMs).toISOString().replace('T', ' ').slice(0, 16);
}

function toDateBRT(isoOrDate: string): string {
  return toBRT(isoOrDate.length === 10 ? isoOrDate + 'T12:00:00Z' : isoOrDate).slice(0, 10);
}

function daysElapsed(fromDate: string, toDate: string): number {
  return Math.round(
    (new Date(toDate + 'T12:00:00Z').getTime() - new Date(fromDate + 'T12:00:00Z').getTime()) /
    86_400_000,
  );
}

function fmtBrl(n: number, plus = false): string {
  const abs = `R$${Math.abs(n).toFixed(2)}`;
  if (plus && n > 0.005) return `+${abs}`;
  if (n < -0.005) return `-R$${Math.abs(n).toFixed(2)}`;
  return n < 0 ? `-${abs}` : abs;
}

function fmtPct(n: number): string {
  const p = (n * 100).toFixed(2);
  return n >= 0 ? `+${p}%` : `${p}%`;
}

function gainCls(n: number): string {
  if (n > 0.005) return 'gain';
  if (n < -0.005) return 'loss';
  return 'neut';
}

// ─── HTML generator ───────────────────────────────────────────────────────────

function generateHtml(d: DashboardData): string {
  const lastSnap    = d.snapshots[d.snapshots.length - 1];
  const livePrice   = d.currentPrice ?? lastSnap?.base_price ?? 0;
  const liveBase    = lastSnap?.base_balance ?? 0;
  const liveBrl     = lastSnap?.brl_balance  ?? 0;
  const liveBaseVal = liveBase * livePrice;
  const liveTotal   = liveBaseVal + liveBrl;
  const liveReturn  = d.initialTotal > 0 ? (liveTotal - d.initialTotal) / d.initialTotal : 0;
  const liveDev     = lastSnap ? Math.abs(lastSnap.base_ratio_bps - 5000) : 0;
  const avgCost     = d.costBasis?.average_cost_brl ?? 0;
  const totalBase   = d.costBasis?.total_base ?? 0;
  const netGain     = d.totalRealizedGain - d.totalFees;
  const tradeCount  = d.trades.length;

  const retCls   = liveReturn >= 0 ? 'gain' : 'loss';
  const devCls   = liveDev < 200 ? 'gain' : liveDev < 450 ? 'yel' : 'loss';
  const devLabel = liveDev < 200 ? '&#10003; BALANCED' : liveDev < 450 ? '&#9888; DRIFTING' : '&#9889; ALERT';

  // ── Chart data (JSON-serialised for the inline script) ──────────────────────
  const benchJson = JSON.stringify(d.benchmark.map((row) => ({
    date:       row.date,
    price:      parseFloat(row.price.toFixed(2)),
    shannon:    parseFloat(row.shannonValue.toFixed(2)),
    bh50:       parseFloat(row.bhHalfValue.toFixed(2)),
    bhAll:      parseFloat(row.bhAllInValue.toFixed(2)),
    rebalanced: row.rebalanced,
    isLive:     row.isLive ?? false,
  })));

  // ── Trade history rows (newest first) ───────────────────────────────────────
  const tradeRows = [...d.trades].reverse().map((t, i) => {
    const isBuy    = t.direction === 'BUY_BASE';
    const dCls     = isBuy ? 'buy' : 'sell';
    const dEmoji   = isBuy ? '&#128200;' : '&#128201;';
    const dLabel   = isBuy ? 'BUY' : 'SELL';
    const qSign    = isBuy ? '+' : '&#8722;';
    const gain     = t.realized_gain_brl ?? 0;
    const gainCell = !isBuy
      ? `<span class="${gainCls(gain)}">${fmtBrl(gain, true)}</span>`
      : '<span class="dim">&#8212;</span>';
    const num      = (tradeCount - i).toString().padStart(2, '0');
    const timeStr  = toBRT(t.timestamp).slice(11);
    const dateStr  = (t.trade_date_brt ?? '').slice(5);
    return `
        <tr>
          <td class="dim">${num}</td>
          <td>${dateStr} <small class="dim">${timeStr}</small></td>
          <td class="${dCls}">${dEmoji} ${dLabel}</td>
          <td class="num ${dCls}">${qSign}${t.base_amount_filled.toFixed(6)}</td>
          <td class="num">R$${t.fill_price.toFixed(2)}</td>
          <td class="num">${fmtBrl(t.brl_amount_filled)}</td>
          <td class="num loss">&#8722;${fmtBrl(t.fee_brl)}</td>
          <td class="num">${gainCell}</td>
          <td class="num dim">${t.before_deviation_bps ?? '—'}&#8594;${t.after_deviation_bps ?? '—'}</td>
        </tr>`;
  }).join('');

  // ── Tax rows ────────────────────────────────────────────────────────────────
  const taxRows = Object.entries(d.monthlySales).map(([month, data]) => {
    const pct35k = ((data.sales / 35000) * 100).toFixed(1);
    const exCell = data.exempt
      ? '<span class="gain">&#10003; EXEMPT</span>'
      : '<span class="loss">&#9888; TAXABLE</span>';
    return `
        <tr>
          <td class="cyan">${month}</td>
          <td class="num">${fmtBrl(data.sales)}</td>
          <td class="num ${gainCls(data.gain)}">${fmtBrl(data.gain, true)}</td>
          <td>${exCell}</td>
          <td class="dim">${pct35k}% of R$35k limit</td>
        </tr>`;
  }).join('') || '<tr><td colspan="5" class="dim ctr">No sell events recorded</td></tr>';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SHANNON'S DEMON // ${d.symbol}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=VT323&family=Share+Tech+Mono&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --g:  #33ff33;
      --G:  #00ff88;
      --b:  #007700;
      --B:  #004400;
      --c:  #00ffff;
      --m:  #ff00ff;
      --y:  #ffff00;
      --r:  #ff3344;
      --d:  #446644;
      --bg: #000000;
      --p:  #010801;
      --fn: 'Share Tech Mono', 'Courier New', monospace;
      --ft: 'VT323', monospace;
    }

    body {
      background: var(--bg);
      color: var(--g);
      font-family: var(--fn);
      font-size: 13px;
      line-height: 1.45;
      padding: 18px;
      min-height: 100vh;
    }

    /* CRT scanlines */
    body::before {
      content: '';
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 9999; pointer-events: none;
      background: repeating-linear-gradient(
        to bottom,
        rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px,
        rgba(0,0,0,0.18) 3px, rgba(0,0,0,0) 4px
      );
    }

    /* CRT vignette */
    body::after {
      content: '';
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 9998; pointer-events: none;
      background: radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.65) 100%);
    }

    @keyframes blink    { 0%,49%{opacity:1} 50%,100%{opacity:0} }
    @keyframes flicker  { 0%{opacity:.99} 5%{opacity:.91} 10%{opacity:1}
                          72%{opacity:.97} 78%{opacity:1} 92%{opacity:.95} 96%{opacity:1} }
    @keyframes pulse-m  { 0%,100%{text-shadow:0 0 6px var(--m),0 0 14px var(--m)}
                          50%{text-shadow:0 0 12px var(--m),0 0 28px var(--m),0 0 50px rgba(255,0,255,.4)} }
    @keyframes pulse-c  { 0%,100%{text-shadow:0 0 5px var(--c),0 0 10px var(--c)}
                          50%{text-shadow:0 0 10px var(--c),0 0 22px var(--c),0 0 40px rgba(0,255,255,.35)} }
    @keyframes pulse-live { 0%,100%{opacity:1;color:var(--G)} 50%{opacity:0.35;color:var(--g)} }

    .blink   { animation: blink 1.1s step-end infinite; }
    .flicker { animation: flicker 9s linear infinite; }
    .live-dot{ animation: pulse-live 2s ease-in-out infinite; font-size:.8em; }

    /* ── Typography ─────────────────────────────────── */
    .gain { color: var(--G); }
    .loss { color: var(--r); }
    .neut { color: #cccccc; }
    .buy  { color: var(--G); }
    .sell { color: var(--r); }
    .cyan { color: var(--c); }
    .yel  { color: var(--y); }
    .mag  { color: var(--m); }
    .dim  { color: var(--d); }
    small { font-size:.78em; opacity:.8; }

    /* ── Layout ─────────────────────────────────────── */
    .wrap { max-width: 1380px; margin: 0 auto; }

    /* ── Header ─────────────────────────────────────── */
    .hdr {
      text-align: center;
      border: 2px solid var(--b);
      padding: 22px 12px 16px;
      margin-bottom: 16px;
      background: var(--p);
      box-shadow: 0 0 24px rgba(0,136,0,.25), inset 0 0 32px rgba(0,48,0,.3);
    }
    .hdr-title {
      font-family: var(--ft);
      font-size: 3.6em;
      letter-spacing: 6px;
      color: var(--m);
      animation: pulse-m 4s ease-in-out infinite;
    }
    .hdr-sub {
      font-family: var(--ft);
      font-size: 1.55em;
      letter-spacing: 9px;
      color: var(--c);
      animation: pulse-c 5s ease-in-out infinite;
      margin: 6px 0 4px;
    }
    .hdr-meta { color: var(--c); letter-spacing: 5px; font-size: .9em; opacity: .8; }
    .hdr-gen  { color: var(--d); font-size: .78em; margin-top: 6px; }

    /* ── Score bar ──────────────────────────────────── */
    .scores {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      border: 1px solid var(--b);
      margin-bottom: 16px;
      background: var(--p);
    }
    .score { text-align: center; padding: 12px 6px; border-right: 1px solid var(--b); }
    .score:last-child { border-right: none; }
    .score-lbl { color: var(--d); font-size:.72em; letter-spacing:2px; text-transform:uppercase; }
    .score-val { font-family: var(--ft); font-size: 2.1em; margin-top: 2px; }

    /* ── Two-up panels ──────────────────────────────── */
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }
    .panel  {
      border: 1px solid var(--b);
      background: var(--p);
      padding: 14px 16px;
      box-shadow: inset 0 0 12px rgba(0,60,0,.15);
    }
    .panel-hdr {
      font-family: var(--ft);
      font-size: 1.35em;
      letter-spacing: 2px;
      color: var(--m);
      text-shadow: 0 0 6px var(--m);
      border-bottom: 1px solid var(--b);
      padding-bottom: 7px;
      margin-bottom: 10px;
    }
    .sr  { display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px solid rgba(0,80,0,.28); }
    .sl  { color: var(--d); }
    .sv  { color: var(--c); }
    .sv.gain { color: var(--G); }
    .sv.loss { color: var(--r); }
    .sv.yel  { color: var(--y); }
    .sv.big  { font-family:var(--ft); font-size:1.4em; color:var(--c); text-shadow:0 0 8px var(--c); }

    /* ── Section ────────────────────────────────────── */
    .sec     { margin-bottom: 20px; }
    .sec-hdr {
      font-family: var(--ft);
      font-size: 1.45em;
      letter-spacing: 2px;
      color: var(--m);
      text-shadow: 0 0 6px var(--m);
      border: 1px solid var(--b);
      border-bottom: none;
      padding: 7px 14px;
      background: #010201;
    }
    .sec-sub { color:var(--d); font-size:.7em; margin-left:6px; letter-spacing:1px; }

    /* ── Chart ──────────────────────────────────────── */
    .chart-wrap {
      border: 1px solid var(--b);
      background: var(--p);
      padding: 20px 16px 14px;
      position: relative;
      height: 380px;
    }

    /* ── Data tables ────────────────────────────────── */
    table { width: 100%; border-collapse: collapse; }
    .tbl  { border: 1px solid var(--b); background: var(--p); }
    .tbl thead th {
      background: #010e01;
      color: var(--y);
      text-transform: uppercase;
      font-size: .72em;
      letter-spacing: 2px;
      padding: 7px 9px;
      border-bottom: 1px solid var(--b);
      border-right: 1px solid rgba(0,80,0,.35);
      text-align: left;
    }
    .tbl thead th.num { text-align: right; }
    .tbl thead th.ctr { text-align: center; }
    .tbl tbody tr     { border-bottom: 1px solid rgba(0,60,0,.32); }
    .tbl tbody tr:hover { background: rgba(0,255,0,.04); }
    .tbl td {
      padding: 5px 9px;
      border-right: 1px solid rgba(0,55,0,.28);
      vertical-align: middle;
    }
    .tbl td:last-child { border-right: none; }
    .num { text-align: right; }
    .ctr { text-align: center; }

    /* ── Footer / Credits ───────────────────────────── */
    .ftr {
      text-align: center;
      color: var(--d);
      font-size: .74em;
      margin-top: 28px;
      padding: 10px;
      border-top: 1px solid var(--B);
    }
    .credits {
      text-align: center;
      margin-top: 10px;
      padding: 10px;
      font-size: .78em;
      letter-spacing: 3px;
      border-top: 1px dashed var(--B);
      color: var(--d);
    }

    @media (max-width: 900px) {
      .panels { grid-template-columns: 1fr; }
      .scores { grid-template-columns: repeat(3, 1fr); }
      .scores .score:nth-child(3) { border-right: none; }
      .chart-wrap { height: 280px; }
    }
  </style>
</head>
<body>
<div class="wrap flicker">

<!-- ═══  TITLE  ══════════════════════════════════════════════════════════════ -->
<div class="hdr">
  <div class="hdr-title">&#9878; SHANNON'S DEMON</div>
  <div class="hdr-sub">&#9608;&#9608;&#9608; ORDER FROM ENTROPY &middot; ALPHA FROM CHAOS &#9608;&#9608;&#9608;</div>
  <div class="hdr-meta">${d.symbol} &nbsp;&#183;&nbsp; MERCADO BITCOIN &nbsp;&#183;&nbsp; EST. ${d.snapshots[0]?.date_brt ?? '—'}</div>
  <div class="hdr-gen">
    GENERATED: ${d.generatedAt} BRT &nbsp;&#183;&nbsp;
    PRICE: <span data-live="price">R$${livePrice.toFixed(2)}</span>
    &nbsp;<span class="live-dot" title="Updates every 30s">&#9679; LIVE</span>
  </div>
  <div class="hdr-gen" style="font-size:.72em;margin-top:3px">
    LAST REFRESH: <span data-live="updated">${d.generatedAt} BRT</span>
  </div>
</div>

<!-- ═══  SCORE BAR  ══════════════════════════════════════════════════════════ -->
<div class="scores">
  <div class="score">
    <div class="score-lbl">&#128176; PORTFOLIO</div>
    <div class="score-val cyan" data-live="total">R$${liveTotal.toFixed(2)}</div>
  </div>
  <div class="score">
    <div class="score-lbl">&#128200; NET GAIN</div>
    <div class="score-val ${gainCls(netGain)}">${fmtBrl(netGain, true)}</div>
  </div>
  <div class="score">
    <div class="score-lbl">&#127919; RETURN</div>
    <div class="score-val ${retCls}" data-live="return" data-base-class="score-val">${fmtPct(liveReturn)}</div>
  </div>
  <div class="score">
    <div class="score-lbl">&#9889; REBALANCES</div>
    <div class="score-val">${tradeCount}</div>
  </div>
  <div class="score">
    <div class="score-lbl">&#9201; ACTIVE</div>
    <div class="score-val">${d.daysActive}&nbsp;DAYS</div>
  </div>
</div>

<!-- ═══  STATUS PANELS  ══════════════════════════════════════════════════════ -->
<div class="panels">
  <div class="panel">
    <div class="panel-hdr">&#128176; PORTFOLIO STATUS</div>
    <div class="sr"><span class="sl">${d.baseAsset} BALANCE</span><span class="sv">${totalBase.toFixed(6)} ${d.baseAsset}</span></div>
    <div class="sr"><span class="sl">BRL BALANCE</span><span class="sv">${fmtBrl(liveBrl)}</span></div>
    <div class="sr"><span class="sl">LIVE PRICE</span><span class="sv yel" data-live="price">R$${livePrice.toFixed(2)}</span></div>
    <div class="sr"><span class="sl">BASE VALUE</span><span class="sv" data-live="base-value">${fmtBrl(liveBaseVal)}</span></div>
    <div class="sr"><span class="sl">&#9472;&#9472; TOTAL &#9472;&#9472;</span><span class="sv big" data-live="total">${fmtBrl(liveTotal)}</span></div>
    <div class="sr"><span class="sl">RETURN</span><span class="sv ${retCls}" data-live="return-detail" data-base-class="sv">${fmtPct(liveReturn)} vs R$${d.initialTotal.toFixed(2)}</span></div>
    <div class="sr"><span class="sl">COST BASIS</span><span class="sv">R$${avgCost.toFixed(2)} / ${d.baseAsset}</span></div>
  </div>
  <div class="panel">
    <div class="panel-hdr">&#127919; BOT STATUS</div>
    <div class="sr"><span class="sl">STRATEGY</span><span class="sv mag">SHANNON'S DEMON</span></div>
    <div class="sr"><span class="sl">SYMBOL</span><span class="sv cyan">${d.symbol}</span></div>
    <div class="sr"><span class="sl">DEVIATION NOW</span><span class="sv ${devCls}">${liveDev} BPS ${devLabel}</span></div>
    <div class="sr"><span class="sl">THRESHOLD</span><span class="sv">${lastSnap?.effective_threshold_bps ?? '—'} BPS (ADAPTIVE)</span></div>
    <div class="sr"><span class="sl">LAST TRADE</span><span class="sv">${d.trades.length > 0 ? (d.trades[d.trades.length - 1]!.trade_date_brt ?? '—') : '—'}</span></div>
    <div class="sr"><span class="sl">TOTAL FEES PAID</span><span class="sv loss">&#8722;${fmtBrl(d.totalFees)}</span></div>
    <div class="sr"><span class="sl">REALIZED GAIN</span><span class="sv ${gainCls(d.totalRealizedGain)}">${fmtBrl(d.totalRealizedGain, true)}</span></div>
    <div class="sr"><span class="sl">TAX STATUS</span><span class="sv gain">&#10003; EXEMPT (LEI 9.250/1995)</span></div>
  </div>
</div>

<!-- ═══  STRATEGY CHART  ═════════════════════════════════════════════════════ -->
<div class="sec">
  <div class="sec-hdr">&#9878; STRATEGY SCOREBOARD
    <span class="sec-sub">&#9472; ${d.daysActive} DAYS &#183; &#9646;&#9646; SHANNON &nbsp; &#9646;&#9646; 50/50 HOLD &nbsp; &#9646;&#9646; ALL-IN ${d.baseAsset} &nbsp; &#9673; REBALANCE</span>
  </div>
  <div class="chart-wrap">
    <canvas id="bench-chart"></canvas>
  </div>
</div>

<!-- ═══  TRADE HISTORY  ══════════════════════════════════════════════════════ -->
<div class="sec">
  <div class="sec-hdr">&#9889; TRADE HISTORY <span class="sec-sub">&#9472; ${tradeCount} REBALANCES EXECUTED &#183; NEWEST FIRST</span></div>
  <table class="tbl">
    <thead>
      <tr>
        <th>#</th>
        <th>DATE / TIME (BRT)</th>
        <th>ACTION</th>
        <th class="num">${d.baseAsset} QTY</th>
        <th class="num">FILL PRICE</th>
        <th class="num">BRL AMT</th>
        <th class="num">FEE</th>
        <th class="num">GAIN / LOSS</th>
        <th class="num">DEV BPS</th>
      </tr>
    </thead>
    <tbody>${tradeRows}</tbody>
  </table>
</div>

<!-- ═══  TAX LEDGER  ════════════════════════════════════════════════════════ -->
<div class="sec">
  <div class="sec-hdr">&#128272; TAX LEDGER <span class="sec-sub">&#9472; LEI 9.250/1995 ART. 21 &#183; SELL PROCEEDS &#8804; R$35,000/MO = EXEMPT</span></div>
  <table class="tbl">
    <thead>
      <tr>
        <th>MONTH</th>
        <th class="num">TOTAL SELL PROCEEDS</th>
        <th class="num">REALIZED GAIN</th>
        <th>STATUS</th>
        <th>UTILISATION</th>
      </tr>
    </thead>
    <tbody>${taxRows}</tbody>
  </table>
</div>

<!-- ═══  FOOTER  ════════════════════════════════════════════════════════════ -->
<div class="ftr">
  SHANNON'S DEMON &#9612; ${d.symbol} &#9612; MERCADO BITCOIN &nbsp;&#183;&nbsp;
  INITIAL: R$${d.initialTotal.toFixed(2)} on ${d.snapshots[0]?.date_brt ?? '—'} &nbsp;&#183;&nbsp;
  DATA AS OF ${d.generatedAt} BRT &nbsp;&#183;&nbsp;
  <span style="color:var(--B)">shannonfi v1.0</span>
</div>
<div class="credits">
  FULL IMPLEMENTATION BY &nbsp;
  <span class="cyan">LUCAS SANTANA</span>
  <span class="dim">&nbsp;&amp;&nbsp;</span>
  <span class="mag">CLAUDE (ANTHROPIC)</span>
</div>

</div><!-- /.wrap -->

<!-- Chart.js -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>

<script>
// ── Baked-in constants ──────────────────────────────────────────────────────
var SYM   = '${d.symbol}';
var BASE  = SYM.split('-')[0];
var BBAL  = ${liveBase};
var QBAL  = ${liveBrl};
var INIT  = ${d.initialTotal};
var BENCH = ${benchJson};
var API   = 'https://api.mercadobitcoin.net/api/v4/tickers?symbols=' + SYM;

// ── Strategy chart ──────────────────────────────────────────────────────────
(function () {
  var labels  = BENCH.map(function (r) { return r.isLive ? r.date + ' ▶' : r.date; });
  var shannon = BENCH.map(function (r) { return r.shannon; });
  var bh50    = BENCH.map(function (r) { return r.bh50; });
  var bhAll   = BENCH.map(function (r) { return r.bhAll; });

  var ptRadius = BENCH.map(function (r) { return r.rebalanced ? 6 : r.isLive ? 5 : 2; });
  var ptColor  = BENCH.map(function (r) { return r.rebalanced ? '#00ffff' : r.isLive ? '#ffff00' : '#ff00ff'; });

  var mono = "'Share Tech Mono', monospace";

  new Chart(document.getElementById('bench-chart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: "⚖ Shannon's Demon",
          data: shannon,
          borderColor: '#ff00ff',
          backgroundColor: 'rgba(255,0,255,0.07)',
          borderWidth: 2.5,
          fill: true,
          tension: 0.35,
          pointRadius: ptRadius,
          pointBackgroundColor: ptColor,
          pointBorderColor: ptColor,
          pointHoverRadius: 7,
          order: 1,
        },
        {
          label: '50/50 Buy-and-Hold',
          data: bh50,
          borderColor: '#33ff33',
          backgroundColor: 'rgba(51,255,51,0.04)',
          borderWidth: 1.5,
          fill: false,
          tension: 0.35,
          pointRadius: BENCH.map(function (r) { return r.isLive ? 4 : 2; }),
          pointBackgroundColor: '#33ff33',
          pointHoverRadius: 5,
          order: 2,
        },
        {
          label: 'All-in ' + BASE,
          data: bhAll,
          borderColor: '#ffff00',
          backgroundColor: 'rgba(255,255,0,0.04)',
          borderWidth: 1.5,
          borderDash: [6, 3],
          fill: false,
          tension: 0.35,
          pointRadius: BENCH.map(function (r) { return r.isLive ? 4 : 2; }),
          pointBackgroundColor: '#ffff00',
          pointHoverRadius: 5,
          order: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#33ff33',
            font: { family: mono, size: 11 },
            padding: 18,
            boxWidth: 28,
            boxHeight: 2,
            usePointStyle: false,
          },
        },
        tooltip: {
          backgroundColor: '#010801',
          borderColor: '#007700',
          borderWidth: 1,
          titleColor: '#ff00ff',
          titleFont: { family: mono, size: 11 },
          bodyColor: '#33ff33',
          bodyFont: { family: mono, size: 11 },
          padding: 10,
          callbacks: {
            title: function (items) {
              var b = BENCH[items[0].dataIndex];
              return (items[0].label || '') + (b ? '  ·  HYPE R$' + b.price.toFixed(2) : '');
            },
            label: function (ctx) {
              var val  = ' R$' + ctx.parsed.y.toFixed(2);
              var b    = BENCH[ctx.dataIndex];
              var note = '';
              if (ctx.datasetIndex === 0 && b && b.rebalanced) note = '  ⚡ REBALANCED';
              if (b && b.isLive) note += '  ▶ LIVE';
              return ' ' + ctx.dataset.label + ': ' + val + note;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#446644', font: { family: mono, size: 10 }, maxRotation: 0 },
          grid:  { color: 'rgba(0,80,0,0.22)' },
          border:{ color: '#007700' },
        },
        y: {
          ticks: {
            color: '#446644',
            font: { family: mono, size: 10 },
            callback: function (v) { return 'R$' + Number(v).toFixed(0); },
          },
          grid:  { color: 'rgba(0,80,0,0.22)' },
          border:{ color: '#007700' },
        },
      },
    },
  });
})();

// ── Live price updates (every 30 s) ─────────────────────────────────────────
(function () {
  function fB(n) { return 'R$' + Math.abs(n).toFixed(2); }
  function fP(n) { var p = (n * 100).toFixed(2); return (n >= 0 ? '+' : '') + p + '%'; }
  function gC(n) { return n > 0.005 ? 'gain' : n < -0.005 ? 'loss' : 'neut'; }

  function refresh() {
    fetch(API)
      .then(function (r) { return r.json(); })
      .then(function (arr) {
        var tick = arr.find(function (t) { return t.pair === SYM; });
        if (!tick) return;
        var price = parseFloat(tick.last);
        var bval  = BBAL * price;
        var tot   = bval + QBAL;
        var ret   = (tot - INIT) / INIT;
        var rc    = gC(ret);

        document.querySelectorAll('[data-live="price"]').forEach(function (el) {
          el.textContent = 'R$' + price.toFixed(2);
        });
        document.querySelectorAll('[data-live="base-value"]').forEach(function (el) {
          el.textContent = fB(bval);
        });
        document.querySelectorAll('[data-live="total"]').forEach(function (el) {
          el.textContent = fB(tot);
        });
        document.querySelectorAll('[data-live="return"]').forEach(function (el) {
          el.textContent = fP(ret);
          el.className = (el.dataset.baseClass || '') + ' ' + rc;
        });
        document.querySelectorAll('[data-live="return-detail"]').forEach(function (el) {
          el.textContent = fP(ret) + ' vs R$' + INIT.toFixed(2);
          el.className = (el.dataset.baseClass || '') + ' ' + rc;
        });
        var ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
        document.querySelectorAll('[data-live="updated"]').forEach(function (el) {
          el.textContent = ts;
        });
      })
      .catch(function () { /* fail silently */ });
  }

  refresh();
  setInterval(refresh, 30000);
})();
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args    = process.argv.slice(2);
  const cfgIdx  = args.indexOf('--config');
  const cfgPath = cfgIdx !== -1 ? args[cfgIdx + 1] : undefined;
  const outIdx  = args.indexOf('--output');
  const outArg  = outIdx  !== -1 ? args[outIdx  + 1] : undefined;

  const config    = loadConfig(cfgPath);
  const baseAsset = config.symbol.split('-')[0]!;

  console.log(`\n=== Dashboard Generator: ${config.symbol} ===`);
  console.log(`DB: ${config.dbPath}`);

  const db = getDb(config.dbPath);

  const trades = db.prepare(`
    SELECT id, timestamp, direction, base_amount_filled, brl_amount_filled, fill_price,
           fee_brl, realized_gain_brl, before_total_value, after_total_value,
           before_deviation_bps, after_deviation_bps, trade_date_brt, status
    FROM trades WHERE status IN ('FILLED','DRY_RUN') ORDER BY timestamp ASC
  `).all() as TradeRow[];

  const snapshots = db.prepare(`
    SELECT date_brt, timestamp, total_value_brl, base_balance, brl_balance, base_price,
           base_ratio_bps, effective_threshold_bps, rebalanced_today
    FROM portfolio_snapshots ORDER BY date_brt ASC
  `).all() as SnapshotRow[];

  const taxEvents = db.prepare(`
    SELECT trade_id, trade_date_brt, month_brt, direction,
           traded_volume_brl, realized_gain_brl, cum_monthly_sales_brl, exempt
    FROM tax_events ORDER BY trade_date_brt ASC
  `).all() as TaxEventRow[];

  const costBasis = db.prepare(
    `SELECT asset, average_cost_brl, total_base, last_updated FROM cost_basis WHERE asset = ?`,
  ).get(baseAsset) as CostBasisRow | undefined;

  console.log(`Trades: ${trades.length}  Snapshots: ${snapshots.length}`);

  process.stdout.write('Fetching live price... ');
  const currentPrice = await fetchCurrentPrice(config.symbol);
  const lastSnap     = snapshots[snapshots.length - 1];
  console.log(currentPrice
    ? `R$${currentPrice.toFixed(2)} (last snapshot: R$${lastSnap?.base_price.toFixed(2) ?? '—'})`
    : `(unavailable — using last snapshot R$${lastSnap?.base_price.toFixed(2) ?? '—'})`);

  // ── Benchmark ─────────────────────────────────────────────────────────────
  const firstSnap    = snapshots[0];
  const initialTotal = firstSnap?.total_value_brl ?? 0;
  const initialHype  = firstSnap?.base_balance    ?? 0;
  const initialBrl   = firstSnap?.brl_balance     ?? 0;
  const initialPrice = firstSnap?.base_price      ?? 1;
  const allInQty     = initialTotal / initialPrice;

  const benchmark: BenchmarkRow[] = snapshots.map((s) => {
    const shannon = s.total_value_brl;
    const bhHalf  = initialHype * s.base_price + initialBrl;
    const bhAllIn = allInQty * s.base_price;
    return {
      date: s.date_brt, price: s.base_price,
      shannonValue: shannon, bhHalfValue: bhHalf, bhAllInValue: bhAllIn,
      excess: shannon - bhHalf, vsAllIn: shannon - bhAllIn,
      rebalanced: s.rebalanced_today === 1,
    };
  });

  if (currentPrice && lastSnap && Math.abs(currentPrice - lastSnap.base_price) > 0.005) {
    const shannon = lastSnap.base_balance * currentPrice + lastSnap.brl_balance;
    const bhHalf  = initialHype * currentPrice + initialBrl;
    const bhAllIn = allInQty   * currentPrice;
    benchmark.push({
      date: toDateBRT(new Date().toISOString()),
      price: currentPrice,
      shannonValue: shannon, bhHalfValue: bhHalf, bhAllInValue: bhAllIn,
      excess: shannon - bhHalf, vsAllIn: shannon - bhAllIn,
      rebalanced: false, isLive: true,
    });
  }

  // ── Monthly tax aggregation ───────────────────────────────────────────────
  const monthlySales: Record<string, MonthData> = {};
  for (const e of taxEvents) {
    if (e.direction !== 'SELL_BASE') continue;
    monthlySales[e.month_brt] ??= { sales: 0, gain: 0, exempt: true };
    monthlySales[e.month_brt]!.sales += e.traded_volume_brl;
    monthlySales[e.month_brt]!.gain  += e.realized_gain_brl;
    if (!e.exempt) monthlySales[e.month_brt]!.exempt = false;
  }

  const totalRealizedGain = trades
    .filter((t) => t.direction === 'SELL_BASE')
    .reduce((s, t) => s + (t.realized_gain_brl ?? 0), 0);
  const totalFees  = trades.reduce((s, t) => s + (t.fee_brl ?? 0), 0);
  const todayBRT   = toDateBRT(new Date().toISOString());
  const daysActive = firstSnap ? daysElapsed(firstSnap.date_brt, todayBRT) : 0;

  const data: DashboardData = {
    symbol: config.symbol, baseAsset,
    trades, snapshots, costBasis: costBasis ?? null, currentPrice,
    generatedAt: toBRT(new Date().toISOString()),
    benchmark, initialTotal, totalRealizedGain, totalFees, daysActive, monthlySales,
  };

  const html = generateHtml(data);

  const defaultOut = path.join(path.dirname(config.dbPath), 'dashboard.html');
  const outPath    = outArg ?? defaultOut;
  fs.writeFileSync(outPath, html, 'utf-8');

  const absPath = path.resolve(outPath);
  console.log(`\nDashboard written: ${outPath}`);
  console.log(`Open in browser:   file://${absPath}\n`);
}

main().catch((err) => {
  console.error('Dashboard generation failed:', (err as Error).stack ?? String(err));
  process.exit(1);
});
