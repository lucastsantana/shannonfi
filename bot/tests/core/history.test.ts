import { describe, it, expect, beforeEach } from 'vitest';
import { TradeHistoryService } from '../../src/core/tracker/history';
import { TradeRecord, Portfolio } from '../../src/adapters/types';

function makePortfolio(): Portfolio {
  return {
    baseBalance: 10,
    brlBalance: 2000,
    basePrice: 400,
    baseValueBrl: 4000,
    totalValueBrl: 6000,
    baseRatioBps: 6667,
    deviationBps: 1667,
    timestamp: new Date().toISOString(),
  };
}

let tradeIdCounter = 0;

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  const id = overrides.id || `trade-${++tradeIdCounter}`;
  return {
    id,
    clientOrderId: `client-${id}`,
    exchangeOrderId: `exch-${id}`,
    exchange: 'mercadobitcoin',
    timestamp: new Date().toISOString(),
    direction: 'SELL_BASE',
    brlAmountTarget: 1000,
    baseAmountFilled: 2.5,
    brlAmountFilled: 1000,
    fillPrice: 400,
    feeBrl: 7,
    status: 'FILLED',
    portfolioBefore: makePortfolio(),
    portfolioAfter: null,
    dryRun: false,
    realizedGainBrl: 200,
    tradeDateBRT: '2026-04-15',
    ...overrides,
  };
}

describe('TradeHistoryService', () => {
  let svc: TradeHistoryService;

  beforeEach(() => {
    tradeIdCounter = 0;
    const testPath = `:memory:?mode=memory&cache=shared&hash=${Math.random()}`;
    svc = new TradeHistoryService(testPath);
  });

  it('starts with empty trade list', () => {
    expect(svc.readTrades()).toHaveLength(0);
  });

  it('appends and reads trades', () => {
    svc.appendTrade(makeTrade());
    expect(svc.readTrades()).toHaveLength(1);
  });

  it('getRebalanceCount counts FILLED and DRY_RUN', () => {
    svc.appendTrade(makeTrade({ status: 'FILLED' }));
    svc.appendTrade(makeTrade({ id: 't2', status: 'DRY_RUN' }));
    svc.appendTrade(makeTrade({ id: 't3', status: 'CANCELLED' }));
    expect(svc.getRebalanceCount()).toBe(2);
  });

  it('getLastRebalanceTime returns 0 for empty history', () => {
    expect(svc.getLastRebalanceTime()).toBe(0);
  });

  it('getLastRebalanceTime returns timestamp of latest trade', () => {
    const t1 = new Date('2026-04-10T10:00:00Z');
    const t2 = new Date('2026-04-15T10:00:00Z');
    svc.appendTrade(makeTrade({ id: 't1', timestamp: t1.toISOString() }));
    svc.appendTrade(makeTrade({ id: 't2', timestamp: t2.toISOString() }));
    expect(svc.getLastRebalanceTime()).toBe(t2.getTime());
  });

  it('getLastRebalanceInfo returns BRT date and direction', () => {
    svc.appendTrade(
      makeTrade({ tradeDateBRT: '2026-04-15', direction: 'SELL_BASE' }),
    );
    const { dateBRT, direction } = svc.getLastRebalanceInfo();
    expect(dateBRT).toBe('2026-04-15');
    expect(direction).toBe('SELL_BASE');
  });

  it('getLastRebalanceInfo returns nulls for empty history', () => {
    const { dateBRT, direction } = svc.getLastRebalanceInfo();
    expect(dateBRT).toBeNull();
    expect(direction).toBeNull();
  });
});
