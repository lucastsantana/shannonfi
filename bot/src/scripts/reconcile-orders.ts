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

function toBRT(iso: string): string {
  const d = new Date(new Date(iso).getTime() + BRT_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
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
  ).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

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
    const brl = o.cost;
    const fee = parseFloat(o.fee);
    console.log(
      `  ${o.created_at.slice(0, 19)}Z  ${side}  ` +
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

  // ── Reset cost_basis to rebuild from scratch ──────────────────────────────────
  console.log(`\nResetting ${baseAsset} cost basis to rebuild from full trade history...`);
  db.prepare('UPDATE cost_basis SET average_cost_brl = 0, total_base = 0 WHERE asset = ?').run(baseAsset);

  const costBasis = new CostBasisService(config.dbPath, config.jsonRetentionDays ?? 15, baseAsset);
  const tax = new TaxService(config.dbPath, config.jsonRetentionDays ?? 15);

  // ── Replay all existing recorded trades to rebuild cost basis state ───────────
  const allRecorded = [...recorded].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  console.log('\nReplaying recorded trades to restore cost basis:');
  for (const t of allRecorded) {
    if (t.status !== 'FILLED' && t.status !== 'DRY_RUN') continue;
    if (t.direction === 'BUY_BASE' && t.baseAmountFilled != null) {
      costBasis.updateAfterBuy(t.baseAmountFilled, t.brlAmountFilled ?? t.brlAmountTarget);
      console.log(`  ${t.timestamp.slice(0, 10)} BUY  +${t.baseAmountFilled.toFixed(6)} ${baseAsset}`);
    } else if (t.direction === 'SELL_BASE' && t.baseAmountFilled != null) {
      costBasis.updateAfterSell(t.baseAmountFilled, t.brlAmountFilled ?? t.brlAmountTarget);
      console.log(`  ${t.timestamp.slice(0, 10)} SELL -${t.baseAmountFilled.toFixed(6)} ${baseAsset}`);
    }
  }

  // ── Insert each missing trade in chronological order ─────────────────────────
  console.log('\nInserting missing trades:');

  // Build a mutable list of all trades (recorded + missing) to interleave correctly
  const missingByTime = [...missing].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  for (const o of missingByTime) {
    const direction = o.side === 'buy' ? 'BUY_BASE' : 'SELL_BASE';
    const baseAmountFilled = parseFloat(o.filledQty);
    const brlAmountFilled = o.cost;
    const fillPrice = o.avgPrice;
    const feeBrl = parseFloat(o.fee);
    const tradeDateBRT = toBRT(o.created_at);
    const snap = nearestSnapshot(o.created_at);

    // Estimate before portfolio from nearest snapshot (best available approximation)
    const beforeBaseBalance = snap.baseBalance;
    const beforeBrlBalance = snap.brlBalance;
    const beforeBasePrice = snap.basePrice;
    const beforeBaseValue = beforeBaseBalance * beforeBasePrice;
    const beforeTotal = beforeBaseValue + beforeBrlBalance;
    const beforeRatioBps = computeBaseRatioBps(beforeBaseValue, beforeTotal);
    const beforeDeviationBps = computeDeviationBps(beforeBaseValue, beforeBrlBalance);

    // Estimate after portfolio
    let afterBaseBalance: number;
    let afterBrlBalance: number;
    if (direction === 'BUY_BASE') {
      afterBaseBalance = beforeBaseBalance + baseAmountFilled;
      afterBrlBalance = beforeBrlBalance - brlAmountFilled;
    } else {
      afterBaseBalance = beforeBaseBalance - baseAmountFilled;
      afterBrlBalance = beforeBrlBalance + brlAmountFilled - feeBrl;
    }
    const afterBaseValue = afterBaseBalance * fillPrice;
    const afterTotal = afterBaseValue + afterBrlBalance;
    const afterRatioBps = computeBaseRatioBps(afterBaseValue, afterTotal);
    const afterDeviationBps = computeDeviationBps(afterBaseValue, afterBrlBalance);

    // Cost basis
    let realizedGainBrl = 0;
    if (direction === 'BUY_BASE') {
      costBasis.updateAfterBuy(baseAmountFilled, brlAmountFilled);
    } else {
      realizedGainBrl = costBasis.updateAfterSell(baseAmountFilled, brlAmountFilled);
    }

    const ledger = costBasis.getLedger();
    const costBasisBrl = ledger.base.averageCostBrl * baseAmountFilled;
    const tradeId = uuidv4();

    // Build trade record matching the DB schema
    const tradeRecord = {
      id: tradeId,
      clientOrderId: o.externalId ?? `recovered-${o.id}`,
      exchangeOrderId: o.id,
      exchange: 'mercadobitcoin',
      timestamp: o.created_at,
      direction,
      brlAmountTarget: brlAmountFilled,
      baseAmountFilled,
      brlAmountFilled,
      fillPrice,
      feeBrl,
      status: 'FILLED',
      dryRun: 0,
      realizedGainBrl,
      tradeDateBRT,
      beforeBaseBalance,
      beforeBrlBalance,
      beforeBasePrice,
      beforeBaseValue,
      beforeTotal,
      beforeRatioBps,
      beforeDeviationBps,
      beforeTimestamp: snap.timestamp,
      afterBaseBalance,
      afterBrlBalance,
      afterBasePrice: fillPrice,
      afterBaseValue,
      afterTotal,
      afterRatioBps,
      afterDeviationBps,
      afterTimestamp: o.updated_at,
    };

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
      tradeRecord.id, tradeRecord.clientOrderId, tradeRecord.exchangeOrderId,
      tradeRecord.exchange, tradeRecord.timestamp, tradeRecord.direction,
      tradeRecord.brlAmountTarget, tradeRecord.baseAmountFilled, tradeRecord.brlAmountFilled,
      tradeRecord.fillPrice, tradeRecord.feeBrl,
      tradeRecord.status, tradeRecord.dryRun, tradeRecord.realizedGainBrl, tradeRecord.tradeDateBRT,
      tradeRecord.beforeBaseBalance, tradeRecord.beforeBrlBalance, tradeRecord.beforeBasePrice,
      tradeRecord.beforeBaseValue, tradeRecord.beforeTotal,
      tradeRecord.beforeRatioBps, tradeRecord.beforeDeviationBps, tradeRecord.beforeTimestamp,
      tradeRecord.afterBaseBalance, tradeRecord.afterBrlBalance, tradeRecord.afterBasePrice,
      tradeRecord.afterBaseValue, tradeRecord.afterTotal,
      tradeRecord.afterRatioBps, tradeRecord.afterDeviationBps, tradeRecord.afterTimestamp,
    );

    // Build and insert tax event
    const cumMonthlySales = tax.getMonthlySalesBrl(tradeDateBRT.slice(0, 7)) + (direction === 'SELL_BASE' ? brlAmountFilled : 0);
    const cumMonthlyGain = (direction === 'SELL_BASE' ? realizedGainBrl : 0);
    const exempt = cumMonthlySales <= 35000 ? 1 : 0;
    const paymentDeadline = exempt ? null : tax.computePaymentDeadline(tradeDateBRT.slice(0, 7));

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
      direction === 'SELL_BASE' ? costBasisBrl : 0,
      realizedGainBrl,
      direction === 'SELL_BASE' ? cumMonthlySales : 0,
      cumMonthlyGain,
      exempt,
      paymentDeadline,
      'mercadobitcoin',
    );

    const side = direction === 'BUY_BASE' ? 'BUY ' : 'SELL';
    console.log(
      `  ✓ ${tradeDateBRT}  ${side}  ${baseAmountFilled.toFixed(6)} ${baseAsset}  ` +
      `@R$${fillPrice.toFixed(2)}  BRL=${brlAmountFilled.toFixed(2)}  ` +
      `gain=${realizedGainBrl.toFixed(4)}  [${o.id}]`,
    );
  }

  // ── Final cost basis state ────────────────────────────────────────────────────
  const finalLedger = costBasis.getLedger();
  console.log('\nFinal cost basis:');
  console.log(`  ${baseAsset}: avg R$${finalLedger.base.averageCostBrl.toFixed(2)}, total ${finalLedger.base.totalBase.toFixed(6)}`);

  // ── Summary ───────────────────────────────────────────────────────────────────
  const totalNow = history.readTrades().length;
  console.log(`\nDone. Trades in DB: ${recorded.length} → ${totalNow}`);
}

main().catch((err) => {
  console.error('Reconciliation failed:', (err as Error).message);
  process.exit(1);
});
