import { describe, it, expect } from 'vitest';
import {
  computeBaseRatioBps,
  computeDeviationBps,
  shouldRebalance,
  computeRebalanceTrade,
  brlToBase,
  computeMeanAbsoluteDailyReturn,
  computeAdaptiveThresholdBps,
  isSlippageAcceptable,
} from '../src/math';

describe('computeBaseRatioBps', () => {
  it('returns 5000 for equal split', () => {
    expect(computeBaseRatioBps(1000, 2000)).toBe(5000);
  });

  it('returns 7500 for 75% SOL', () => {
    expect(computeBaseRatioBps(1500, 2000)).toBe(7500);
  });

  it('returns 0 for zero total', () => {
    expect(computeBaseRatioBps(0, 0)).toBe(0);
  });
});

describe('computeDeviationBps', () => {
  it('returns 0 at perfect 50/50', () => {
    // baseValueBrl = 1000, brlBalance = 1000 → |1000 - 1000| / 1000 = 0
    expect(computeDeviationBps(1000, 1000)).toBe(0);
  });

  it('returns 10000 for 75% SOL (double the BRL)', () => {
    // baseValueBrl = 1500, brlBalance = 500 → |1500 - 500| / 500 = 2 = 20000 bps
    expect(computeDeviationBps(1500, 500)).toBe(20000);
  });

  it('returns 10000 for 25% SOL (half the BRL)', () => {
    // baseValueBrl = 500, brlBalance = 1500 → |500 - 1500| / 500 = 2 = 20000 bps
    expect(computeDeviationBps(500, 1500)).toBe(20000);
  });
});

describe('shouldRebalance', () => {
  it('returns false when deviation equals threshold (strict >, not >=)', () => {
    // baseValueBrl = 1100, brlBalance = 1000 → deviation = |1100 - 1000| / 1000 = 1000 bps
    // threshold = 1000 → 1000 > 1000 = false
    expect(shouldRebalance(1100, 1000, 1000)).toBe(false);
  });

  it('returns false when deviation is below threshold', () => {
    // baseValueBrl = 1050, brlBalance = 1000 → deviation = |1050 - 1000| / 1000 = 500 bps
    // threshold = 600 → 500 > 600 = false
    expect(shouldRebalance(1050, 1000, 600)).toBe(false);
  });

  it('returns true when deviation strictly exceeds threshold', () => {
    // baseValueBrl = 1101, brlBalance = 1000 → deviation = |1101 - 1000| / 1000 = 1010 bps
    // threshold = 1000 → 1010 > 1000 = true
    expect(shouldRebalance(1101, 1000, 1000)).toBe(true);
  });

  it('returns true for large deviation', () => {
    // baseValueBrl = 1500, brlBalance = 500 → deviation = |1500 - 500| / 500 = 20000 bps
    // threshold = 1000 → 20000 > 1000 = true
    expect(shouldRebalance(1500, 500, 1000)).toBe(true);
  });
});

describe('computeRebalanceTrade', () => {
  it('sells SOL when SOL is overweight', () => {
    const { direction, brlAmount } = computeRebalanceTrade(1500, 500);
    expect(direction).toBe('SELL_BASE');
    expect(brlAmount).toBeCloseTo(500, 2);
  });

  it('buys SOL when BRL is overweight', () => {
    const { direction, brlAmount } = computeRebalanceTrade(500, 1500);
    expect(direction).toBe('BUY_BASE');
    expect(brlAmount).toBeCloseTo(500, 2);
  });

  it('sells exactly half the excess', () => {
    const { direction, brlAmount } = computeRebalanceTrade(750, 250);
    expect(direction).toBe('SELL_BASE');
    expect(brlAmount).toBeCloseTo(250, 2);
  });
});

describe('brlToBase', () => {
  it('converts BRL to SOL at given price', () => {
    expect(brlToBase(500, 250, 6)).toBeCloseTo(2, 5);
  });

  it('floors to avoid rounding above available balance', () => {
    const result = brlToBase(100, 3, 8);
    expect(result).toBeLessThanOrEqual(100 / 3);
  });
});


describe('computeMeanAbsoluteDailyReturn', () => {
  it('returns 0 for fewer than 2 prices', () => {
    expect(computeMeanAbsoluteDailyReturn([])).toBe(0);
    expect(computeMeanAbsoluteDailyReturn([100])).toBe(0);
  });

  it('computes correct MAD', () => {
    // [100, 110, 99] → |10/100| + |11/110| = 0.1 + 0.1 = 0.2 / 2 = 0.1
    expect(computeMeanAbsoluteDailyReturn([100, 110, 99])).toBeCloseTo(0.1, 5);
  });

  it('handles flat prices', () => {
    expect(computeMeanAbsoluteDailyReturn([100, 100, 100])).toBe(0);
  });
});

describe('computeAdaptiveThresholdBps', () => {
  it('clamps to minimum when MAD is zero', () => {
    expect(computeAdaptiveThresholdBps(0, 1.5)).toBe(50);
  });

  it('clamps to maximum for extreme volatility', () => {
    expect(computeAdaptiveThresholdBps(1, 1.5)).toBe(500);
  });

  it('computes correctly within range', () => {
    // 0.03 × 10000 × 1.5 = 450 bps
    expect(computeAdaptiveThresholdBps(0.03, 1.5)).toBe(450);
  });
});

describe('isSlippageAcceptable', () => {
  it('returns true within tolerance', () => {
    expect(isSlippageAcceptable(400, 402, 100)).toBe(true);
  });

  it('returns false beyond tolerance', () => {
    expect(isSlippageAcceptable(400, 410, 100)).toBe(false);
  });

  it('returns true if expectedPrice is zero', () => {
    expect(isSlippageAcceptable(0, 400, 100)).toBe(true);
  });
});
