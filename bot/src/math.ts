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
import { Portfolio } from './adapters/types';

/** Base asset allocation as basis points of total portfolio. */
export function computeBaseRatioBps(baseValueBrl: number, totalValueBrl: number): number {
  if (totalValueBrl <= 0) return 0;
  return Math.round((baseValueBrl / totalValueBrl) * BPS_DENOMINATOR);
}

/**
 * Deviation as |base - brl| / min(base, brl) in basis points.
 * This scales 1:1 with the actual price move, so the threshold multiplier
 * applies directly to MAD without the 2× amplification from weight-based math.
 * Measures divergence from the last rebalance point (when holdings were equal).
 */
export function computeDeviationBps(baseValueBrl: number, brlBalance: number): number {
  const smaller = Math.min(baseValueBrl, brlBalance);
  if (smaller <= 0) return 0;
  return Math.round((Math.abs(baseValueBrl - brlBalance) / smaller) * BPS_DENOMINATOR);
}

/** Returns true if drift strictly exceeds threshold. */
export function shouldRebalance(baseValueBrl: number, brlBalance: number, thresholdBps: number): boolean {
  return computeDeviationBps(baseValueBrl, brlBalance) > thresholdBps;
}

/** BRL amount and direction needed to restore 50/50. */
export function computeRebalanceTrade(
  baseValueBrl: number,
  brlBalance: number,
): { direction: 'BUY_BASE' | 'SELL_BASE'; brlAmount: number } {
  const total = baseValueBrl + brlBalance;
  const target = total / 2;
  if (baseValueBrl > target) {
    return { direction: 'SELL_BASE', brlAmount: baseValueBrl - target };
  }
  return { direction: 'BUY_BASE', brlAmount: target - baseValueBrl };
}

/**
 * Derives the post-fill portfolio from `before` plus the trade's actual fill
 * amounts, instead of re-fetching balances from the exchange right after the
 * order fills. A fresh balance fetch can read stale data if the exchange's
 * account snapshot lags the fill confirmation by even a second or two
 * (observed live on Coinbase: a filled BUY's immediate getPortfolio() call
 * still reported the pre-trade balance, recording a 0 post-trade base
 * allocation and poisoning every subsequent drift estimate with Infinity).
 * Fees are assumed deducted from the quote (BRL) side on both directions,
 * matching Coinbase's fee model.
 */
export function computePortfolioAfterFill(
  before: Portfolio,
  direction: 'BUY_BASE' | 'SELL_BASE',
  baseAmountFilled: number,
  brlAmountFilled: number,
  feeBrl: number,
  fillPriceBrl: number,
): Portfolio {
  const baseBalance =
    direction === 'BUY_BASE' ? before.baseBalance + baseAmountFilled : before.baseBalance - baseAmountFilled;
  const brlBalance =
    direction === 'BUY_BASE'
      ? before.brlBalance - brlAmountFilled - feeBrl
      : before.brlBalance + brlAmountFilled - feeBrl;

  const baseValueBrl = baseBalance * fillPriceBrl;
  const totalValueBrl = baseValueBrl + brlBalance;

  return {
    baseBalance,
    brlBalance,
    basePrice: fillPriceBrl,
    baseValueBrl,
    totalValueBrl,
    baseRatioBps: computeBaseRatioBps(baseValueBrl, totalValueBrl),
    deviationBps: computeDeviationBps(baseValueBrl, brlBalance),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Convert BRL amount to base asset quantity at a given price.
 * Floors at `precision` decimal places to avoid rounding above available balance.
 */
export function brlToBase(brlAmount: number, basePriceBrl: number, precision = 8): number {
  const raw = brlAmount / basePriceBrl;
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
 * Ordinary-least-squares slope of closes against their index (0, 1, 2, ...),
 * normalized by the window's mean price so the result is a fractional
 * change-per-day comparable across assets of very different price magnitudes
 * (e.g. a R$0.01 token vs. a R$300,000 BTC). Used by the asset scanner as a
 * trend-direction signal: positive means uptrending, negative means
 * downtrending, near-zero means sideways. Returns 0 for fewer than 2 points or
 * a non-positive mean price (can't normalize).
 */
export function computeNormalizedTrendSlope(closes: number[]): number {
  const n = closes.length;
  if (n < 2) return 0;

  const meanX = (n - 1) / 2;
  const meanY = closes.reduce((sum, c) => sum + c, 0) / n;
  if (meanY <= 0) return 0;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    numerator += dx * ((closes[i] as number) - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) return 0;

  const slopePerDay = numerator / denominator;
  return slopePerDay / meanY;
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

