/**
 * Pure math functions for Shannon's Demon rebalancing.
 * All monetary values are BRL throughout — adapters convert from native currency
 * before calling these functions.
 */

import {
  BPS_DENOMINATOR,
  TARGET_ALLOCATION_BPS,
  MIN_ADAPTIVE_THRESHOLD_BPS,
  MAX_ADAPTIVE_THRESHOLD_BPS,
} from './constants';

/** SOL allocation as basis points of total portfolio. */
export function computeSolRatioBps(solValueBrl: number, totalValueBrl: number): number {
  if (totalValueBrl <= 0) return 0;
  return Math.round((solValueBrl / totalValueBrl) * BPS_DENOMINATOR);
}

/** Absolute deviation from 50/50 target in basis points. */
export function computeDeviationBps(solRatioBps: number): number {
  return Math.abs(solRatioBps - TARGET_ALLOCATION_BPS);
}

/** Returns true if drift strictly exceeds threshold. */
export function shouldRebalance(solRatioBps: number, thresholdBps: number): boolean {
  return computeDeviationBps(solRatioBps) > thresholdBps;
}

/** BRL amount and direction needed to restore 50/50. */
export function computeRebalanceTrade(
  solValueBrl: number,
  brlBalance: number,
): { direction: 'BUY_SOL' | 'SELL_SOL'; brlAmount: number } {
  const total = solValueBrl + brlBalance;
  const target = total / 2;
  if (solValueBrl > target) {
    return { direction: 'SELL_SOL', brlAmount: solValueBrl - target };
  }
  return { direction: 'BUY_SOL', brlAmount: target - solValueBrl };
}

/**
 * Convert BRL amount to SOL quantity at a given price.
 * Floors at `precision` decimal places to avoid rounding above available SOL.
 */
export function brlToSol(brlAmount: number, solPriceBrl: number, precision = 8): number {
  const raw = brlAmount / solPriceBrl;
  const factor = Math.pow(10, precision);
  return Math.floor(raw * factor) / factor;
}


/**
 * Mean absolute daily return over an array of close prices (oldest first).
 * Returns 0 if fewer than 2 prices.
 */
export function computeMeanAbsoluteDailyReturn(closes: number[]): number {
  if (closes.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    if (prev > 0) sum += Math.abs((curr - prev) / prev);
  }
  return sum / (closes.length - 1);
}

/**
 * Adaptive threshold in BPS = round(mad * 10_000 * multiplier),
 * clamped to [MIN_ADAPTIVE_THRESHOLD_BPS, MAX_ADAPTIVE_THRESHOLD_BPS].
 */
export function computeAdaptiveThresholdBps(
  meanAbsReturn: number,
  multiplier: number,
  minBps = MIN_ADAPTIVE_THRESHOLD_BPS,
  maxBps = MAX_ADAPTIVE_THRESHOLD_BPS,
): number {
  const raw = Math.round(meanAbsReturn * BPS_DENOMINATOR * multiplier);
  return Math.max(minBps, Math.min(maxBps, raw));
}

/** True if fill price is within maxSlippageBps of expected price. */
export function isSlippageAcceptable(
  expectedPrice: number,
  fillPrice: number,
  maxSlippageBps: number,
): boolean {
  if (expectedPrice <= 0) return true;
  const slippage = Math.abs((fillPrice - expectedPrice) / expectedPrice) * BPS_DENOMINATOR;
  return slippage <= maxSlippageBps;
}

/** NAV per share — port of compute_nav_per_share() from math.rs. */
export function computeNavPerShare(totalValueBrl: number, totalShares: number): number {
  if (totalShares <= 0) throw new Error('totalShares must be positive');
  return totalValueBrl / totalShares;
}

/** Integer square root — port of isqrt_u128() from math.rs (Newton-Raphson). */
export function isqrt(n: bigint): bigint {
  if (n === 0n) return 0n;
  let x = BigInt(Math.ceil(Math.sqrt(Number(n))));
  while (true) {
    const x1 = (x + n / x) / 2n;
    if (x1 >= x) break;
    x = x1;
  }
  return x;
}
