import { describe, it, expect, vi } from 'vitest';
import { PnlService } from '../../src/core/tracker/pnl';
import { TradeHistoryService } from '../../src/core/tracker/history';
import { TradeRecord, PortfolioSnapshot } from '../../src/adapters/types';

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 't1',
    clientOrderId: 'c1',
    exchangeOrderId: null,
    exchange: 'mercadobitcoin',
    timestamp: '2026-06-01T00:00:00Z',
    direction: 'BUY_BASE',
    brlAmountTarget: 100,
    baseAmountFilled: 1,
    brlAmountFilled: 100,
    fillPrice: 100,
    feeBrl: 1,
    status: 'FILLED',
    portfolioBefore: {
      baseBalance: 0, brlBalance: 1000, basePrice: 100, baseValueBrl: 0, totalValueBrl: 1000,
      baseRatioBps: 0, deviationBps: 10000, timestamp: '2026-06-01T00:00:00Z',
    },
    portfolioAfter: {
      baseBalance: 1, brlBalance: 900, basePrice: 100, baseValueBrl: 100, totalValueBrl: 1000,
      baseRatioBps: 1000, deviationBps: 8000, timestamp: '2026-06-01T00:00:01Z',
    },
    dryRun: false,
    realizedGainBrl: null,
    tradeDateBRT: '2026-06-01',
    baseAsset: 'SOL',
    sharesOutstanding: null,
    navPerShareBefore: null,
    navPerShareAfter: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PortfolioSnapshot>): PortfolioSnapshot {
  return {
    dateBRT: '2026-06-01',
    timestamp: '2026-06-01T00:00:00Z',
    totalValueBrl: 1000,
    baseBalance: 5,
    brlBalance: 500,
    basePrice: 100,
    baseRatioBps: 5000,
    effectiveThresholdBps: 100,
    rebalancedToday: false,
    exchange: 'mercadobitcoin',
    baseAsset: 'SOL',
    sharesOutstanding: 1000,
    navPerShare: 1.0,
    ...overrides,
  };
}

describe('PnlService.printReport — nav/share-based return', () => {
  it('prints n/a when fewer than 2 nav-populated snapshots exist', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const history = {
      readTrades: vi.fn().mockReturnValue([makeTrade()]),
      readSnapshots: vi.fn().mockReturnValue([]),
    } as unknown as TradeHistoryService;

    new PnlService(history).printReport();

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/Return \(NAV\/share\):\s+n\/a/);
    logSpy.mockRestore();
  });

  it('computes return from navPerShare even when totalValueBrl looks unchanged', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const history = {
      readTrades: vi.fn().mockReturnValue([makeTrade()]),
      readSnapshots: vi.fn().mockReturnValue([
        makeSnapshot({ timestamp: '2026-06-01T00:00:00Z', totalValueBrl: 1000, navPerShare: 1.0 }),
        makeSnapshot({ timestamp: '2026-06-10T00:00:00Z', totalValueBrl: 1000, navPerShare: 1.1 }),
      ]),
    } as unknown as TradeHistoryService;

    new PnlService(history).printReport();

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toMatch(/Return \(NAV\/share\):\s+\+10\.00%/);
    logSpy.mockRestore();
  });
});
