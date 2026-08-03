/**
 * One-off correction: reconstructs the R$40 PIX deposit that landed on hype-mb around
 * 2026-07-31 as a proper capital_flows entry, retroactively re-basing shares_outstanding
 * and nav_per_share for every portfolio_snapshots row and trades row from that point
 * forward. See CLAUDE.md / docs/capital-flow-recording-guide.md and the capital-flow
 * auto-detection investigation for why MB's wallet API never surfaced this deposit
 * (confirmed via exhaustive live stress test — not a bug in this codebase, an MB
 * backend/data gap) and why capital-flow-sync.ts never caught it either.
 *
 * Derives everything from the DB itself rather than hardcoded numbers:
 *  - Finds the first trade on/after the deposit date, uses its before_base_balance/
 *    before_base_price/before_brl_balance (the freshest pre-trade state).
 *  - Finds the most recent snapshot strictly before that trade's date to recover the
 *    pre-deposit BRL balance, and asserts base_balance is unchanged between the two
 *    (i.e. no trade happened in between — the delta is purely a capital inflow).
 *  - depositAmount = trade.before_brl_balance - priorSnapshot.brl_balance.
 *  - Prices new shares at nav/share computed from (trade.before_base_balance *
 *    trade.before_base_price + priorSnapshot.brl_balance) / sharesBeforeFlow — i.e. the
 *    instant just before the trade fired, using its freshest price check.
 *
 * Only ever touches total_shares_outstanding/nav_per_share columns (capital_flows,
 * portfolio_snapshots, trades) — total_value_brl and all raw balance/price columns are
 * never modified, so this is fully re-derivable/re-runnable if a number needs revising.
 *
 * Defaults to a dry run (prints the full plan, writes nothing). Pass --apply to commit.
 *
 * Usage: npx ts-node src/scripts/fix-hype-mb-deposit.ts --config configs/hype-mb.yaml [--apply]
 */
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from '../config';

function parseArgs(): { configPath: string; apply: boolean; dbPathOverride: string | undefined } {
  const idx = process.argv.indexOf('--config');
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error('Usage: npx ts-node src/scripts/fix-hype-mb-deposit.ts --config <path> [--apply] [--db-path <override>]');
  }
  const dbIdx = process.argv.indexOf('--db-path');
  return {
    configPath: process.argv[idx + 1]!,
    apply: process.argv.includes('--apply'),
    dbPathOverride: dbIdx !== -1 ? process.argv[dbIdx + 1] : undefined,
  };
}

function main() {
  const { configPath, apply, dbPathOverride } = parseArgs();
  const config = loadConfig(configPath);
  if (config.exchange !== 'mercadobitcoin') {
    throw new Error(`This fix is hype-mb/Mercado-Bitcoin-specific; config exchange is ${config.exchange}`);
  }
  const dbPath = dbPathOverride ?? config.dbPath;
  if (!dbPath) throw new Error('Config has no dbPath');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // First trade on/after the suspected deposit window.
  const firstTrade = db.prepare(`
    SELECT * FROM trades WHERE trade_date_brt >= '2026-07-31' ORDER BY timestamp ASC LIMIT 1
  `).get() as any;
  if (!firstTrade) throw new Error('No trade found on/after 2026-07-31 — has the DB already been fixed, or is this the wrong instance?');

  // Most recent snapshot strictly before that trade's date.
  const priorSnapshot = db.prepare(`
    SELECT * FROM portfolio_snapshots WHERE date_brt < ? ORDER BY date_brt DESC LIMIT 1
  `).get(firstTrade.trade_date_brt) as any;
  if (!priorSnapshot) throw new Error(`No snapshot found before ${firstTrade.trade_date_brt}`);

  console.log('=== Reference data ===');
  console.log('First trade:', { id: firstTrade.id, timestamp: firstTrade.timestamp, trade_date_brt: firstTrade.trade_date_brt });
  console.log('  before_base_balance:', firstTrade.before_base_balance);
  console.log('  before_brl_balance:', firstTrade.before_brl_balance);
  console.log('  before_base_price:', firstTrade.before_base_price);
  console.log('Prior snapshot:', { date_brt: priorSnapshot.date_brt, base_balance: priorSnapshot.base_balance, brl_balance: priorSnapshot.brl_balance });

  const baseBalanceDelta = firstTrade.before_base_balance - priorSnapshot.base_balance;
  if (Math.abs(baseBalanceDelta) > 1e-8) {
    throw new Error(
      `Assumption violated: base_balance changed between ${priorSnapshot.date_brt} snapshot (${priorSnapshot.base_balance}) ` +
      `and first trade's before-state (${firstTrade.before_base_balance}), delta=${baseBalanceDelta}. ` +
      `A trade must have happened in between that this script doesn't account for — investigate before proceeding.`,
    );
  }

  const depositAmount = firstTrade.before_brl_balance - priorSnapshot.brl_balance;
  if (depositAmount <= 0) {
    throw new Error(`Computed depositAmount=${depositAmount} is not positive — nothing to reconstruct, or assumptions are wrong.`);
  }

  // Shares outstanding immediately before this flow (no flows exist after genesis yet).
  const lastFlow = db.prepare(`
    SELECT total_shares_after FROM capital_flows ORDER BY timestamp DESC LIMIT 1
  `).get() as { total_shares_after: number } | undefined;
  const sharesBeforeFlow = lastFlow?.total_shares_after ?? 100;

  const totalValueBrlBeforeDeposit = firstTrade.before_base_balance * firstTrade.before_base_price + priorSnapshot.brl_balance;
  const navPerShareBeforeDeposit = totalValueBrlBeforeDeposit / sharesBeforeFlow;
  const sharesDelta = depositAmount / navPerShareBeforeDeposit;
  const totalSharesAfter = sharesBeforeFlow + sharesDelta;
  const totalValueBrlAfterDeposit = totalValueBrlBeforeDeposit + depositAmount;

  console.log('\n=== Computed correction ===');
  console.log('depositAmount:', depositAmount.toFixed(8));
  console.log('sharesBeforeFlow:', sharesBeforeFlow);
  console.log('totalValueBrlBeforeDeposit:', totalValueBrlBeforeDeposit.toFixed(8));
  console.log('navPerShareBeforeDeposit:', navPerShareBeforeDeposit.toFixed(8));
  console.log('sharesDelta:', sharesDelta.toFixed(8));
  console.log('totalSharesAfter:', totalSharesAfter.toFixed(8));
  console.log('totalValueBrlAfterDeposit (sanity check vs firstTrade.before_total_value):', totalValueBrlAfterDeposit.toFixed(8), 'vs', firstTrade.before_total_value);

  // Flow timestamp: 1ms before the first trade's before_timestamp, so it sorts as
  // having happened just prior to the bot noticing/rebalancing.
  const flowTimestamp = new Date(new Date(firstTrade.before_timestamp).getTime() - 1).toISOString();
  const flowDateBRT = new Date(flowTimestamp).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const flowId = uuidv4();

  console.log('\n=== Capital flow row to insert ===');
  const flowRow = {
    id: flowId,
    timestamp: flowTimestamp,
    date_brt: flowDateBRT,
    type: 'DEPOSIT',
    brl_amount: depositAmount,
    nav_per_share_before: navPerShareBeforeDeposit,
    shares_delta: sharesDelta,
    total_shares_after: totalSharesAfter,
    total_value_brl_before: totalValueBrlBeforeDeposit,
    total_value_brl_after: totalValueBrlAfterDeposit,
    exchange: 'mercadobitcoin',
    note: 'Retroactive correction: MB wallet API never surfaced this real PIX deposit via GET /accounts/{accountId}/wallet/fiat/BRL/deposits despite balance confirming it landed (confirmed via exhaustive live stress test across 18 param variations — an MB backend/data gap, not a bug in this codebase). Reconstructed from trades.before_brl_balance delta vs. prior day snapshot.',
  };
  console.log(flowRow);

  // Snapshots to correct: every one on/after the flow's date.
  const snapshotsToFix = db.prepare(`
    SELECT date_brt, total_value_brl, total_shares_outstanding, nav_per_share FROM portfolio_snapshots
    WHERE date_brt >= ? ORDER BY date_brt ASC
  `).all(flowDateBRT) as any[];

  console.log(`\n=== Snapshots to correct (${snapshotsToFix.length}) ===`);
  for (const s of snapshotsToFix) {
    const newNav = s.total_value_brl / totalSharesAfter;
    console.log(`  ${s.date_brt}: total_value_brl=${s.total_value_brl.toFixed(4)}  shares ${s.total_shares_outstanding} -> ${totalSharesAfter.toFixed(6)}  nav/share ${s.nav_per_share?.toFixed(6)} -> ${newNav.toFixed(6)}`);
  }

  // Trades to correct: every one at/after the flow's timestamp.
  const tradesToFix = db.prepare(`
    SELECT id, timestamp, before_total_value, after_total_value, shares_outstanding, nav_per_share_before, nav_per_share_after
    FROM trades WHERE timestamp >= ? ORDER BY timestamp ASC
  `).all(flowTimestamp) as any[];

  console.log(`\n=== Trades to correct (${tradesToFix.length}) ===`);
  for (const t of tradesToFix) {
    const newNavBefore = t.before_total_value / totalSharesAfter;
    const newNavAfter = t.after_total_value != null ? t.after_total_value / totalSharesAfter : null;
    console.log(`  ${t.id} (${t.timestamp}): shares ${t.shares_outstanding} -> ${totalSharesAfter.toFixed(6)}  navBefore ${t.nav_per_share_before?.toFixed(6)} -> ${newNavBefore.toFixed(6)}  navAfter ${t.nav_per_share_after?.toFixed(6) ?? 'null'} -> ${newNavAfter?.toFixed(6) ?? 'null'}`);
  }

  if (!apply) {
    console.log('\n--- DRY RUN: no changes written. Pass --apply to commit. ---');
    db.close();
    return;
  }

  const applyTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO capital_flows (
        id, timestamp, date_brt, type, brl_amount, nav_per_share_before, shares_delta,
        total_shares_after, total_value_brl_before, total_value_brl_after, exchange, note
      ) VALUES (@id, @timestamp, @date_brt, @type, @brl_amount, @nav_per_share_before, @shares_delta,
        @total_shares_after, @total_value_brl_before, @total_value_brl_after, @exchange, @note)
    `).run(flowRow);

    const updateSnapshot = db.prepare(`
      UPDATE portfolio_snapshots SET total_shares_outstanding = ?, nav_per_share = ? WHERE date_brt = ?
    `);
    for (const s of snapshotsToFix) {
      updateSnapshot.run(totalSharesAfter, s.total_value_brl / totalSharesAfter, s.date_brt);
    }

    const updateTrade = db.prepare(`
      UPDATE trades SET shares_outstanding = ?, nav_per_share_before = ?, nav_per_share_after = ? WHERE id = ?
    `);
    for (const t of tradesToFix) {
      const newNavAfter = t.after_total_value != null ? t.after_total_value / totalSharesAfter : null;
      updateTrade.run(totalSharesAfter, t.before_total_value / totalSharesAfter, newNavAfter, t.id);
    }
  });
  applyTx();

  console.log('\n--- APPLIED: capital flow inserted, snapshots and trades corrected. ---');
  db.close();
}

main();
