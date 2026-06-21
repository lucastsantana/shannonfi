import { describe, it, expect } from 'vitest';
import { getDb, backfillBaseAsset } from '../../src/core/tracker/db';

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
