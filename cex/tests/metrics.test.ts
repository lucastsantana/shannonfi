import { describe, it, expect, vi } from 'vitest';
import { MetricsService } from '../src/tracker/metrics';
import { TradeHistoryService } from '../src/tracker/history';
import { PortfolioSnapshot } from '../src/coinbase/types';

function makeSnapshot(
  dateBRT: string,
  totalValueUsd: number,
  rebalancedToday = false,
): PortfolioSnapshot {
  return {
    dateBRT,
    timestamp: `${dateBRT}T12:00:00.000Z`,
    totalValueUsd,
    totalValueBrl: totalValueUsd * 5.5,
    solBalance: 10,
    usdBalance: 500,
    solPrice: 150,
    usdBrlRate: 5.5,
    solRatioBps: 5000,
    effectiveThresholdBps: 100,
    rebalancedToday,
  };
}

function makeService() {
  const history = {
    readTrades: vi.fn().mockReturnValue([]),
    readSnapshots: vi.fn().mockReturnValue([]),
    getLastRebalanceTime: vi.fn().mockReturnValue(0),
    getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: null, direction: null }),
  } as unknown as TradeHistoryService;
  return new MetricsService(history);
}

describe('MetricsService', () => {
  it('returns empty metrics for no snapshots', () => {
    const svc = makeService();
    const m = svc.computeMetrics([]);
    expect(m.totalReturnUsdPct).toBe(0);
    expect(m.totalRebalances).toBe(0);
    expect(m.sharpeRatio).toBeNull();
  });

  it('computes total return correctly', () => {
    const svc = makeService();
    const snapshots = [
      makeSnapshot('2026-01-01', 10000),
      makeSnapshot('2026-06-01', 12000),
    ];
    const m = svc.computeMetrics(snapshots);
    expect(m.totalReturnUsdPct).toBeCloseTo(20, 4);
  });

  it('computes BRL return when data available', () => {
    const svc = makeService();
    const snapshots = [
      makeSnapshot('2026-01-01', 10000),
      makeSnapshot('2026-06-01', 11000),
    ];
    const m = svc.computeMetrics(snapshots);
    // BRL values: 55000 → 60500 = 10% return
    expect(m.totalReturnBrlPct).toBeCloseTo(10, 4);
  });

  it('computes max drawdown correctly', () => {
    const svc = makeService();
    const snapshots = [
      makeSnapshot('2026-01-01', 10000),
      makeSnapshot('2026-02-01', 15000), // peak
      makeSnapshot('2026-03-01', 9000),  // trough: (15000-9000)/15000 = 40%
      makeSnapshot('2026-04-01', 11000),
    ];
    const m = svc.computeMetrics(snapshots);
    expect(m.maxDrawdownPct).toBeCloseTo(40, 1);
  });

  it('computes CAGR correctly for 365-day period', () => {
    const svc = makeService();
    const snapshots = [
      makeSnapshot('2026-01-01', 10000),
      makeSnapshot('2026-12-31', 12000),
    ];
    const m = svc.computeMetrics(snapshots);
    // 364 days, ~20% return → CAGR ≈ 20%
    expect(m.cagr).not.toBeNull();
    expect(m.cagr!).toBeCloseTo(20, 0);
  });

  it('returns null sharpe for fewer than 3 snapshots', () => {
    const svc = makeService();
    const snapshots = [
      makeSnapshot('2026-01-01', 10000),
      makeSnapshot('2026-01-02', 10100),
    ];
    const m = svc.computeMetrics(snapshots);
    expect(m.sharpeRatio).toBeNull();
  });

  it('computes positive sharpe for consistently rising portfolio', () => {
    const svc = makeService();
    const snapshots = Array.from({ length: 30 }, (_, i) =>
      makeSnapshot(
        `2026-01-${String(i + 1).padStart(2, '0')}`,
        10000 + i * 50,
      ),
    );
    const m = svc.computeMetrics(snapshots);
    expect(m.sharpeRatio).not.toBeNull();
    expect(m.sharpeRatio!).toBeGreaterThan(0);
  });
});
