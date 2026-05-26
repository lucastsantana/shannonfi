import { describe, it, expect } from 'vitest';
import {
  computeMeanAbsoluteDailyReturn,
  computeAdaptiveThresholdBps,
} from '../src/math';

describe('computeMeanAbsoluteDailyReturn', () => {
  it('throws for fewer than 2 prices', () => {
    expect(() => computeMeanAbsoluteDailyReturn([100])).toThrow();
    expect(() => computeMeanAbsoluteDailyReturn([])).toThrow();
  });

  it('computes correct MAD for known values', () => {
    // Two prices: 100 → 110 = 10% move
    const mad = computeMeanAbsoluteDailyReturn([100, 110]);
    expect(mad).toBeCloseTo(0.1, 6);
  });

  it('handles alternating up/down correctly', () => {
    // 100 → 110 (+10%), 110 → 99 (-10%)
    const mad = computeMeanAbsoluteDailyReturn([100, 110, 99]);
    // daily returns: 0.1, 0.1 → mean = 0.1
    expect(mad).toBeCloseTo(0.1, 4);
  });

  it('returns 0 for flat prices', () => {
    const mad = computeMeanAbsoluteDailyReturn([100, 100, 100, 100]);
    expect(mad).toBe(0);
  });

  it('uses absolute values (ignores direction)', () => {
    // One up 5%, one down 5% → MAD = 5%
    const mad = computeMeanAbsoluteDailyReturn([100, 105, 99.75]);
    // |5/100| = 0.05, |5.25/105| ≈ 0.05 → mean ≈ 0.05
    expect(mad).toBeCloseTo(0.05, 2);
  });
});

describe('computeAdaptiveThresholdBps', () => {
  it('converts MAD to BPS correctly', () => {
    // 3% MAD * 1.5 multiplier = 4.5% = 450 BPS
    const bps = computeAdaptiveThresholdBps(0.03, 1.5);
    expect(bps).toBe(450);
  });

  it('clamps to minimum', () => {
    // Very low volatility: 0.1% * 1.0 = 10 BPS → clamp to 50
    const bps = computeAdaptiveThresholdBps(0.001, 1.0);
    expect(bps).toBe(50);
  });

  it('clamps to maximum', () => {
    // Very high volatility: 10% * 2.0 = 2000 BPS → clamp to 500
    const bps = computeAdaptiveThresholdBps(0.1, 2.0);
    expect(bps).toBe(500);
  });

  it('respects custom min/max bounds', () => {
    const bps = computeAdaptiveThresholdBps(0.001, 1.0, 20, 200);
    expect(bps).toBe(20);
  });

  it('rounds to nearest integer BPS', () => {
    // 2.5% * 1.0 = 250 BPS exactly
    const bps = computeAdaptiveThresholdBps(0.025, 1.0);
    expect(bps).toBe(250);
  });
});
