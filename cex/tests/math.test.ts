import { describe, it, expect } from 'vitest';
import {
  computeSolRatioBps,
  computeDeviationBps,
  shouldRebalance,
  computeRebalanceTrade,
  usdToSol,
  computeNavPerShare,
  isSlippageAcceptable,
  isqrt,
} from '../src/math';

describe('computeSolRatioBps', () => {
  it('returns 5000 for exact 50/50', () => {
    expect(computeSolRatioBps(500, 1000)).toBe(5000);
  });
  it('returns 6000 for 60/40 SOL heavy', () => {
    expect(computeSolRatioBps(600, 1000)).toBe(6000);
  });
  it('returns 4000 for 40/60 USD heavy', () => {
    expect(computeSolRatioBps(400, 1000)).toBe(4000);
  });
  it('returns 10000 for all SOL', () => {
    expect(computeSolRatioBps(1000, 1000)).toBe(10000);
  });
  it('returns 0 for no SOL', () => {
    expect(computeSolRatioBps(0, 1000)).toBe(0);
  });
  it('throws on zero total', () => {
    expect(() => computeSolRatioBps(100, 0)).toThrow('totalValue must be positive');
  });
});

describe('computeDeviationBps', () => {
  it('returns 0 for perfect 50/50', () => {
    expect(computeDeviationBps(5000)).toBe(0);
  });
  it('returns 100 for 51/49', () => {
    expect(computeDeviationBps(5100)).toBe(100);
  });
  it('returns 100 for 49/51 (absolute value)', () => {
    expect(computeDeviationBps(4900)).toBe(100);
  });
});

describe('shouldRebalance', () => {
  it('returns false when exactly at threshold (strict >)', () => {
    // 100 bps deviation, threshold 100 → NOT triggered
    expect(shouldRebalance(5100, 100)).toBe(false);
    expect(shouldRebalance(4900, 100)).toBe(false);
  });
  it('returns true when above threshold', () => {
    expect(shouldRebalance(5101, 100)).toBe(true);
    expect(shouldRebalance(4899, 100)).toBe(true);
  });
  it('returns false when below threshold', () => {
    expect(shouldRebalance(5050, 100)).toBe(false);
  });
});

describe('computeRebalanceTrade', () => {
  it('sells SOL when SOL is heavy', () => {
    // SOL $600, USD $400 → total $1000, target $500
    const trade = computeRebalanceTrade(600, 400);
    expect(trade.direction).toBe('SELL_SOL');
    expect(trade.usdAmount).toBeCloseTo(100, 6);
  });
  it('buys SOL when USD is heavy', () => {
    // SOL $400, USD $600 → total $1000, target $500
    const trade = computeRebalanceTrade(400, 600);
    expect(trade.direction).toBe('BUY_SOL');
    expect(trade.usdAmount).toBeCloseTo(100, 6);
  });
  it('returns near-zero amount when exactly 50/50', () => {
    const trade = computeRebalanceTrade(500, 500);
    expect(trade.usdAmount).toBeCloseTo(0, 6);
  });
  it('handles large values correctly', () => {
    // $60k SOL, $40k USD → total $100k, target $50k
    const trade = computeRebalanceTrade(60_000, 40_000);
    expect(trade.direction).toBe('SELL_SOL');
    expect(trade.usdAmount).toBeCloseTo(10_000, 2);
  });
});

describe('usdToSol', () => {
  it('converts USD to SOL at given price', () => {
    // $100 USD at $200/SOL = 0.5 SOL
    expect(usdToSol(100, 200)).toBeCloseTo(0.5, 8);
  });
  it('throws on zero price', () => {
    expect(() => usdToSol(100, 0)).toThrow('solPrice must be positive');
  });
  it('respects precision parameter', () => {
    const result = usdToSol(1, 3, 4);
    expect(result.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });
});

describe('computeNavPerShare', () => {
  it('returns value per share', () => {
    expect(computeNavPerShare(1000, 10)).toBe(100);
  });
  it('throws on zero shares', () => {
    expect(() => computeNavPerShare(1000, 0)).toThrow('totalShares must be positive');
  });
});

describe('isSlippageAcceptable', () => {
  it('accepts fill within 1% slippage', () => {
    // expected $100, filled $100.99 → 0.99% slippage
    expect(isSlippageAcceptable(100, 100.99, 100)).toBe(true);
  });
  it('accepts fill at exactly the limit', () => {
    // $100 → $101 is exactly 1% = 100 bps → acceptable (<=)
    expect(isSlippageAcceptable(100, 101, 100)).toBe(true);
  });
  it('rejects fill exceeding 1% slippage', () => {
    // expected $100, filled $101.01 → 1.01% slippage
    expect(isSlippageAcceptable(100, 101.01, 100)).toBe(false);
  });
  it('handles downward price movement (buy order filled lower)', () => {
    // Bought at $99 when expected $100 → 1% slippage, acceptable
    expect(isSlippageAcceptable(100, 99, 100)).toBe(true);
  });
});

describe('isqrt parity with Rust isqrt_u128', () => {
  it('matches reference values from math.rs', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(4n)).toBe(2n);
    expect(isqrt(9n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    expect(isqrt(100n)).toBe(10n);
    expect(isqrt(1_000_000n)).toBe(1_000n);
    expect(isqrt(10_000_000_000_000_000n)).toBe(100_000_000n);
  });
  it('floors non-perfect squares', () => {
    expect(isqrt(2n)).toBe(1n);
    expect(isqrt(3n)).toBe(1n);
    expect(isqrt(8n)).toBe(2n);
    expect(isqrt(15n)).toBe(3n);
  });
});
