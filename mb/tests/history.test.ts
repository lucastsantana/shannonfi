import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeHistoryService } from '../src/tracker/history';
import { TradeRecord } from '../src/mb/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPath(): string {
  return path.join(os.tmpdir(), `mb-history-test-${Date.now()}-${Math.random()}.json`);
}

function makeRecord(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: `id-${Math.random()}`,
    clientOrderId: `client-${Math.random()}`,
    mbOrderId: null,
    timestamp: new Date().toISOString(),
    direction: 'SELL_SOL',
    brlAmountTarget: 1000,
    solAmountFilled: 2.5,
    brlAmountFilled: 1000,
    fillPrice: 400,
    feeBrl: 7,
    status: 'filled',
    portfolioBefore: {
      solBalance: 10,
      brlBalance: 2000,
      solPrice: 400,
      solValueBrl: 4000,
      totalValueBrl: 6000,
      solRatioBps: 6667,
      deviationBps: 1667,
      timestamp: new Date().toISOString(),
    },
    portfolioAfter: null,
    dryRun: false,
    realizedGainBrl: 200,
    tradeDateBRT: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }),
    ...overrides,
  };
}

describe('TradeHistoryService (MB)', () => {
  let histPath: string;
  let snapPath: string;
  let svc: TradeHistoryService;

  beforeEach(() => {
    histPath = tmpPath();
    snapPath = tmpPath();
    svc = new TradeHistoryService(histPath, snapPath);
  });

  afterEach(() => {
    if (fs.existsSync(histPath)) fs.unlinkSync(histPath);
    if (fs.existsSync(snapPath)) fs.unlinkSync(snapPath);
  });

  it('starts with empty history', () => {
    expect(svc.readTrades()).toHaveLength(0);
  });

  it('persists trade records', async () => {
    await svc.appendTrade(makeRecord());
    expect(svc.readTrades()).toHaveLength(1);
  });

  it('getRebalanceCount counts filled and dry-run', async () => {
    await svc.appendTrade(makeRecord({ status: 'filled' }));
    await svc.appendTrade(makeRecord({ status: 'DRY_RUN' }));
    await svc.appendTrade(makeRecord({ status: 'cancelled' }));
    expect(svc.getRebalanceCount()).toBe(2);
  });

  it('getLastRebalanceTime returns ms timestamp of last successful trade', async () => {
    const before = Date.now();
    await svc.appendTrade(makeRecord({ status: 'filled' }));
    const ts = svc.getLastRebalanceTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('getLastRebalanceInfo returns date and direction', async () => {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    await svc.appendTrade(makeRecord({ direction: 'SELL_SOL', tradeDateBRT: todayBRT }));
    const { dateBRT, direction } = svc.getLastRebalanceInfo();
    expect(dateBRT).toBe(todayBRT);
    expect(direction).toBe('SELL_SOL');
  });

  it('getLastRebalanceInfo returns nulls when empty', () => {
    const { dateBRT, direction } = svc.getLastRebalanceInfo();
    expect(dateBRT).toBeNull();
    expect(direction).toBeNull();
  });

  it('snapshots persist and read back', () => {
    const snap = {
      dateBRT: '2026-05-26',
      timestamp: new Date().toISOString(),
      totalValueBrl: 6000,
      solBalance: 10,
      brlBalance: 2000,
      solPrice: 400,
      solRatioBps: 6667,
      effectiveThresholdBps: 100,
      rebalancedToday: true,
    };
    svc.appendSnapshot(snap);
    const snaps = svc.readSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.totalValueBrl).toBe(6000);
  });
});
