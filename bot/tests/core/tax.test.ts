import { describe, it, expect, beforeEach } from 'vitest';
import { TaxService } from '../../src/core/tracker/tax';
import Database from 'better-sqlite3';

describe('TaxService', () => {
  let svc: TaxService;
  let db: Database.Database;

  beforeEach(() => {
    const testPath = `:memory:?mode=memory&cache=shared&hash=${Math.random()}`;
    svc = new TaxService(testPath);
    // Get the same database instance to create dummy trades
    db = new Database(testPath);
    // Create the trades table if needed
    db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL,
        exchange_order_id TEXT,
        exchange TEXT NOT NULL DEFAULT 'mercadobitcoin',
        timestamp TEXT NOT NULL,
        direction TEXT NOT NULL,
        brl_amount_target REAL NOT NULL,
        base_amount_filled REAL,
        brl_amount_filled REAL,
        fill_price REAL,
        fee_brl REAL,
        status TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        realized_gain_brl REAL,
        trade_date_brt TEXT,
        before_base_balance REAL NOT NULL,
        before_brl_balance REAL NOT NULL,
        before_base_price REAL NOT NULL,
        before_base_value REAL NOT NULL,
        before_total_value REAL NOT NULL,
        before_base_ratio_bps INTEGER NOT NULL,
        before_deviation_bps INTEGER NOT NULL,
        before_timestamp TEXT NOT NULL,
        after_base_balance REAL,
        after_brl_balance REAL,
        after_base_price REAL,
        after_base_value REAL,
        after_total_value REAL,
        after_base_ratio_bps INTEGER,
        after_deviation_bps INTEGER,
        after_timestamp TEXT
      );
    `);
  });

  const createDummyTrade = (tradeId: string) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO trades (
        id, client_order_id, exchange_order_id, exchange, timestamp,
        direction, brl_amount_target, status, dry_run,
        before_base_balance, before_brl_balance, before_base_price,
        before_base_value, before_total_value, before_base_ratio_bps,
        before_deviation_bps, before_timestamp
      ) VALUES (?, ?, ?, 'mercadobitcoin', ?, 'SELL_BASE', 1000, 'FILLED', 0,
                10, 2000, 400, 4000, 6000, 6667, 1667, ?)
    `);
    stmt.run(tradeId, `client-${tradeId}`, `exch-${tradeId}`, new Date().toISOString(), new Date().toISOString());
  };

  const sellEvent = (overrides = {}) => {
    const tradeId = (overrides as any).tradeId || 'trade-1';
    createDummyTrade(tradeId);
    return svc.buildTaxEvent({
      tradeId,
      tradeDateBRT: '2026-04-15',
      direction: 'SELL_BASE',
      tradedVolumeBrl: 10_000,
      grossProceedsBrl: 10_000,
      costBasisBrl: 8_000,
      realizedGainBrl: 2_000,
      exchange: 'mercadobitcoin',
      ...overrides,
    });
  };

  it('starts empty', () => {
    expect(svc.readEvents()).toHaveLength(0);
  });

  it('appends and reads tax events', () => {
    const event = sellEvent();
    svc.appendTaxEvent(event);
    expect(svc.readEvents()).toHaveLength(1);
  });

  it('getMonthlySalesBrl sums SELL proceeds for the month', () => {
    svc.appendTaxEvent(sellEvent({ tradedVolumeBrl: 10_000, tradeDateBRT: '2026-04-15' }));
    createDummyTrade('trade-2');
    svc.appendTaxEvent(
      svc.buildTaxEvent({
        tradeId: 'trade-2',
        tradeDateBRT: '2026-04-20',
        direction: 'SELL_BASE',
        tradedVolumeBrl: 5_000,
        grossProceedsBrl: 5_000,
        costBasisBrl: 4_000,
        realizedGainBrl: 1_000,
        exchange: 'mercadobitcoin',
      }),
    );
    expect(svc.getMonthlySalesBrl('2026-04')).toBeCloseTo(15_000, 2);
  });

  it('getMonthlySalesBrl ignores BUY trades', () => {
    createDummyTrade('trade-buy');
    svc.appendTaxEvent(
      svc.buildTaxEvent({
        tradeId: 'trade-buy',
        tradeDateBRT: '2026-04-15',
        direction: 'BUY_BASE',
        tradedVolumeBrl: 5_000,
        grossProceedsBrl: 0,
        costBasisBrl: 0,
        realizedGainBrl: 0,
        exchange: 'mercadobitcoin',
      }),
    );
    expect(svc.getMonthlySalesBrl('2026-04')).toBe(0);
  });

  it('buildTaxEvent marks exempt when cumulative sales ≤ R$35,000', () => {
    const event = sellEvent({ tradedVolumeBrl: 20_000 });
    expect(event.exempt).toBe(true);
    expect(event.paymentDeadline).toBeNull();
  });

  it('buildTaxEvent marks non-exempt when cumulative sales > R$35,000', () => {
    svc.appendTaxEvent(sellEvent({ tradedVolumeBrl: 30_000 }));
    createDummyTrade('trade-over');
    const event = svc.buildTaxEvent({
      tradeId: 'trade-over',
      tradeDateBRT: '2026-04-25',
      direction: 'SELL_BASE',
      tradedVolumeBrl: 10_000,
      grossProceedsBrl: 10_000,
      costBasisBrl: 8_000,
      realizedGainBrl: 2_000,
      exchange: 'mercadobitcoin',
    });
    expect(event.exempt).toBe(false);
    expect(event.paymentDeadline).toBeTruthy();
    expect(event.cumMonthlySalesBrl).toBeCloseTo(40_000, 2);
  });

  it('cumMonthlySalesBrl is cumulative across events in the same month', () => {
    svc.appendTaxEvent(sellEvent({ tradedVolumeBrl: 10_000, tradeId: 't1' }));
    createDummyTrade('t2');
    const event2 = svc.buildTaxEvent({
      tradeId: 't2',
      tradeDateBRT: '2026-04-20',
      direction: 'SELL_BASE',
      tradedVolumeBrl: 8_000,
      grossProceedsBrl: 8_000,
      costBasisBrl: 6_000,
      realizedGainBrl: 2_000,
      exchange: 'mercadobitcoin',
    });
    expect(event2.cumMonthlySalesBrl).toBeCloseTo(18_000, 2);
  });

  it('computePaymentDeadline returns a weekday not in BR_HOLIDAYS', () => {
    const deadline = svc.computePaymentDeadline('2026-04');
    // Deadline should be in May 2026
    expect(deadline).toMatch(/^2026-05-/);
    const dow = new Date(`${deadline}T12:00:00Z`).getUTCDay();
    expect(dow).not.toBe(0); // not Sunday
    expect(dow).not.toBe(6); // not Saturday
  });
});
