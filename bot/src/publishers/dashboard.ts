#!/usr/bin/env node
/**
 * Dashboard generator.
 * Reads all data from the local SQLite database and renders a self-contained
 * retro-style HTML portfolio dashboard with a live strategy chart and
 * client-side 30-second price updates via MB's public tickers API.
 *
 * Usage: ts-node src/publishers/dashboard.ts --config configs/hype-mb.yaml
 * Output: <dbDir>/dashboard.html
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { getDb } from '../core/tracker/db';
import { GOOGLE_FONTS_HTML, DARK_THEME_VARS, SHARED_TEXT_CLASSES } from './theme';

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

interface StrategyStats {
  windowReturn: number;
  annualizedReturn: number;
  annualizedVol: number;
  sharpe: number;
  sortino: number;
  valueAtRisk95: number;
  maxDrawdown: number;
}

interface BenchmarkStats {
  shannon: StrategyStats;
  bh50: StrategyStats;
  allIn: StrategyStats;
}

interface DashboardData {
  symbol: string;
  baseAsset: string;
  exchangeName: string;
  trades: TradeRow[];
  snapshots: SnapshotRow[];
  costBasis: CostBasisRow | null;
  currentPrice: number | null;
  generatedAt: string;
  benchmark: BenchmarkRow[];
  benchmarkStats: BenchmarkStats;
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

function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const v = n.toFixed(2);
  return n >= 0 ? `+${v}` : v;
}

/**
 * Historical (empirical) 95% Value at Risk over the given per-period
 * returns: the loss magnitude such that 95% of observed periods did not
 * lose more than this. Returned as a positive fraction (e.g. 0.05 = 5%);
 * 0 if there's no observed downside at the 5th percentile.
 */
function computeValueAtRisk95(periodReturns: number[]): number {
  if (periodReturns.length === 0) return 0;
  const sorted = [...periodReturns].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(0.05 * sorted.length), sorted.length - 1);
  return Math.max(0, -sorted[idx]!);
}

/**
 * Maximum peak-to-trough decline in the value series, as a positive
 * fraction (e.g. 0.123 = a 12.3% drawdown from the running peak).
 */
function computeMaxDrawdown(values: number[]): number {
  let peak = values[0] ?? 0;
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) maxDD = Math.max(maxDD, (peak - v) / peak);
  }
  return maxDD;
}

/**
 * Computes window/annualized return, annualized volatility, Sharpe,
 * Sortino (target = 0, risk-free rate assumed 0), 95% historical VaR, and
 * max drawdown from a series of portfolio values sampled on the given
 * dates. Annualization scales by the actual average sampling interval
 * rather than assuming exactly daily spacing, since a snapshot day can
 * occasionally be missed.
 */
function computeStrategyStats(values: number[], dates: string[]): StrategyStats {
  const n = values.length;
  if (n < 2 || values[0] === 0) {
    return {
      windowReturn: 0, annualizedReturn: 0, annualizedVol: 0, sharpe: 0, sortino: 0,
      valueAtRisk95: 0, maxDrawdown: 0,
    };
  }

  const windowReturn = values[n - 1]! / values[0]! - 1;
  const totalDays = Math.max(1, daysElapsed(dates[0]!, dates[n - 1]!));
  const annualizedReturn = Math.pow(1 + windowReturn, 365 / totalDays) - 1;

  const periodReturns: number[] = [];
  for (let i = 1; i < n; i++) periodReturns.push(values[i]! / values[i - 1]! - 1);

  const periodsPerYear = (365 * periodReturns.length) / totalDays;
  const mean = periodReturns.reduce((s, r) => s + r, 0) / periodReturns.length;
  const variance = periodReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / periodReturns.length;
  const annualizedVol = Math.sqrt(variance * periodsPerYear);

  const downsideVariance =
    periodReturns.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / periodReturns.length;
  const annualizedDownsideDev = Math.sqrt(downsideVariance * periodsPerYear);

  const sharpe  = annualizedVol > 0 ? annualizedReturn / annualizedVol : 0;
  const sortino = annualizedDownsideDev > 0 ? annualizedReturn / annualizedDownsideDev : 0;

  const valueAtRisk95 = computeValueAtRisk95(periodReturns);
  const maxDrawdown   = computeMaxDrawdown(values);

  return { windowReturn, annualizedReturn, annualizedVol, sharpe, sortino, valueAtRisk95, maxDrawdown };
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

  // ── Benchmark stats rows ─────────────────────────────────────────────────────
  const statRows = [
    { label: "&#9878; SHANNON'S DEMON", cls: 'mag', s: d.benchmarkStats.shannon },
    { label: '50/50 BUY-AND-HOLD',      cls: 'gain', s: d.benchmarkStats.bh50 },
    { label: `ALL-IN ${d.baseAsset}`,   cls: 'yel', s: d.benchmarkStats.allIn },
  ].map((row) => `
        <tr>
          <td class="${row.cls}">${row.label}</td>
          <td class="num ${gainCls(row.s.windowReturn)}">${fmtPct(row.s.windowReturn)}</td>
          <td class="num ${gainCls(row.s.annualizedReturn)}">${fmtPct(row.s.annualizedReturn)}</td>
          <td class="num">${fmtPct(row.s.annualizedVol)}</td>
          <td class="num ${gainCls(row.s.sharpe)}">${fmtRatio(row.s.sharpe)}</td>
          <td class="num ${gainCls(row.s.sortino)}">${fmtRatio(row.s.sortino)}</td>
          <td class="num loss">${fmtPct(-row.s.valueAtRisk95)}</td>
          <td class="num loss">${fmtPct(-row.s.maxDrawdown)}</td>
        </tr>`).join('');

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
  <script>
    // Set theme before first paint to avoid a flash of the wrong mode.
    // Dark is always the default regardless of system preference; light
    // mode only applies once a visitor explicitly chooses it (persisted).
    (function () {
      try {
        if (localStorage.getItem('shannonfi-theme') === 'light') {
          document.documentElement.setAttribute('data-theme', 'light');
        }
      } catch (e) { /* ignore (e.g. storage disabled) */ }
    })();
  </script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shannon's Demon — Volatility-Harvesting Rebalancer for ${d.symbol}</title>
  <meta name="description" content="Live dashboard and full strategy writeup for Shannon's Demon, a volatility-harvesting rebalancing strategy run on ${d.symbol} (${d.exchangeName}). Track real performance vs. buy-and-hold benchmarks, Sharpe/Sortino ratios, trade history, and read the math behind why mechanical rebalancing captures a return from volatility alone.">
  <meta name="keywords" content="Shannon's Demon, volatility harvesting, rebalancing strategy, portfolio rebalancing, ${d.symbol}, ${d.baseAsset}, algorithmic trading, crypto trading bot, ${d.exchangeName}, mean reversion, Sharpe ratio, Sortino ratio">
  <meta name="author" content="Lucas Santana">
  <meta name="theme-color" content="#000000">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://lucastsantana.github.io/shannonfi/">

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://lucastsantana.github.io/shannonfi/">
  <meta property="og:site_name" content="Shannon's Demon">
  <meta property="og:title" content="Shannon's Demon — Volatility-Harvesting Rebalancer for ${d.symbol}">
  <meta property="og:description" content="Live performance dashboard and full strategy writeup: how mechanical rebalancing between ${d.baseAsset} and BRL captures a return from volatility alone, with real trade history and benchmark comparisons.">
  <meta property="og:locale" content="en_US">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Shannon's Demon — Volatility-Harvesting Rebalancer for ${d.symbol}">
  <meta name="twitter:description" content="Live performance dashboard and full strategy writeup for a volatility-harvesting rebalancing bot on ${d.symbol}.">

  <link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='#000'/><text x='50' y='68' font-size='60' text-anchor='middle'>&#9878;</text></svg>`,
  )}">

  <script type="application/ld+json">
  ${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: "Shannon's Demon",
    alternateName: `Shannon's Demon — ${d.symbol}`,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Any (web-based)',
    description: `Open-source volatility-harvesting rebalancing bot and live performance dashboard for ${d.symbol}. Educational/informational only — not financial advice.`,
    url: 'https://lucastsantana.github.io/shannonfi/',
    author: { '@type': 'Person', name: 'Lucas Santana', url: 'https://github.com/lucastsantana' },
    isAccessibleForFree: true,
  })}
  </script>

  ${GOOGLE_FONTS_HTML.trim()}
  <style>
    *, *::before, *::after {
      box-sizing: border-box; margin: 0; padding: 0;
      transition: background-color .3s ease, color .3s ease, border-color .3s ease,
                  box-shadow .3s ease, text-shadow .3s ease;
    }

    /* ── Theme palette ──────────────────────────────────
       Same hue families in both modes (blue, orange-red,
       cyan/teal, magenta, yellow/amber) — light mode darkens
       and de-saturates them for legibility on a light page,
       since the dark mode's neon values are unreadable on white.
       Dark-mode values come from theme.ts, shared with the PDF report. */
    :root {${DARK_THEME_VARS}
    }

    [data-theme="light"] {
      --g:    #1a3a66; --g-rgb:    26,58,102;
      --G:    #0a58d6; --G-rgb:    10,88,214;
      --b:    #b9c2d6; --b-rgb:    185,194,214;
      --B:    #d8deea; --B-rgb:    216,222,234;
      --c:    #007a8a; --c-rgb:    0,122,138;
      --m:    #b300b3; --m-rgb:    179,0,179;
      --y:    #8a6d00; --y-rgb:    138,109,0;
      --r:    #cc3700; --r-rgb:    204,55,0;
      --d:    #5b6b85; --d-rgb:    91,107,133;
      --bg:   #eef1f7; --bg-rgb:   238,241,247;
      --p:    #ffffff; --p-rgb:    255,255,255;
      --neut: #555555;
      --ov-rgb:    90,100,120;
      --hdr2-bg:   #f5f7fb;
      --hdr3-bg:   #eef1f8;
      --nscr-bg:   #ffe0d0;
      --nscr-fg:   #aa2200;
    }

    /* Dark is the unconditional default — no system-preference auto-switch,
       for JS or no-JS visitors alike. Light mode only applies once a
       visitor explicitly toggles it (see the anti-flash script above and
       the theme-toggle script below, both gated on an explicit choice). */

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
        rgba(var(--ov-rgb),0) 0px, rgba(var(--ov-rgb),0) 2px,
        rgba(var(--ov-rgb),0.18) 3px, rgba(var(--ov-rgb),0) 4px
      );
    }
    [data-theme="light"] body::before {
      background: repeating-linear-gradient(
        to bottom,
        rgba(var(--ov-rgb),0) 0px, rgba(var(--ov-rgb),0) 2px,
        rgba(var(--ov-rgb),0.05) 3px, rgba(var(--ov-rgb),0) 4px
      );
    }

    /* CRT vignette */
    body::after {
      content: '';
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 9998; pointer-events: none;
      background: radial-gradient(ellipse at center, transparent 60%, rgba(var(--ov-rgb),0.65) 100%);
    }
    [data-theme="light"] body::after {
      background: radial-gradient(ellipse at center, transparent 65%, rgba(var(--ov-rgb),0.12) 100%);
    }

    @keyframes blink    { 0%,49%{opacity:1} 50%,100%{opacity:0} }
    @keyframes flicker  { 0%{opacity:.99} 5%{opacity:.91} 10%{opacity:1}
                          72%{opacity:.97} 78%{opacity:1} 92%{opacity:.95} 96%{opacity:1} }
    @keyframes pulse-m  { 0%,100%{text-shadow:0 0 6px var(--m),0 0 14px var(--m)}
                          50%{text-shadow:0 0 12px var(--m),0 0 28px var(--m),0 0 50px rgba(var(--m-rgb),.4)} }
    @keyframes pulse-c  { 0%,100%{text-shadow:0 0 5px var(--c),0 0 10px var(--c)}
                          50%{text-shadow:0 0 10px var(--c),0 0 22px var(--c),0 0 40px rgba(var(--c-rgb),.35)} }
    @keyframes pulse-live { 0%,100%{opacity:1;color:var(--G)} 50%{opacity:0.35;color:var(--g)} }

    .blink   { animation: blink 1.1s step-end infinite; }
    .flicker { animation: flicker 9s linear infinite; }
    .live-dot{ animation: pulse-live 2s ease-in-out infinite; font-size:.8em; }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
    }

    a { text-decoration: none; }
    a:hover { text-decoration: underline; opacity: .85; }

    /* ── Typography ─────────────────────────────────── */
    ${SHARED_TEXT_CLASSES.trim()}

    /* ── Layout ─────────────────────────────────────── */
    .wrap { max-width: 1380px; margin: 0 auto; }

    /* ── Header ─────────────────────────────────────── */
    .hdr {
      text-align: center;
      border: 2px solid var(--b);
      padding: 22px 12px 16px;
      margin-bottom: 16px;
      background: var(--p);
      box-shadow: 0 0 24px rgba(var(--G-rgb),.25), inset 0 0 32px rgba(var(--G-rgb),.3);
    }
    .hdr-title {
      font-family: var(--ft);
      font-size: 3.6em;
      letter-spacing: 6px;
      color: var(--m);
      animation: pulse-m 4s ease-in-out infinite;
    }
    .hdr-emoji {
      display: block;
      color: var(--y);
      text-shadow: 0 0 10px var(--y), 0 0 22px var(--y);
      animation: none;
    }
    .hdr-sub {
      font-family: var(--ft);
      font-size: 1.05em;
      letter-spacing: 9px;
      color: var(--c);
      animation: pulse-c 5s ease-in-out infinite;
      margin: 6px 0;
    }
    .hdr-meta {
      display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline;
      gap: 4px 8px; color: var(--y); letter-spacing: 3px; font-size: .9em; opacity: .9;
    }
    .hdr-meta span { white-space: nowrap; }
    .hdr-meta .sep { opacity: .5; letter-spacing: 0; }
    .hdr-gen  {
      display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline;
      gap: 4px 10px; color: var(--d); font-size: .78em; margin-top: 6px;
    }
    .hdr-gen .unit { white-space: nowrap; }

    /* ── Score bar ──────────────────────────────────── */
    .scores {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      border: 1px solid var(--b);
      margin-bottom: 16px;
      background: var(--p);
    }
    .score { text-align: center; padding: 12px 6px; border-right: 1px solid var(--b); transition: background .15s ease, border-color .3s ease; }
    .score:last-child { border-right: none; }
    .score:hover { background: rgba(var(--G-rgb),.08); }
    .score-lbl { color: var(--d); font-size:.72em; letter-spacing:2px; text-transform:uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .score-val { font-family: var(--ft); font-size: 2.1em; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* ── Two-up panels ──────────────────────────────── */
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }
    .panel  {
      border: 1px solid var(--b);
      background: var(--p);
      padding: 14px 16px;
      box-shadow: inset 0 0 12px rgba(var(--G-rgb),.15);
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
    .sr  { display:flex; flex-wrap: wrap; justify-content:space-between; align-items:baseline; gap: 2px 10px; padding:4px 0; border-bottom:1px solid rgba(var(--b-rgb),.28); }
    .sl  { color: var(--d); white-space: nowrap; }
    .sv  { color: var(--c); white-space: nowrap; text-align: right; }
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
      background: var(--hdr2-bg);
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
    .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; min-width: 560px; }
    .tbl  { border: 1px solid var(--b); background: var(--p); }
    .tbl thead th {
      background: var(--hdr3-bg);
      color: var(--y);
      text-transform: uppercase;
      font-size: .72em;
      letter-spacing: 2px;
      padding: 7px 9px;
      border-bottom: 1px solid var(--b);
      border-right: 1px solid rgba(var(--b-rgb),.35);
      text-align: left;
      white-space: nowrap;
    }
    .tbl thead th.num { text-align: right; }
    .tbl thead th.ctr { text-align: center; }
    .tbl tbody tr     { border-bottom: 1px solid rgba(var(--b-rgb),.32); transition: background .12s ease, border-color .3s ease; }
    .tbl tbody tr:hover { background: rgba(var(--G-rgb),.08); }
    .tbl td {
      padding: 5px 9px;
      border-right: 1px solid rgba(var(--b-rgb),.28);
      vertical-align: middle;
      white-space: nowrap;
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

    /* ── Theme toggle ───────────────────────────────── */
    .theme-toggle {
      position: fixed;
      top: 14px; right: 14px;
      z-index: 10000;
      width: 38px; height: 38px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--b);
      background: var(--p);
      color: var(--y);
      font-size: 1.2em;
      line-height: 1;
      padding: 0;
      cursor: pointer;
      box-shadow: 0 0 10px rgba(var(--ov-rgb),.3);
    }
    .theme-toggle:hover { color: var(--m); border-color: var(--m); }
    @media (max-width: 480px) {
      .theme-toggle { top: 8px; right: 8px; width: 32px; height: 32px; font-size: 1em; }
    }

    /* ── Tabs ───────────────────────────────────────── */
    .tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 16px;
      border: 1px solid var(--b);
      background: var(--p);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .tab-btn {
      flex: 1;
      font-family: var(--ft);
      font-size: 1.25em;
      letter-spacing: 2px;
      color: var(--d);
      background: transparent;
      border: none;
      padding: 10px 8px;
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      transition: color .15s, background .15s, box-shadow .3s ease;
    }
    .tab-btn:hover { color: var(--c); background: rgba(var(--G-rgb),.06); }
    .tab-btn[aria-selected="true"] {
      color: var(--m);
      text-shadow: 0 0 6px var(--m);
      background: rgba(var(--m-rgb),.06);
      box-shadow: inset 0 -3px 0 var(--m);
    }
    .tab-panel[hidden] { display: none; }
    .tab-panel {
      opacity: 1;
      transform: translateY(0);
      transition: opacity .22s ease, transform .22s ease;
    }
    .tab-panel.tab-fade {
      opacity: 0;
      transform: translateY(6px);
    }

    /* ── Inline footnotes (sit directly under/inside the box they explain) ── */
    .fn-inline {
      margin-top: 10px;
      padding-top: 9px;
      border-top: 1px dashed var(--b);
      font-size: .74em;
      line-height: 1.55;
      color: var(--d);
    }
    .fn-inline p { margin-bottom: 5px; }
    .fn-inline p:last-child { margin-bottom: 0; }
    .fn-inline strong { color: var(--c); letter-spacing: .5px; }
    .fn-inline-group {
      border: 1px solid var(--b);
      border-top: none;
      background: var(--p);
      padding: 10px 14px;
      margin-top: -16px;
      margin-bottom: 16px;
    }

    /* ── Strategy tab prose ─────────────────────────── */
    .prose { border: 1px solid var(--b); background: var(--p); padding: 18px 20px; margin-bottom: 16px; }
    .prose h2 {
      font-family: var(--ft); font-size: 1.5em; letter-spacing: 2px; color: var(--m);
      text-shadow: 0 0 6px var(--m); margin-bottom: 10px;
    }
    .prose h2:not(:first-child) { margin-top: 22px; }
    .prose h3 { font-family: var(--ft); font-size: 1.15em; letter-spacing: 1px; color: var(--c); margin: 14px 0 6px; }
    .prose p  { margin-bottom: 10px; color: var(--g); }
    .prose ul, .prose ol { margin: 8px 0 12px 1.4em; color: var(--g); }
    .prose li { margin-bottom: 6px; line-height: 1.55; }
    .prose code { color: var(--y); font-family: var(--fn); }
    .prose strong { color: var(--c); }
    .prose .formula {
      display: block; margin: 10px 0; padding: 10px 14px;
      border-left: 2px solid var(--m); background: rgba(var(--m-rgb),.04);
      font-family: var(--fn); color: var(--y); overflow-x: auto; white-space: pre;
    }

    /* ── Disclaimer & legal ─────────────────────────── */
    .disclaimer {
      border: 1px solid var(--r);
      background: rgba(var(--r-rgb),.05);
      padding: 14px 16px;
      margin-bottom: 16px;
      color: var(--g);
    }
    .disclaimer h3 { color: var(--r); font-family: var(--ft); letter-spacing: 1px; margin-bottom: 10px; font-size: 1.15em; }
    .disclaimer p { margin-bottom: 8px; font-size: .85em; line-height: 1.55; }
    .disclaimer p:last-child { margin-bottom: 0; }

    .legal-bar {
      text-align: center;
      color: var(--d);
      font-size: .68em;
      line-height: 1.6;
      margin-top: 14px;
      padding: 12px 10px;
      border-top: 1px solid var(--B);
    }
    .legal-bar strong { color: var(--r); }
    .copyright {
      text-align: center;
      color: var(--d);
      font-size: .7em;
      margin-top: 8px;
      padding-bottom: 4px;
    }

    @media (max-width: 900px) {
      .panels { grid-template-columns: 1fr; }
      .scores { grid-template-columns: repeat(3, 1fr); }
      .scores .score:nth-child(3) { border-right: none; }
      .chart-wrap { height: 280px; }
    }

    @media (max-width: 480px) {
      body { padding: 8px; font-size: 13px; }
      .hdr { padding: 16px 8px 12px; }
      .hdr-title { font-size: 1.9em; letter-spacing: 3px; }
      .hdr-sub  { font-size: .78em; letter-spacing: 4px; }
      .hdr-meta { font-size: .76em; letter-spacing: 1.5px; gap: 3px 6px; }
      .hdr-gen  { font-size: .74em; gap: 3px 8px; }
      .scores { grid-template-columns: repeat(2, 1fr); }
      .scores .score:nth-child(3) { border-right: 1px solid var(--b); }
      .scores .score:nth-child(2n) { border-right: none; }
      .score { padding: 10px 4px; }
      .score-val { font-size: 1.5em; }
      .score-lbl { font-size: .68em; letter-spacing: .5px; }
      .panel { padding: 10px 12px; }
      .panel-hdr { font-size: 1.1em; }
      .sr { font-size: .92em; }
      .sv.big { font-size: 1.15em; }
      .sec-hdr { font-size: 1.1em; padding: 6px 10px; }
      .sec-sub { display: block; margin-left: 0; margin-top: 2px; font-size: .78em; }
      .chart-wrap { height: 230px; padding: 14px 8px 10px; }
      table { min-width: 480px; }
      .tbl thead th, .tbl td { padding: 6px 8px; font-size: .82em; }
      .tabs { gap: 0; }
      .tab-btn { font-size: .95em; letter-spacing: 1px; padding: 8px 10px; }
      .prose { padding: 12px 14px; }
      .prose h2 { font-size: 1.2em; }
      .prose h3 { font-size: 1em; }
      .prose .formula { font-size: .85em; }
      .disclaimer { padding: 10px 12px; }
    }
  </style>
</head>
<body>
<noscript><div style="background:var(--nscr-bg);color:var(--nscr-fg);padding:10px;text-align:center;font-family:monospace">⚠ JavaScript required for live price updates, the strategy chart, and light/dark mode.</div></noscript>
<button type="button" id="theme-toggle" class="theme-toggle" aria-label="Toggle light/dark mode" title="Toggle light/dark mode">&#127769;</button>
<div class="wrap flicker" role="main">

<!-- ═══  TITLE  ══════════════════════════════════════════════════════════════ -->
<header class="hdr" role="banner">
  <div class="hdr-title" role="heading" aria-level="1"><span class="hdr-emoji" aria-hidden="true">&#9878;</span>SHANNON'S DEMON</div>
  <div class="hdr-sub" aria-hidden="true">&#9608;&#9608;&#9608; ORDER FROM ENTROPY &middot; ALPHA FROM CHAOS &#9608;&#9608;&#9608;</div>
  <div class="hdr-meta">
    <span>${d.symbol}</span><span class="sep" aria-hidden="true">&#183;</span>
    <span>${d.exchangeName.toUpperCase()}</span><span class="sep" aria-hidden="true">&#183;</span>
    <span>EST. ${d.snapshots[0]?.date_brt ?? '—'}</span>
  </div>
  <div class="hdr-gen">
    <span class="unit">PRICE: <span data-live="price" aria-label="live price" aria-live="polite">R$${livePrice.toFixed(2)}</span></span>
    <span class="unit"><span class="live-dot" aria-hidden="true" title="Updates every 30s">&#9679; LIVE</span></span>
    <span class="unit">LAST REFRESH: <span data-live="updated" aria-live="polite">${d.generatedAt} BRT</span></span>
  </div>
</header>

<!-- ═══  TABS  ═══════════════════════════════════════════════════════════════ -->
<div class="tabs" role="tablist" aria-label="Dashboard sections">
  <button type="button" id="tab-dashboard" class="tab-btn" role="tab" aria-selected="true" aria-controls="panel-dashboard">&#128202; DASHBOARD</button>
  <button type="button" id="tab-strategy" class="tab-btn" role="tab" aria-selected="false" aria-controls="panel-strategy">&#128214; STRATEGY &amp; DISCLAIMERS</button>
</div>

<div id="panel-dashboard" class="tab-panel" role="tabpanel" aria-labelledby="tab-dashboard">

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
<div class="fn-inline fn-inline-group">
  <p><strong class="cyan">PORTFOLIO</strong> &mdash; current total value: live ${d.baseAsset} balance &times; live price, plus BRL cash on hand. Recomputed every 30s from the public ticker.</p>
  <p><strong class="cyan">NET GAIN</strong> &mdash; realized gain from closed SELL trades, minus all exchange fees paid across every trade. Does not include unrealized (mark-to-market) gains on the base asset currently held &mdash; see RETURN for that.</p>
  <p><strong class="cyan">RETURN</strong> &mdash; (current PORTFOLIO minus INITIAL portfolio value at the first recorded snapshot) divided by INITIAL. Updates live; includes unrealized gains/losses on the held position.</p>
  <p><strong class="cyan">REBALANCES</strong> &mdash; count of executed trades (FILLED or DRY_RUN) since the bot started tracking this instance.</p>
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
    <div class="fn-inline">
      <p><strong class="cyan">LIVE PRICE</strong> &mdash; fetched from the exchange's public ticker API every 30 seconds client-side; falls back to the last recorded snapshot price if the fetch fails.</p>
      <p><strong class="cyan">COST BASIS</strong> &mdash; the AVCO (average cost) per unit of ${d.baseAsset}, updated on every BUY and used to compute realized gain/loss on every SELL.</p>
    </div>
  </div>
  <div class="panel">
    <div class="panel-hdr">&#129302; BOT STATUS</div>
    <div class="sr"><span class="sl">STRATEGY</span><span class="sv mag">SHANNON'S DEMON</span></div>
    <div class="sr"><span class="sl">SYMBOL</span><span class="sv cyan">${d.symbol}</span></div>
    <div class="sr"><span class="sl">DEVIATION NOW</span><span class="sv ${devCls}">${liveDev} BPS ${devLabel}</span></div>
    <div class="sr"><span class="sl">THRESHOLD</span><span class="sv">${lastSnap?.effective_threshold_bps ?? '—'} BPS (ADAPTIVE)</span></div>
    <div class="sr"><span class="sl">LAST TRADE</span><span class="sv">${d.trades.length > 0 ? (d.trades[d.trades.length - 1]!.trade_date_brt ?? '—') : '—'}</span></div>
    <div class="sr"><span class="sl">TOTAL FEES PAID</span><span class="sv loss">&#8722;${fmtBrl(d.totalFees)}</span></div>
    <div class="sr"><span class="sl">REALIZED GAIN</span><span class="sv ${gainCls(d.totalRealizedGain)}">${fmtBrl(d.totalRealizedGain, true)}</span></div>
    <div class="sr"><span class="sl">TAX STATUS</span><span class="sv gain">&#10003; EXEMPT (LEI 9.250/1995)</span></div>
    <div class="fn-inline">
      <p><strong class="cyan">DEVIATION NOW</strong> &mdash; how far the portfolio currently sits from a perfect 50/50 split, in basis points (BPS = 1/100 of 1%; 100 BPS = 1%). BALANCED / DRIFTING / ALERT are visual bands around that number.</p>
      <p><strong class="cyan">THRESHOLD (ADAPTIVE)</strong> &mdash; how far deviation must drift before a rebalance fires. Recalculated once per day from realized volatility rather than fixed, so calm markets don't get over-traded and volatile markets aren't under-traded. Full formula in the STRATEGY tab.</p>
      <p><strong class="cyan">TAX STATUS</strong> &mdash; under Brazilian law (Lei 9.250/1995, Art. 21), an individual's domestic crypto SELL proceeds are exempt from capital-gains tax up to R$35,000 in total sales per calendar month, across all domestic crypto sales by that person. General information, not tax advice &mdash; see the STRATEGY tab.</p>
    </div>
  </div>
</div>

<!-- ═══  STRATEGY CHART  ═════════════════════════════════════════════════════ -->
<section class="sec" aria-label="Strategy Scoreboard">
  <div class="sec-hdr">&#9878; STRATEGY SCOREBOARD
    <span class="sec-sub">&#9472; ${d.daysActive} DAYS &#183; &#9646;&#9646; SHANNON &nbsp; &#9646;&#9646; 50/50 HOLD &nbsp; &#9646;&#9646; ALL-IN ${d.baseAsset} &nbsp; &#9673; REBALANCE</span>
  </div>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th scope="col">STRATEGY</th>
          <th scope="col" class="num">RETURN (WINDOW)</th>
          <th scope="col" class="num">ANN. RETURN</th>
          <th scope="col" class="num">ANN. VOLATILITY</th>
          <th scope="col" class="num">SHARPE</th>
          <th scope="col" class="num">SORTINO</th>
          <th scope="col" class="num">VaR (95%)</th>
          <th scope="col" class="num">MAX DRAWDOWN</th>
        </tr>
      </thead>
      <tbody>${statRows}</tbody>
    </table>
  </div>
  <div class="fn-inline">
    <p><strong class="cyan">STRATEGY SCOREBOARD</strong> &mdash; compares this bot's actual performance against two passive benchmarks computed from the same price history: a 50/50 buy-and-hold that never rebalances, and a 100%-${d.baseAsset} buy-and-hold. ANN. = annualized (scaled to a 1-year period from the actual sampling window). Sharpe and Sortino both assume a 0% risk-free rate. <strong class="cyan">VaR (95%)</strong> is the historical (empirical) per-period loss such that 95% of observed periods did not lose more &mdash; a higher magnitude means fatter downside tails. <strong class="cyan">MAX DRAWDOWN</strong> is the worst peak-to-trough decline over the whole window. Full methodology in the STRATEGY tab.</p>
  </div>
  <div class="chart-wrap">
    <canvas id="bench-chart" role="img" aria-label="Line chart comparing Shannon's Demon, 50/50 Buy-and-Hold, and All-in ${d.baseAsset} portfolio values over time"></canvas>
  </div>
  <div class="fn-inline">
    <p><strong class="cyan">CHART LEGEND</strong> &mdash; solid magenta = this bot's actual value; solid blue = 50/50 buy-and-hold; dashed yellow = 100%-${d.baseAsset} buy-and-hold. A cyan dot marks a day a rebalance executed; a yellow dot marks the current live (intraday) point, not yet a closed daily snapshot.</p>
  </div>
</section>

<!-- ═══  TRADE HISTORY  ══════════════════════════════════════════════════════ -->
<section class="sec" aria-label="Trade History">
  <div class="sec-hdr">&#9889; TRADE HISTORY <span class="sec-sub">&#9472; ${tradeCount} REBALANCES EXECUTED &#183; NEWEST FIRST</span></div>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">DATE / TIME (BRT)</th>
          <th scope="col">ACTION</th>
          <th scope="col" class="num">${d.baseAsset} QTY</th>
          <th scope="col" class="num">FILL PRICE</th>
          <th scope="col" class="num">BRL AMT</th>
          <th scope="col" class="num">FEE</th>
          <th scope="col" class="num">GAIN / LOSS</th>
          <th scope="col" class="num">DEV BPS</th>
        </tr>
      </thead>
      <tbody>${tradeRows}</tbody>
    </table>
  </div>
  <div class="fn-inline">
    <p><strong class="cyan">TRADE HISTORY</strong> &mdash; DEV BPS shows the deviation immediately before &#8594; immediately after each trade, i.e. how off-target the portfolio was right before it fired and how close to 50/50 it landed afterward.</p>
  </div>
</section>

<!-- ═══  TAX LEDGER  ════════════════════════════════════════════════════════ -->
<section class="sec" aria-label="Tax Ledger">
  <div class="sec-hdr">&#128272; TAX LEDGER <span class="sec-sub">&#9472; LEI 9.250/1995 ART. 21 &#183; SELL PROCEEDS &#8804; R$35,000/MO = EXEMPT</span></div>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th scope="col">MONTH</th>
          <th scope="col" class="num">TOTAL SELL PROCEEDS</th>
          <th scope="col" class="num">REALIZED GAIN</th>
          <th scope="col">STATUS</th>
          <th scope="col">UTILISATION</th>
        </tr>
      </thead>
      <tbody>${taxRows}</tbody>
    </table>
  </div>
  <div class="fn-inline">
    <p><strong class="cyan">TAX LEDGER</strong> &mdash; under Brazilian law (Lei 9.250/1995, Art. 21), an individual's domestic crypto SELL proceeds are exempt from capital-gains tax up to R$35,000 in total sales per calendar month, across all domestic crypto sales by that person, not per asset or per exchange. EXEMPT/TAXABLE reflects cumulative monthly SELL volume against that limit. General information, not tax advice &mdash; see the STRATEGY tab.</p>
  </div>
</section>

</div><!-- /panel-dashboard -->

<!-- ═══  STRATEGY & DISCLAIMERS TAB  ════════════════════════════════════════ -->
<div id="panel-strategy" class="tab-panel" role="tabpanel" aria-labelledby="tab-strategy" hidden>

  <article class="prose">
    <h2>&#9878; What Is Shannon's Demon?</h2>
    <p>Shannon's Demon is a volatility-harvesting technique named after Claude Shannon, the founder of information theory, who reportedly used it as a thought experiment about how mechanical rebalancing between a risky asset and cash can produce a positive expected return even when the risky asset itself has <strong>zero</strong> expected return &mdash; purely from variance, with no directional forecast required.</p>
    <p>This bot maintains a fixed <strong>50% ${d.baseAsset} / 50% BRL</strong> split. Whenever price moves push that split away from 50/50 by more than a threshold, it sells the outperforming side and buys the underperforming side, mechanically restoring the target ratio. Each round-trip oscillation (price up then back down, or down then back up) that triggers a rebalance tends to bank a small profit, because the bot is structurally buying dips and selling rallies relative to its own prior rebalance point.</p>

    <h3>The Math Intuition</h3>
    <p>Starting from a balanced 50/50 portfolio of value <code>V</code>, if the base asset's price moves by factor <code>f</code> and then fully reverts back to where it started, a buy-and-hold portfolio ends exactly where it began (zero net return). A portfolio that rebalances at the top of the move, however, captures a small excess return on top of that round trip:</p>
    <span class="formula">Excess gain &thickapprox; V &times; r&sup2; / 4&nbsp;&nbsp;(for a small price move of return r)</span>
    <p>The gain is <strong>quadratic in the size of the price swing</strong> &mdash; bigger oscillations produce disproportionately more profit per cycle. A worked example: ${d.baseAsset} doubles then halves back to its starting price. Buy-and-hold nets 0%. Rebalancing once at the top nets roughly <strong>+12.5%</strong> on the same round trip. This is why the strategy specifically wants a <em>volatile, mean-reverting</em> market &mdash; it has nothing to do with predicting direction.</p>

    <h3>Why the Adaptive Threshold?</h3>
    <p>A fixed rebalance threshold is wrong in either regime: too tight in calm markets (fees eat the tiny gains from noise-level rebalances), too loose in volatile markets (real opportunities get missed waiting for an oversized move). The bot instead computes the mean absolute daily return over a rolling 30-day window and scales the threshold to it:</p>
    <span class="formula">threshold_bps = clamp(round(MAD &times; 10,000 &times; multiplier), 50, 500)</span>
    <p>The 50 BPS floor exists because below roughly 0.5% drift, market-order spreads and exchange fees consume the entire expected volatility premium &mdash; rebalancing that often would be a net loser even in a perfectly mean-reverting market. The 500 BPS ceiling exists so an extreme-volatility regime can't push the threshold so high that the bot stops rebalancing altogether.</p>

    <h3>Other Built-In Safeguards</h3>
    <ul>
      <li><strong>Cooldown</strong> &mdash; a minimum time must pass between rebalances, even if drift would otherwise justify one, to avoid over-trading on noisy intraday ticks.</li>
      <li><strong>Day-trade guard</strong> &mdash; blocks a same-BRT-day trade in the opposite direction of an earlier trade that day, preventing whipsaw round-trips that mostly just generate fees.</li>
      <li><strong>Minimum trade/portfolio size</strong> &mdash; skips trades too small to be worth the fixed cost of a market order, and skips rebalancing altogether below a minimum portfolio value.</li>
      <li><strong>Monthly tax exemption cap</strong> (optional, Mercado Bitcoin only) &mdash; can cap SELL volume to stay under the R$35,000/month Lei 9.250 exemption threshold, at the cost of leaving the portfolio temporarily off-target.</li>
    </ul>

    <h3>Why Track Cost Basis &amp; Taxes?</h3>
    <p>Every SELL realizes a gain or loss versus the AVCO (average cost) of the position, which matters for Brazilian capital-gains reporting. Brazilian individuals get a monthly exemption (Lei 9.250/1995, Art. 21) on domestic crypto sales up to R$35,000/month in aggregate &mdash; across <em>all</em> domestic crypto sales by that person, not per bot or per asset. The bot tracks this per-instance only; if you trade the same exchange account elsewhere, you are responsible for combining totals yourself.</p>

    <h2>&#9888; Risks &amp; Limitations</h2>
    <ul>
      <li><strong>Requires volatility, not direction.</strong> In a market that trends strongly in one direction without reverting, this strategy underperforms a simple buy-and-hold of the winning asset &mdash; see the ALL-IN ${d.baseAsset} benchmark on the Dashboard tab, which can and does outperform Shannon's Demon during sustained rallies.</li>
      <li><strong>Fees and slippage are real costs.</strong> Every rebalance pays a taker fee and may fill slightly worse than the displayed price. In sufficiently calm or choppy-but-not-volatile conditions, accumulated fees can exceed the volatility premium captured.</li>
      <li><strong>Single-asset concentration risk.</strong> Half the portfolio is, at all times, exposed to one base asset's price going to zero (project failure, exchange delisting, etc.). Shannon's Demon does not protect against permanent loss of value in the asset itself.</li>
      <li><strong>Counterparty / exchange risk.</strong> Funds sit on a centralized exchange account. Exchange insolvency, account freezes, API outages, or security breaches are not mitigated by this strategy.</li>
      <li><strong>Credential and operational risk.</strong> API keys are loaded from a local keyring or CI secrets; a compromised key could be used to trade or withdraw, depending on the permissions granted to it.</li>
      <li><strong>Backtests and past performance are not predictive.</strong> The Strategy Scoreboard reflects what already happened in this specific historical window for this specific symbol. Different time windows, different assets, or the same asset's future behavior can produce materially different (including negative) results.</li>
      <li><strong>Software risk.</strong> This is a small, actively-developed personal project, not an audited financial product. Bugs in threshold calculation, order execution, or tax/cost-basis tracking are possible despite test coverage.</li>
    </ul>
  </article>

  <div class="disclaimer">
    <h3>&#9888; LEGAL DISCLAIMER &mdash; READ BEFORE RELYING ON ANYTHING ON THIS PAGE</h3>
    <p>This dashboard and the strategy it describes are provided <strong>for informational and educational purposes only</strong>. Nothing on this page constitutes financial, investment, tax, legal, or accounting advice, nor a recommendation or solicitation to buy, sell, or hold any asset. The operator of this bot is an individual, not a registered investment advisor, broker-dealer, or financial institution in any jurisdiction.</p>
    <p>Cryptocurrency trading involves substantial risk of loss, including the possible loss of the entire amount invested, and is not suitable for all individuals. Past performance &mdash; including every figure shown on the Dashboard tab (returns, Sharpe, Sortino, backtests) &mdash; is not indicative of future results. Markets can and do behave in ways that make this strategy lose money, including but not limited to sustained one-directional trends, extreme low-volatility regimes, exchange outages, and flash crashes.</p>
    <p>All data shown is generated automatically from this bot's own trade and price history and is provided "as is", without warranty of any kind, express or implied, including without limitation accuracy, completeness, or fitness for a particular purpose. The operator and any contributors disclaim all liability for any direct, indirect, incidental, or consequential loss or damage arising from the use of, or reliance on, this page or the underlying software.</p>
    <p>Tax information referencing Lei 9.250/1995 Art. 21 is a general, non-exhaustive summary of one provision of Brazilian tax law as understood at the time this dashboard was built, may be incomplete or outdated, and does not account for your individual circumstances. Consult a licensed accountant or tax professional in your jurisdiction before making any tax filing decisions.</p>
    <p><strong>Use this software, and act on anything shown here, entirely at your own risk.</strong></p>
  </div>

</div><!-- /panel-strategy -->

<!-- ═══  FOOTER  ════════════════════════════════════════════════════════════ -->
<footer class="ftr" role="contentinfo">
  SHANNON'S DEMON &#9612; ${d.symbol} &#9612; ${d.exchangeName.toUpperCase()} &nbsp;&#183;&nbsp;
  INITIAL: R$${d.initialTotal.toFixed(2)} on ${d.snapshots[0]?.date_brt ?? '—'} &nbsp;&#183;&nbsp;
  <span style="color:var(--B)">shannonfi v1.0</span>
</footer>
<div class="credits">
  FULL IMPLEMENTATION BY &nbsp;
  <a class="cyan" href="https://github.com/lucastsantana" target="_blank" rel="noopener noreferrer">LUCAS SANTANA</a>
  <span class="dim">&nbsp;&amp;&nbsp;</span>
  <a class="mag" href="https://claude.ai" target="_blank" rel="noopener noreferrer">CLAUDE (ANTHROPIC)</a>
</div>

<div class="legal-bar">
  <strong>&#9888; NOT FINANCIAL ADVICE.</strong> Informational/educational only &mdash; not a recommendation to buy, sell, or hold any asset.
  Cryptocurrency trading risks total loss of capital. Past performance does not guarantee future results.
  See the &#128214; STRATEGY &amp; DISCLAIMERS tab above for full risk disclosures before relying on anything shown here.
</div>
<div class="copyright">
  &copy; ${new Date().getFullYear()} Lucas Santana. All rights reserved. Dashboard generation co-authored with Claude (Anthropic).
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

// ── Theme-aware color reader ─────────────────────────────────────────────────
// Chart.js draws to a <canvas>, which can't resolve CSS var() itself — colors
// must be read as concrete strings, and re-read whenever the theme toggles.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function chartTheme() {
  return {
    m: cssVar('--m'), mRgb: cssVar('--m-rgb'),
    G: cssVar('--G'), GRgb: cssVar('--G-rgb'),
    y: cssVar('--y'), yRgb: cssVar('--y-rgb'),
    c: cssVar('--c'),
    g: cssVar('--g'),
    d: cssVar('--d'),
    p: cssVar('--p'),
    grid: 'rgba(' + cssVar('--G-rgb') + ',0.22)',
  };
}

// ── Strategy chart ──────────────────────────────────────────────────────────
var benchChart = null;
(function () {
  var labels  = BENCH.map(function (r) { return r.isLive ? r.date + ' ▶' : r.date; });
  var shannon = BENCH.map(function (r) { return r.shannon; });
  var bh50    = BENCH.map(function (r) { return r.bh50; });
  var bhAll   = BENCH.map(function (r) { return r.bhAll; });

  var ptRadius = BENCH.map(function (r) { return r.rebalanced ? 6 : r.isLive ? 5 : 2; });
  var liveOrDefaultRadius = BENCH.map(function (r) { return r.isLive ? 4 : 2; });

  var mono = "'Share Tech Mono', monospace";
  var th = chartTheme();
  var ptColor = BENCH.map(function (r) { return r.rebalanced ? th.c : r.isLive ? th.y : th.m; });

  benchChart = new Chart(document.getElementById('bench-chart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: "⚖ Shannon's Demon",
          data: shannon,
          borderColor: th.m,
          backgroundColor: 'rgba(' + th.mRgb + ',0.07)',
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
          borderColor: th.G,
          backgroundColor: 'rgba(' + th.GRgb + ',0.05)',
          borderWidth: 1.5,
          fill: false,
          tension: 0.35,
          pointRadius: liveOrDefaultRadius,
          pointBackgroundColor: th.G,
          pointHoverRadius: 5,
          order: 2,
        },
        {
          label: 'All-in ' + BASE,
          data: bhAll,
          borderColor: th.y,
          backgroundColor: 'rgba(' + th.yRgb + ',0.04)',
          borderWidth: 1.5,
          borderDash: [6, 3],
          fill: false,
          tension: 0.35,
          pointRadius: liveOrDefaultRadius,
          pointBackgroundColor: th.y,
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
            color: th.g,
            font: { family: mono, size: 11 },
            padding: 18,
            boxWidth: 28,
            boxHeight: 2,
            usePointStyle: false,
          },
        },
        tooltip: {
          backgroundColor: th.p,
          borderColor: th.d,
          borderWidth: 1,
          titleColor: th.m,
          titleFont: { family: mono, size: 11 },
          bodyColor: th.g,
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
          ticks: { color: th.d, font: { family: mono, size: 10 }, maxRotation: 0 },
          grid:  { color: th.grid },
          border:{ color: th.d },
        },
        y: {
          ticks: {
            color: th.d,
            font: { family: mono, size: 10 },
            callback: function (v) { return 'R$' + Number(v).toFixed(0); },
          },
          grid:  { color: th.grid },
          border:{ color: th.d },
        },
      },
    },
  });
})();

// Re-colors the chart in place when the theme toggles, without recreating it.
function repaintChartForTheme() {
  if (!benchChart) return;
  var th = chartTheme();
  var ptColor = BENCH.map(function (r) { return r.rebalanced ? th.c : r.isLive ? th.y : th.m; });

  var ds = benchChart.data.datasets;
  ds[0].borderColor = th.m;
  ds[0].backgroundColor = 'rgba(' + th.mRgb + ',0.07)';
  ds[0].pointBackgroundColor = ptColor;
  ds[0].pointBorderColor = ptColor;
  ds[1].borderColor = th.G;
  ds[1].backgroundColor = 'rgba(' + th.GRgb + ',0.05)';
  ds[1].pointBackgroundColor = th.G;
  ds[2].borderColor = th.y;
  ds[2].backgroundColor = 'rgba(' + th.yRgb + ',0.04)';
  ds[2].pointBackgroundColor = th.y;

  var o = benchChart.options;
  o.plugins.legend.labels.color = th.g;
  o.plugins.tooltip.backgroundColor = th.p;
  o.plugins.tooltip.borderColor = th.d;
  o.plugins.tooltip.titleColor = th.m;
  o.plugins.tooltip.bodyColor = th.g;
  o.scales.x.ticks.color = th.d;
  o.scales.x.grid.color = th.grid;
  o.scales.x.border.color = th.d;
  o.scales.y.ticks.color = th.d;
  o.scales.y.grid.color = th.grid;
  o.scales.y.border.color = th.d;

  benchChart.update();
}

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
        var now = new Date();
        var brtMs = now.getTime() - 3 * 60 * 60 * 1000;
        var ts = new Date(brtMs).toISOString().replace('T', ' ').slice(0, 19) + ' BRT';
        document.querySelectorAll('[data-live="updated"]').forEach(function (el) {
          el.textContent = ts;
        });
      })
      .catch(function () { /* fail silently */ });
  }

  refresh();
  setInterval(refresh, 30000);
})();

// ── Tab switching (cross-fade rather than an instant cut) ───────────────────
(function () {
  var tabs = {
    dashboard: { btn: document.getElementById('tab-dashboard'), panel: document.getElementById('panel-dashboard') },
    strategy:  { btn: document.getElementById('tab-strategy'),  panel: document.getElementById('panel-strategy') },
  };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FADE_MS = reduceMotion ? 0 : 220;
  var current = tabs.strategy.panel.hasAttribute('hidden') ? 'dashboard' : 'strategy';

  function activate(name) {
    if (name === current || !tabs[name]) return;
    var from = tabs[current];
    var to = tabs[name];
    current = name;

    tabs.dashboard.btn.setAttribute('aria-selected', name === 'dashboard' ? 'true' : 'false');
    tabs.strategy.btn.setAttribute('aria-selected', name === 'strategy' ? 'true' : 'false');

    from.panel.classList.add('tab-fade');
    setTimeout(function () {
      from.panel.setAttribute('hidden', '');
      from.panel.classList.remove('tab-fade');

      to.panel.removeAttribute('hidden');
      to.panel.classList.add('tab-fade');
      void to.panel.offsetHeight; // force reflow so the faded-out start state registers
      requestAnimationFrame(function () {
        to.panel.classList.remove('tab-fade');
      });
    }, FADE_MS);
  }

  tabs.dashboard.btn.addEventListener('click', function () { activate('dashboard'); });
  tabs.strategy.btn.addEventListener('click', function () { activate('strategy'); });

  if (location.hash === '#strategy') activate('strategy');
})();

// ── Theme toggle ─────────────────────────────────────────────────────────────
(function () {
  var btn = document.getElementById('theme-toggle');
  var metaTheme = document.querySelector('meta[name="theme-color"]');

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyIcon(theme) {
    // Show the icon for the mode you'd switch TO.
    btn.innerHTML = theme === 'light' ? '&#127769;' : '&#9728;&#65039;';
  }

  function setTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    try { localStorage.setItem('shannonfi-theme', theme); } catch (e) { /* ignore */ }
    if (metaTheme) metaTheme.setAttribute('content', cssVar('--bg') || (theme === 'light' ? '#eef1f7' : '#000000'));
    applyIcon(theme);
    repaintChartForTheme();
  }

  applyIcon(currentTheme());
  btn.addEventListener('click', function () {
    setTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });
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

  const rebalancedDates = new Set(
    trades.map((t) => t.trade_date_brt).filter(Boolean),
  );

  const benchmark: BenchmarkRow[] = snapshots.map((s) => {
    const shannon = s.total_value_brl;
    const bhHalf  = initialHype * s.base_price + initialBrl;
    const bhAllIn = allInQty * s.base_price;
    return {
      date: s.date_brt, price: s.base_price,
      shannonValue: shannon, bhHalfValue: bhHalf, bhAllInValue: bhAllIn,
      excess: shannon - bhHalf, vsAllIn: shannon - bhAllIn,
      rebalanced: rebalancedDates.has(s.date_brt),
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

  const benchDates = benchmark.map((b) => b.date);
  const benchmarkStats: BenchmarkStats = {
    shannon: computeStrategyStats(benchmark.map((b) => b.shannonValue), benchDates),
    bh50:    computeStrategyStats(benchmark.map((b) => b.bhHalfValue),  benchDates),
    allIn:   computeStrategyStats(benchmark.map((b) => b.bhAllInValue), benchDates),
  };

  const totalRealizedGain = trades
    .filter((t) => t.direction === 'SELL_BASE')
    .reduce((s, t) => s + (t.realized_gain_brl ?? 0), 0);
  const totalFees  = trades.reduce((s, t) => s + (t.fee_brl ?? 0), 0);
  const todayBRT   = toDateBRT(new Date().toISOString());
  const daysActive = firstSnap ? daysElapsed(firstSnap.date_brt, todayBRT) : 0;

  const exchangeName = config.exchange === 'mercadobitcoin' ? 'Mercado Bitcoin' : 'Binance';

  const data: DashboardData = {
    symbol: config.symbol, baseAsset, exchangeName,
    trades, snapshots, costBasis: costBasis ?? null, currentPrice,
    generatedAt: toBRT(new Date().toISOString()),
    benchmark, benchmarkStats, initialTotal, totalRealizedGain, totalFees, daysActive, monthlySales,
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
