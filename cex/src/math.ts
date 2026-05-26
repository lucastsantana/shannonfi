// Port of programs/shannonfi/src/math.rs
// All functions mirror the Rust originals; number is used instead of u64.
// isqrt uses bigint for parity with isqrt_u128.

import { BPS_DENOMINATOR, TARGET_ALLOCATION_BPS } from './constants';

/**
 * Computes SOL allocation as basis points of total portfolio.
 * Port of compute_sol_ratio_bps() from math.rs.
 */
export function computeSolRatioBps(solValueUsd: number, totalValue: number): number {
  if (totalValue <= 0) throw new Error('totalValue must be positive');
  return Math.round((solValueUsd / totalValue) * BPS_DENOMINATOR);
}

/**
 * Absolute deviation from 50/50 target in basis points.
 */
export function computeDeviationBps(solRatioBps: number): number {
  return Math.abs(solRatioBps - TARGET_ALLOCATION_BPS);
}

/**
 * Returns true if drift exceeds threshold — strict greater-than, matching errors.rs BelowThreshold.
 */
export function shouldRebalance(solRatioBps: number, thresholdBps: number): boolean {
  return computeDeviationBps(solRatioBps) > thresholdBps;
}

/**
 * Computes rebalance direction and USD amount needed to restore 50/50.
 * Port of the swap direction logic in rebalance.rs.
 */
export function computeRebalanceTrade(
  solValueUsd: number,
  usdBalance: number,
): { direction: 'BUY_SOL' | 'SELL_SOL'; usdAmount: number } {
  const totalValue = solValueUsd + usdBalance;
  const targetValue = totalValue / 2;

  if (solValueUsd > targetValue) {
    return { direction: 'SELL_SOL', usdAmount: solValueUsd - targetValue };
  } else {
    return { direction: 'BUY_SOL', usdAmount: targetValue - solValueUsd };
  }
}

/**
 * Converts USD to SOL base amount at the given price.
 */
export function usdToSol(usdAmount: number, solPrice: number, precision = 8): number {
  if (solPrice <= 0) throw new Error('solPrice must be positive');
  return parseFloat((usdAmount / solPrice).toFixed(precision));
}

/**
 * NAV per share — port of compute_nav_per_share() from math.rs.
 * Used for portfolio performance tracking only (CEX bot doesn't issue shares).
 */
export function computeNavPerShare(totalValueUsd: number, totalShares: number): number {
  if (totalShares <= 0) throw new Error('totalShares must be positive');
  return totalValueUsd / totalShares;
}

/**
 * Returns true if the actual fill price is within the allowed slippage tolerance.
 */
export function isSlippageAcceptable(
  expectedPrice: number,
  fillPrice: number,
  maxSlippageBps: number,
): boolean {
  const slippageBps = (Math.abs(fillPrice - expectedPrice) / expectedPrice) * BPS_DENOMINATOR;
  return slippageBps <= maxSlippageBps;
}

/**
 * Integer square root — port of isqrt_u128() from math.rs (Newton-Raphson).
 * Used only for unit-test parity with the on-chain implementation.
 */
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
