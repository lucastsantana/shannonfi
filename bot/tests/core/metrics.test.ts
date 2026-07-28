import { describe, it, expect, vi } from 'vitest';
import { MetricsService } from '../../src/core/tracker/metrics';
import { PortfolioSnapshot } from '../../src/adapters/types';
import { TradeHistoryService } from '../../src/core/tracker/history';

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

function makeHistory(readTradesReturn: any[] = []): TradeHistoryService {
  return {
    readTrades: vi.fn().mockReturnValue(readTradesReturn),
  } as unknown as TradeHistoryService;
}

describe('MetricsService — nav/share-based return', () => {
  it('computes return from navPerShare deltas, not totalValueBrl', () => {
    const svc = new MetricsService(makeHistory());
    // totalValueBrl looks flat (no return), but navPerShare doubled — a deposit
    // inflated totalValueBrl without being trading performance; nav/share is the
    // source of truth.
    const snapshots = [
      makeSnapshot({ dateBRT: '2026-06-01', timestamp: '2026-06-01T00:00:00Z', totalValueBrl: 1000, navPerShare: 1.0 }),
      makeSnapshot({ dateBRT: '2026-06-11', timestamp: '2026-06-11T00:00:00Z', totalValueBrl: 1000, navPerShare: 2.0 }),
    ];
    const m = svc.computeMetrics(snapshots);
    expect(m.totalReturnBrlPct).toBeCloseTo(100, 5);
  });

  it('a deposit that only moves totalValueBrl (not navPerShare) produces zero measured return', () => {
    const svc = new MetricsService(makeHistory());
    const snapshots = [
      makeSnapshot({ dateBRT: '2026-06-01', timestamp: '2026-06-01T00:00:00Z', totalValueBrl: 1000, navPerShare: 1.0 }),
      // A deposit landed: totalValueBrl jumped, but nav/share is unchanged because
      // ShareLedgerService issued shares proportionally.
      makeSnapshot({ dateBRT: '2026-06-02', timestamp: '2026-06-02T00:00:00Z', totalValueBrl: 6000, navPerShare: 1.0 }),
    ];
    const m = svc.computeMetrics(snapshots);
    expect(m.totalReturnBrlPct).toBeCloseTo(0, 5);
  });

  it('excludes snapshots with navPerShare <= 0 (pre-backfill / empty portfolio) from the series', () => {
    const svc = new MetricsService(makeHistory());
    const snapshots = [
      makeSnapshot({ dateBRT: '2026-05-01', timestamp: '2026-05-01T00:00:00Z', totalValueBrl: 500, navPerShare: 0, sharesOutstanding: 0 }),
      makeSnapshot({ dateBRT: '2026-06-01', timestamp: '2026-06-01T00:00:00Z', totalValueBrl: 1000, navPerShare: 1.0 }),
      makeSnapshot({ dateBRT: '2026-06-11', timestamp: '2026-06-11T00:00:00Z', totalValueBrl: 1200, navPerShare: 1.2 }),
    ];
    const m = svc.computeMetrics(snapshots);
    expect(m.periodStart).toBe('2026-06-01T00:00:00Z');
    expect(m.totalReturnBrlPct).toBeCloseTo(20, 5);
  });

  it('returns empty metrics when no snapshot has usable nav/share data', () => {
    const svc = new MetricsService(makeHistory());
    const snapshots = [makeSnapshot({ navPerShare: 0, sharesOutstanding: 0 })];
    const m = svc.computeMetrics(snapshots);
    expect(m.totalReturnBrlPct).toBe(0);
    expect(m.cagr).toBeNull();
  });
});
