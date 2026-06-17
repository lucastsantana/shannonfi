#!/usr/bin/env node
/**
 * Order reconciliation script.
 *
 * Fetches the full filled-order history from Mercado Bitcoin for the configured
 * symbol, compares against the local SQLite database, and inserts any trades
 * that executed on the exchange but were never recorded (e.g. due to the
 * getDb() connection-switch bug fixed in commit e911f96).
 *
 * Also rebuilds cost_basis from scratch using the now-complete trade list, and
 * fixes any duplicate asset rows left by the same bug.
 *
 * Usage:
 *   node dist/scripts/reconcile-orders.js --config configs/hype-mb.yaml [--dry-run]
 */

import { loadConfig } from '../config';
import { MbClient } from '../adapters/mercadobitcoin/client';
import { MbEndpoints } from '../adapters/mercadobitcoin/endpoints';
import { getMercadoBitcoinCredentials } from '../core/keyring';
import { getDb } from '../core/tracker/db';
import { TradeHistoryService } from '../core/tracker/history';
import { TaxService } from '../core/tracker/tax';
import { CostBasisService } from '../core/tracker/costbasis';
import { computeBaseRatioBps, computeDeviationBps } from '../math';
import { MbOrder } from '../adapters/mercadobitcoin/raw-types';
import { v4 as uuidv4 } from 'uuid';

const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

function toIso(ts: number | string): string {
  return typeof ts === 'number' ? new Date(ts * 1000).toISOString() : ts;
}

function toBRT(ts: number | string): string {
  const d = new Date(new Date(toIso(ts)).getTime() + BRT_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const args = process.argv.slice(2);
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
  const config = loadConfig(configPath);
  const baseAsset = config.symbol.split('-')[0]!;

  console.log(`\n=== Order Reconciliation: ${config.symbol} ===`);
  console.log(`DB: ${config.dbPath}`);
  if (isDryRun) console.log('DRY RUN — no changes will be written\n');

  // ── Connect to MB ────────────────────────────────────────────────────────────
  let clientId = process.env.MB_CLIENT_ID;
  let clientSecret = process.env.MB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const creds = getMercadoBitcoinCredentials();
    clientId = creds.clientId;
    clientSecret = creds.clientSecret;
  }

  const apiBaseUrl = config.exchange === 'mercadobitcoin' ? config.mercadobitcoin.apiBaseUrl : undefined;
  const client = new MbClient(clientId, clientSecret, apiBaseUrl);
  const endpoints = new MbEndpoints(client, config.symbol);
  const accountId = await endpoints.getAccountId();
  console.log(`Account ID: ${accountId}`);

  // ── Fetch all filled orders from MB (up to 200) ──────────────────────────────
  const orders = await endpoints.getOrders(accountId, 200);
  const filled = orders.filter((o) => o.status === 'filled');
  console.log(`Filled orders on exchange: ${filled.length}`);

  // ── Load recorded trades from DB ─────────────────────────────────────────────
  const db = getDb(config.dbPath);
  const history = new TradeHistoryService(config.dbPath);
  const recorded = history.readTrades();
  const recordedIds = new Set(recorded.map((t) => t.exchangeOrderId).filter(Boolean));
  const recordedClientIds = new Set(recorded.map((t) => t.clientOrderId).filter(Boolean));

  console.log(`Recorded in DB: ${recorded.length}`);

  // ── Find unrecorded orders ────────────────────────────────────────────────────
  const missing = filled.filter(
    (o) => !recordedIds.has(o.id) && !recordedClientIds.has(o.externalId ?? ''),
  ).sort((a, b) => (a.created_at as unknown as number) - (b.created_at as unknown as number));

  console.log(`Missing from DB: ${missing.length}`);

  if (missing.length === 0) {
    console.log('\nNothing to reconcile.');
    return;
  }

  // ── Display missing orders ────────────────────────────────────────────────────
  console.log('\nMissing orders:');
  for (const o of missing) {
    const side = o.side === 'buy' ? 'BUY_BASE ' : 'SELL_BASE';
    const qty = parseFloat(o.filledQty);
    const price = o.avgPrice;
    // MB omits `cost` on SELL orders — compute from qty * price
    const brl = o.cost ?? (qty * price);
    const fee = parseFloat(o.fee);
    console.log(
      `  ${toIso(o.created_at).slice(0, 19)}Z  ${side}  ` +
      `${qty.toFixed(6)} ${baseAsset}  @R$${price.toFixed(2)}  ` +
      `BRL=${brl.toFixed(2)}  fee=${fee.toFixed(4)}  id=${o.id}`,
    );
  }

  if (isDryRun) {
    console.log('\nDry run — stopping before writes.');
    return;
  }

  // ── Load portfolio snapshots to estimate before/after portfolio state ─────────
  const snapshots = history.readSnapshots().sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  function nearestSnapshot(iso: string) {
    const t = new Date(iso).getTime();
    // Prefer the snapshot from the same day or the nearest preceding one
    const before = snapshots.filter((s) => new Date(s.timestamp).getTime() <= t);
    if (before.length > 0) return before[before.length - 1]!;
    return snapshots.reduce((best, s) =>
      Math.abs(new Date(s.timestamp).getTime() - t) <
      Math.abs(new Date(best.timestamp).getTime() - t) ? s : best,
    );
  }

  // ── Fix duplicate cost_basis rows ─────────────────────────────────────────────
  // The bug could leave two rows with the same asset (PRIMARY KEY not enforced
  // when INSERT bypasses the ORM). Deduplicate by keeping the most recently updated.
  const dupRows = db.prepare(
    'SELECT asset, COUNT(*) as cnt FROM cost_basis GROUP BY asset HAVING cnt > 1'
  ).all() as { asset: string; cnt: number }[];

  for (const { asset } of dupRows) {
    console.log(`\nFixing duplicate cost_basis rows for ${asset}...`);
    const rows = db.prepare(
      'SELECT rowid, average_cost_brl, total_base, last_updated FROM cost_basis WHERE asset = ? ORDER BY last_updated DESC'
    ).all(asset) as { rowid: number; average_cost_brl: number; total_base: number; last_updated: string }[];
    // Keep the first (most recent), delete the rest
    for (const row of rows.slice(1)) {
      db.prepare('DELETE FROM cost_basis WHERE rowid = ?').run(row.rowid);
      console.log(`  Deleted stale row (rowid=${row.rowid}, last_updated=${row.last_updated})`);
    }
  }

  const tax = new TaxService(config.dbPath, config.jsonRetentionDays ?? 15);

  // ── Insert missing trades (DB only, no cost basis yet) ───────────────────────
  console.log('\nInserting missing trades:');

  const missingByTime = [...missing].sort(
    (a, b) => (a.created_at as unknown as number) - (b.created_at as unknown as number),
  );

  for (const o of missingByTime) {
    const direction = o.side === 'buy' ? 'BUY_BASE' : 'SELL_BASE';
    const baseAmountFilled = parseFloat(o.filledQty);
    const fillPrice = o.avgPrice;
    const brlAmountFilled = o.cost ?? (baseAmountFilled * fillPrice);
    const feeBrl = parseFloat(o.fee);
    const createdIso = toIso(o.created_at);
    const updatedIso = toIso(o.updated_at);
    const tradeDateBRT = toBRT(o.created_at);
    const snap = nearestSnapshot(createdIso);

    // Estimate before/after portfolio from nearest snapshot
    const beforeBaseBalance = snap.baseBalance;
    const beforeBrlBalance = snap.brlBalance;
    const beforeBasePrice = snap.basePrice;
    const beforeBaseValue = beforeBaseBalance * beforeBasePrice;
    const beforeTotal = beforeBaseValue + beforeBrlBalance;
    const beforeRatioBps = computeBaseRatioBps(beforeBaseValue, beforeTotal);
    const beforeDeviationBps = computeDeviationBps(beforeBaseValue, beforeBrlBalance);

    const afterBaseBalance = direction === 'BUY_BASE'
      ? beforeBaseBalance + baseAmountFilled
      : beforeBaseBalance - baseAmountFilled;
    const afterBrlBalance = direction === 'BUY_BASE'
      ? beforeBrlBalance - brlAmountFilled
      : beforeBrlBalance + brlAmountFilled - feeBrl;
    const afterBaseValue = afterBaseBalance * fillPrice;
    const afterTotal = afterBaseValue + afterBrlBalance;
    const afterRatioBps = computeBaseRatioBps(afterBaseValue, afterTotal);
    const afterDeviationBps = computeDeviationBps(afterBaseValue, afterBrlBalance);

    const tradeId = uuidv4();

    db.prepare(`
      INSERT OR IGNORE INTO trades (
        id, client_order_id, exchange_order_id, exchange, timestamp, direction,
        brl_amount_target, base_amount_filled, brl_amount_filled, fill_price, fee_brl,
        status, dry_run, realized_gain_brl, trade_date_brt,
        before_base_balance, before_brl_balance, before_base_price, before_base_value,
        before_total_value, before_base_ratio_bps, before_deviation_bps, before_timestamp,
        after_base_balance, after_brl_balance, after_base_price, after_base_value,
        after_total_value, after_base_ratio_bps, after_deviation_bps, after_timestamp
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      tradeId, o.externalId ?? `recovered-${o.id}`, o.id,
      'mercadobitcoin', createdIso, direction,
      brlAmountFilled, baseAmountFilled, brlAmountFilled, fillPrice, feeBrl,
      'FILLED', 0, 0 /* realized_gain_brl: corrected in rebuild below */, tradeDateBRT,
      beforeBaseBalance, beforeBrlBalance, beforeBasePrice, beforeBaseValue, beforeTotal,
      beforeRatioBps, beforeDeviationBps, snap.timestamp,
      afterBaseBalance, afterBrlBalance, fillPrice, afterBaseValue, afterTotal,
      afterRatioBps, afterDeviationBps, updatedIso,
    );

    // Tax event placeholder — realized_gain_brl corrected in rebuild below
    db.prepare(`
      INSERT OR IGNORE INTO tax_events (
        trade_id, trade_date_brt, month_brt, direction,
        traded_volume_brl, gross_proceeds_brl, cost_basis_brl, realized_gain_brl,
        cum_monthly_sales_brl, cum_monthly_gain_brl, exempt, payment_deadline, exchange
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tradeId, tradeDateBRT, tradeDateBRT.slice(0, 7), direction,
      direction === 'SELL_BASE' ? brlAmountFilled : 0,
      direction === 'SELL_BASE' ? brlAmountFilled : 0,
      0, 0, 0, 0, 1, null, 'mercadobitcoin',
    );

    const side = direction === 'BUY_BASE' ? 'BUY ' : 'SELL';
    console.log(
      `  ✓ ${tradeDateBRT}  ${side}  ${baseAmountFilled.toFixed(6)} ${baseAsset}  ` +
      `@R$${fillPrice.toFixed(2)}  BRL=${brlAmountFilled.toFixed(2)}  [${o.id}]`,
    );
  }

  // ── Rebuild cost basis and tax events from all trades in chronological order ──
  console.log('\nRebuilding cost basis and tax events from full trade history...');
  db.prepare('UPDATE cost_basis SET average_cost_brl = 0, total_base = 0, last_updated = ? WHERE asset = ?')
    .run(new Date().toISOString(), baseAsset);
  db.prepare('INSERT OR IGNORE INTO cost_basis (asset) VALUES (?)').run(baseAsset);

  const costBasis = new CostBasisService(config.dbPath, config.jsonRetentionDays ?? 15, baseAsset);

  // Read all trades (recorded + newly inserted) sorted chronologically
  const allTrades = (db.prepare(
    `SELECT id, direction, base_amount_filled, brl_amount_filled, fill_price, trade_date_brt
     FROM trades WHERE status IN ('FILLED','DRY_RUN') ORDER BY timestamp ASC`
  ).all() as {
    id: string;
    direction: string;
    base_amount_filled: number;
    brl_amount_filled: number;
    fill_price: number;
    trade_date_brt: string;
  }[]);

  // Running monthly sale totals for tax
  const monthlySalesBrl: Record<string, number> = {};
  const monthlyGainBrl: Record<string, number> = {};

  for (const t of allTrades) {
    const month = t.trade_date_brt.slice(0, 7);
    monthlySalesBrl[month] = monthlySalesBrl[month] ?? 0;
    monthlyGainBrl[month] = monthlyGainBrl[month] ?? 0;

    let realizedGainBrl = 0;
    let costBasisBrl = 0;

    if (t.direction === 'BUY_BASE') {
      costBasis.updateAfterBuy(t.base_amount_filled, t.brl_amount_filled);
    } else {
      const avgCost = costBasis.getLedger().base.averageCostBrl;
      costBasisBrl = avgCost * t.base_amount_filled;
      realizedGainBrl = costBasis.updateAfterSell(t.base_amount_filled, t.brl_amount_filled);
      monthlySalesBrl[month]! += t.brl_amount_filled;
      monthlyGainBrl[month]! += realizedGainBrl;
    }

    const cumMonthlySales = monthlySalesBrl[month]!;
    const cumMonthlyGain = monthlyGainBrl[month]!;
    const exempt = cumMonthlySales <= 35000 ? 1 : 0;
    const paymentDeadline = exempt ? null : tax.computePaymentDeadline(month);

    // Update the trade with correct realized gain
    db.prepare('UPDATE trades SET realized_gain_brl = ? WHERE id = ?').run(realizedGainBrl, t.id);

    // Upsert tax event with correct values
    db.prepare(`
      INSERT OR REPLACE INTO tax_events (
        trade_id, trade_date_brt, month_brt, direction,
        traded_volume_brl, gross_proceeds_brl, cost_basis_brl, realized_gain_brl,
        cum_monthly_sales_brl, cum_monthly_gain_brl, exempt, payment_deadline, exchange
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      t.id, t.trade_date_brt, month, t.direction,
      t.direction === 'SELL_BASE' ? t.brl_amount_filled : 0,
      t.direction === 'SELL_BASE' ? t.brl_amount_filled : 0,
      costBasisBrl, realizedGainBrl,
      t.direction === 'SELL_BASE' ? cumMonthlySales : 0,
      t.direction === 'SELL_BASE' ? cumMonthlyGain : 0,
      exempt, paymentDeadline, 'mercadobitcoin',
    );
  }

  const finalLedger = costBasis.getLedger();
  console.log('Final cost basis:');
  console.log(`  ${baseAsset}: avg R$${finalLedger.base.averageCostBrl.toFixed(2)}, total ${finalLedger.base.totalBase.toFixed(6)}`);

  // ── Summary ───────────────────────────────────────────────────────────────────
  const totalNow = history.readTrades().length;
  console.log(`\nDone. Trades in DB: ${recorded.length} → ${totalNow}`);
}

main().catch((err) => {
  console.error('Reconciliation failed:', (err as Error).stack ?? (err as Error).message);
  process.exit(1);
});
