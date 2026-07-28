import { describe, it, expect } from 'vitest';
import { getDb, backfillBaseAsset, backfillShares } from '../../src/core/tracker/db';

function uniqueMemDbPath(): string {
  return `:memory:?mode=memory&cache=shared&hash=${Math.random()}`;
}

function columns(db: ReturnType<typeof getDb>, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

describe('db migrations — asset rotation support', () => {
  it('creates base_asset on trades and portfolio_snapshots for a fresh database', () => {
    const db = getDb(uniqueMemDbPath());
    expect(columns(db, 'trades')).toContain('base_asset');
    expect(columns(db, 'portfolio_snapshots')).toContain('base_asset');
  });

  it('creates the pending_rotation audit columns for a fresh database', () => {
    const db = getDb(uniqueMemDbPath());
    const cols = columns(db, 'pending_rotation');
    expect(cols).toContain('scan_id');
    expect(cols).toContain('liquidation_trade_id');
    expect(cols).toContain('reacquisition_trade_id');
    expect(cols).toContain('requested_by');
  });

  it('is idempotent — opening the same database twice does not error or duplicate columns', () => {
    const path = uniqueMemDbPath();
    getDb(path);
    expect(() => getDb(path)).not.toThrow();
    const db = getDb(path);
    const cols = columns(db, 'trades');
    expect(cols.filter((c) => c === 'base_asset')).toHaveLength(1);
  });

  it('backfillBaseAsset only fills NULL rows, leaving already-tagged rows untouched', () => {
    const path = uniqueMemDbPath();
    const db = getDb(path);

    const baseTrade = {
      id: 't1', client_order_id: 'c1', exchange: 'mercadobitcoin', timestamp: new Date().toISOString(),
      direction: 'BUY_BASE', brl_amount_target: 100, status: 'FILLED', dry_run: 0,
      before_base_balance: 0, before_brl_balance: 100, before_base_price: 10, before_base_value: 0,
      before_total_value: 100, before_base_ratio_bps: 0, before_deviation_bps: 10000, before_timestamp: new Date().toISOString(),
    };
    db.prepare(`
      INSERT INTO trades (id, client_order_id, exchange, timestamp, direction, brl_amount_target, status, dry_run,
        before_base_balance, before_brl_balance, before_base_price, before_base_value, before_total_value,
        before_base_ratio_bps, before_deviation_bps, before_timestamp, base_asset)
      VALUES (@id, @client_order_id, @exchange, @timestamp, @direction, @brl_amount_target, @status, @dry_run,
        @before_base_balance, @before_brl_balance, @before_base_price, @before_base_value, @before_total_value,
        @before_base_ratio_bps, @before_deviation_bps, @before_timestamp, NULL)
    `).run(baseTrade);
    db.prepare(`
      INSERT INTO trades (id, client_order_id, exchange, timestamp, direction, brl_amount_target, status, dry_run,
        before_base_balance, before_brl_balance, before_base_price, before_base_value, before_total_value,
        before_base_ratio_bps, before_deviation_bps, before_timestamp, base_asset)
      VALUES (@id, @client_order_id, @exchange, @timestamp, @direction, @brl_amount_target, @status, @dry_run,
        @before_base_balance, @before_brl_balance, @before_base_price, @before_base_value, @before_total_value,
        @before_base_ratio_bps, @before_deviation_bps, @before_timestamp, 'BTC')
    `).run({ ...baseTrade, id: 't2' });

    backfillBaseAsset('SOL', path);

    const rows = db.prepare('SELECT id, base_asset FROM trades ORDER BY id').all() as { id: string; base_asset: string }[];
    expect(rows.find((r) => r.id === 't1')?.base_asset).toBe('SOL'); // was NULL, backfilled
    expect(rows.find((r) => r.id === 't2')?.base_asset).toBe('BTC'); // already tagged, untouched
  });
});

describe('db migrations — fund-share accounting backfill', () => {
  function insertSnapshot(db: ReturnType<typeof getDb>, dateBRT: string, totalValueBrl: number) {
    db.prepare(`
      INSERT INTO portfolio_snapshots (
        date_brt, timestamp, total_value_brl, base_balance, brl_balance, base_price,
        base_ratio_bps, effective_threshold_bps, rebalanced_today, exchange
      ) VALUES (?, ?, ?, 0, ?, 1, 0, 100, 0, 'mercadobitcoin')
    `).run(dateBRT, `${dateBRT}T00:00:00Z`, totalValueBrl, totalValueBrl);
  }

  it('anchors at 100 shares on the first positive-value row and rescales the rest', () => {
    const path = uniqueMemDbPath();
    const db = getDb(path);
    insertSnapshot(db, '2026-06-01', 1000);
    insertSnapshot(db, '2026-06-02', 1100);
    insertSnapshot(db, '2026-06-03', 950);

    backfillShares(path);

    const rows = db.prepare('SELECT date_brt, total_shares_outstanding, nav_per_share FROM portfolio_snapshots ORDER BY date_brt').all() as
      { date_brt: string; total_shares_outstanding: number; nav_per_share: number }[];
    expect(rows[0]!.total_shares_outstanding).toBe(100);
    expect(rows[0]!.nav_per_share).toBeCloseTo(10, 6);   // 1000 / 100
    expect(rows[1]!.nav_per_share).toBeCloseTo(11, 6);   // 1100 / 100
    expect(rows[2]!.nav_per_share).toBeCloseTo(9.5, 6);  // 950 / 100
    // Shares outstanding constant across the backfilled span (no flows existed yet).
    expect(rows[1]!.total_shares_outstanding).toBe(100);
    expect(rows[2]!.total_shares_outstanding).toBe(100);
  });

  it('records the anchor value as a genesis DEPOSIT in capital_flows', () => {
    const path = uniqueMemDbPath();
    const db = getDb(path);
    insertSnapshot(db, '2026-06-01', 1000);
    insertSnapshot(db, '2026-06-02', 1100);

    backfillShares(path);

    const flows = db.prepare('SELECT * FROM capital_flows').all() as any[];
    expect(flows).toHaveLength(1);
    expect(flows[0].type).toBe('DEPOSIT');
    expect(flows[0].brl_amount).toBe(1000);
    expect(flows[0].nav_per_share_before).toBeCloseTo(10, 6); // 1000 / 100
    expect(flows[0].shares_delta).toBe(100);
    expect(flows[0].total_shares_after).toBe(100);
    expect(flows[0].total_value_brl_before).toBe(0);
    expect(flows[0].total_value_brl_after).toBe(1000);
    expect(flows[0].date_brt).toBe('2026-06-01');
  });

  it('is idempotent — only fills rows still NULL, leaving already-backfilled or live-written rows untouched, and never inserts a second genesis flow', () => {
    const path = uniqueMemDbPath();
    const db = getDb(path);
    insertSnapshot(db, '2026-06-01', 1000);
    backfillShares(path);
    db.prepare("UPDATE portfolio_snapshots SET total_shares_outstanding = 999, nav_per_share = 2.5 WHERE date_brt = '2026-06-01'").run();

    insertSnapshot(db, '2026-06-02', 2000);
    backfillShares(path);

    const row1 = db.prepare("SELECT nav_per_share FROM portfolio_snapshots WHERE date_brt = '2026-06-01'").get() as { nav_per_share: number };
    expect(row1.nav_per_share).toBe(2.5); // untouched — no longer NULL

    const row2 = db.prepare("SELECT nav_per_share, total_shares_outstanding FROM portfolio_snapshots WHERE date_brt = '2026-06-02'").get() as
      { nav_per_share: number; total_shares_outstanding: number };
    expect(row2.total_shares_outstanding).toBe(100); // anchored on itself since it's the only NULL row now
    expect(row2.nav_per_share).toBeCloseTo(20, 6); // 2000 / 100

    const flows = db.prepare('SELECT COUNT(*) as n FROM capital_flows').get() as { n: number };
    expect(flows.n).toBe(1); // still just the one genesis flow from the first call
  });

  it('no-ops when every un-backfilled row has zero value', () => {
    const path = uniqueMemDbPath();
    const db = getDb(path);
    insertSnapshot(db, '2026-06-01', 0);
    expect(() => backfillShares(path)).not.toThrow();
    const row = db.prepare("SELECT nav_per_share FROM portfolio_snapshots WHERE date_brt = '2026-06-01'").get() as { nav_per_share: number | null };
    expect(row.nav_per_share).toBeNull();
  });
});
