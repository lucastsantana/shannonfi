import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradeHistoryService } from '../src/tracker/history';
import { TradeRecord, Portfolio } from '../src/coinbase/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPath(): string {
  return path.join(os.tmpdir(), `shannonfi-test-${Date.now()}-${Math.random()}.json`);
}

function makeRecord(
  timestamp: string,
  status: TradeRecord['status'],
  direction: TradeRecord['direction'] = 'SELL_SOL',
  tradeDateBRT?: string,
): TradeRecord {
  const p: Portfolio = {
    solBalance: 10,
    usdBalance: 500,
    solPrice: 150,
    solValueUsd: 1500,
    totalValueUsd: 2000,
    solRatioBps: 7500,
    deviationBps: 2500,
    timestamp,
  };
  return {
    id: 'id',
    clientOrderId: 'cid',
    coinbaseOrderId: null,
    timestamp,
    direction,
    usdAmountTarget: 100,
    solAmountFilled: null,
    usdAmountFilled: null,
    fillPrice: null,
    feeUsd: null,
    status,
    portfolioBefore: p,
    portfolioAfter: null,
    dryRun: false,
    brlSnapshot: null,
    realizedGainBrl: null,
    tradeDateBRT: tradeDateBRT ?? null,
  };
}

describe('TradeHistoryService', () => {
  let filePath: string;
  let service: TradeHistoryService;

  beforeEach(() => {
    filePath = tmpPath();
    service = new TradeHistoryService(filePath);
  });

  afterEach(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const snapshotPath = filePath.replace('.json', '') + '/../portfolio_snapshots.json';
    if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
  });

  it('returns 0 when no trades exist', () => {
    expect(service.getLastRebalanceTime()).toBe(0);
  });

  it('returns 0 when only PENDING trades exist', async () => {
    await service.appendTrade(makeRecord('2026-01-01T00:00:00.000Z', 'PENDING'));
    expect(service.getLastRebalanceTime()).toBe(0);
  });

  it('returns timestamp of the last FILLED trade', async () => {
    await service.appendTrade(makeRecord('2026-01-01T00:00:00.000Z', 'FILLED'));
    await service.appendTrade(makeRecord('2026-02-01T00:00:00.000Z', 'FILLED'));
    const expected = new Date('2026-02-01T00:00:00.000Z').getTime();
    expect(service.getLastRebalanceTime()).toBe(expected);
  });

  it('returns timestamp of the last DRY_RUN trade', async () => {
    await service.appendTrade(makeRecord('2026-03-15T12:00:00.000Z', 'DRY_RUN'));
    const expected = new Date('2026-03-15T12:00:00.000Z').getTime();
    expect(service.getLastRebalanceTime()).toBe(expected);
  });

  it('ignores CANCELLED trades when computing last rebalance time', async () => {
    await service.appendTrade(makeRecord('2026-01-01T00:00:00.000Z', 'FILLED'));
    await service.appendTrade(makeRecord('2026-03-01T00:00:00.000Z', 'CANCELLED'));
    const expected = new Date('2026-01-01T00:00:00.000Z').getTime();
    expect(service.getLastRebalanceTime()).toBe(expected);
  });

  it('persists trades and reads them back', async () => {
    const record = makeRecord('2026-04-01T00:00:00.000Z', 'FILLED');
    await service.appendTrade(record);
    const service2 = new TradeHistoryService(filePath);
    expect(service2.getRebalanceCount()).toBe(1);
    expect(service2.getLastRebalanceTime()).toBe(
      new Date('2026-04-01T00:00:00.000Z').getTime(),
    );
  });

  // ─── getLastRebalanceInfo ──────────────────────────────────────────────────

  it('getLastRebalanceInfo returns nulls when no trades', () => {
    const info = service.getLastRebalanceInfo();
    expect(info.dateBRT).toBeNull();
    expect(info.direction).toBeNull();
  });

  it('getLastRebalanceInfo returns BRT date and direction from tradeDateBRT field', async () => {
    await service.appendTrade(
      makeRecord('2026-05-15T15:00:00.000Z', 'FILLED', 'SELL_SOL', '2026-05-15'),
    );
    const info = service.getLastRebalanceInfo();
    expect(info.dateBRT).toBe('2026-05-15');
    expect(info.direction).toBe('SELL_SOL');
  });

  it('getLastRebalanceInfo falls back to timestamp-derived BRT date for legacy records', async () => {
    // Record without tradeDateBRT (legacy)
    await service.appendTrade(
      makeRecord('2026-06-10T18:00:00.000Z', 'FILLED', 'BUY_SOL', undefined),
    );
    const info = service.getLastRebalanceInfo();
    // Timestamp 18:00 UTC = 15:00 BRT — same calendar day
    expect(info.direction).toBe('BUY_SOL');
    expect(info.dateBRT).toBeDefined();
  });

  it('getLastRebalanceInfo returns the most recent trade direction', async () => {
    await service.appendTrade(
      makeRecord('2026-05-01T10:00:00.000Z', 'FILLED', 'BUY_SOL', '2026-05-01'),
    );
    await service.appendTrade(
      makeRecord('2026-05-10T10:00:00.000Z', 'FILLED', 'SELL_SOL', '2026-05-10'),
    );
    const info = service.getLastRebalanceInfo();
    expect(info.direction).toBe('SELL_SOL');
    expect(info.dateBRT).toBe('2026-05-10');
  });
});
