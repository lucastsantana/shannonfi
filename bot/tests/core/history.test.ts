import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeHistoryService } from '../../src/core/tracker/history';
import { TradeRecord, Portfolio } from '../../src/adapters/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPath(suffix: string): string {
  return path.join(os.tmpdir(), `bot-history-test-${suffix}-${Date.now()}.json`);
}

function makePortfolio(): Portfolio {
  return {
    solBalance: 10,
    brlBalance: 2000,
    solPrice: 400,
    solValueBrl: 4000,
    totalValueBrl: 6000,
    solRatioBps: 6667,
    deviationBps: 1667,
    timestamp: new Date().toISOString(),
  };
}

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'trade-1',
    clientOrderId: 'client-1',
    exchangeOrderId: 'exch-1',
    exchange: 'mercadobitcoin',
    timestamp: new Date().toISOString(),
    direction: 'SELL_SOL',
    brlAmountTarget: 1000,
    solAmountFilled: 2.5,
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
  let histPath: string;
  let snapPath: string;
  let svc: TradeHistoryService;

  beforeEach(() => {
    histPath = tmpPath('hist');
    snapPath = tmpPath('snap');
    svc = new TradeHistoryService(histPath, snapPath);
  });

  afterEach(() => {
    for (const p of [histPath, snapPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('starts with empty trade list', () => {
    expect(svc.readTrades()).toHaveLength(0);
  });

  it('appends and reads trades', async () => {
    await svc.appendTrade(makeTrade());
    expect(svc.readTrades()).toHaveLength(1);
  });

  it('getRebalanceCount counts FILLED and DRY_RUN', async () => {
    await svc.appendTrade(makeTrade({ status: 'FILLED' }));
    await svc.appendTrade(makeTrade({ id: 't2', status: 'DRY_RUN' }));
    await svc.appendTrade(makeTrade({ id: 't3', status: 'CANCELLED' }));
    expect(svc.getRebalanceCount()).toBe(2);
  });

  it('getLastRebalanceTime returns 0 for empty history', () => {
    expect(svc.getLastRebalanceTime()).toBe(0);
  });

  it('getLastRebalanceTime returns timestamp of latest trade', async () => {
    const t1 = new Date('2026-04-10T10:00:00Z');
    const t2 = new Date('2026-04-15T10:00:00Z');
    await svc.appendTrade(makeTrade({ id: 't1', timestamp: t1.toISOString() }));
    await svc.appendTrade(makeTrade({ id: 't2', timestamp: t2.toISOString() }));
    expect(svc.getLastRebalanceTime()).toBe(t2.getTime());
  });

  it('getLastRebalanceInfo returns BRT date and direction', async () => {
    await svc.appendTrade(
      makeTrade({ tradeDateBRT: '2026-04-15', direction: 'SELL_SOL' }),
    );
    const { dateBRT, direction } = svc.getLastRebalanceInfo();
    expect(dateBRT).toBe('2026-04-15');
    expect(direction).toBe('SELL_SOL');
  });

  it('getLastRebalanceInfo returns nulls for empty history', () => {
    const { dateBRT, direction } = svc.getLastRebalanceInfo();
    expect(dateBRT).toBeNull();
    expect(direction).toBeNull();
  });
});
