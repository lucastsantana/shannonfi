import { MIN_ADAPTIVE_THRESHOLD_BPS, MAX_ADAPTIVE_THRESHOLD_BPS } from './constants';

const BPS_DENOMINATOR = 10_000;

/**
 * Ratio of SOL value to total portfolio value in basis points.
 * e.g. 5000 bps = 50%
 */
export function computeSolRatioBps(solValueBrl: number, totalValueBrl: number): number {
  if (totalValueBrl <= 0) return 0;
  return Math.round((solValueBrl / totalValueBrl) * BPS_DENOMINATOR);
}

/**
 * Absolute deviation from 50/50 target in basis points.
 */
export function computeDeviationBps(solRatioBps: number): number {
  return Math.abs(solRatioBps - BPS_DENOMINATOR / 2);
}

/**
 * Returns true if the portfolio drift exceeds the threshold.
 */
export function shouldRebalance(solRatioBps: number, thresholdBps: number): boolean {
  return computeDeviationBps(solRatioBps) >= thresholdBps;
}

/**
 * Computes BRL amount and direction needed to restore 50/50 balance.
 * Returns { direction, brlAmount } where brlAmount is the quote-side BRL to trade.
 */
export function computeRebalanceTrade(
  solValueBrl: number,
  brlBalance: number,
): { direction: 'BUY_SOL' | 'SELL_SOL'; brlAmount: number } {
  const totalBrl = solValueBrl + brlBalance;
  const targetBrl = totalBrl / 2;

  if (solValueBrl > targetBrl) {
    // SOL is overweight — sell SOL for BRL
    return { direction: 'SELL_SOL', brlAmount: solValueBrl - targetBrl };
  } else {
    // BRL is overweight — buy SOL
    return { direction: 'BUY_SOL', brlAmount: targetBrl - solValueBrl };
  }
}

/**
 * Convert BRL amount to SOL quantity at given price.
 * precision: decimal places for rounding (Mercado Bitcoin accepts up to 8)
 */
export function brlToSol(brlAmount: number, solPriceBrl: number, precision = 8): number {
  const raw = brlAmount / solPriceBrl;
  const factor = Math.pow(10, precision);
  return Math.floor(raw * factor) / factor; // floor to avoid rounding above available
}

/**
 * Mean absolute daily return over closes array (oldest first).
 * Returns 0 if fewer than 2 prices.
 */
export function computeMeanAbsoluteDailyReturn(closes: number[]): number {
  if (closes.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    if (prev > 0) {
      sum += Math.abs((curr - prev) / prev);
    }
  }
  return sum / (closes.length - 1);
}

/**
 * Adaptive threshold in BPS = round(mad * BPS_DENOMINATOR * multiplier),
 * clamped to [minBps, maxBps].
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

/**
 * Slippage check: true if fill price is within maxSlippageBps of expected.
 */
export function isSlippageAcceptable(
  expectedPrice: number,
  fillPrice: number,
  maxSlippageBps: number,
): boolean {
  if (expectedPrice <= 0) return true;
  const slippage = Math.abs((fillPrice - expectedPrice) / expectedPrice) * BPS_DENOMINATOR;
  return slippage <= maxSlippageBps;
}
