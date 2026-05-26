import { CoinbaseEndpoints } from '../coinbase/endpoints';
import { computeMeanAbsoluteDailyReturn, computeAdaptiveThresholdBps } from '../math';
import {
  MIN_ADAPTIVE_THRESHOLD_BPS,
  MAX_ADAPTIVE_THRESHOLD_BPS,
} from '../constants';
import { logger } from './logger';

/**
 * Fetches recent daily candles from Coinbase and computes a volatility-adaptive
 * rebalance threshold. The threshold = multiplier × 30-day mean absolute daily return,
 * expressed in basis points and clamped to [MIN_ADAPTIVE, MAX_ADAPTIVE].
 */
export class VolatilityService {
  constructor(
    private endpoints: CoinbaseEndpoints,
    private windowDays = 30,
  ) {}

  /**
   * Returns the effective threshold in BPS for this rebalance cycle.
   * Throws if candle data cannot be fetched (caller should catch and fall back).
   */
  async computeAdaptiveThresholdBps(multiplier: number): Promise<number> {
    // We need windowDays+1 candles to compute windowDays returns
    const needed = this.windowDays + 1;
    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - needed * 86_400;

    const resp = await this.endpoints.getCandles(startTs, endTs, 'ONE_DAY');
    const candles = resp.candles.sort((a, b) => parseInt(a.start) - parseInt(b.start));

    if (candles.length < 2) {
      throw new Error(`Not enough candles for volatility calculation (got ${candles.length})`);
    }

    const closes = candles.map((c) => parseFloat(c.close));
    const mad = computeMeanAbsoluteDailyReturn(closes);
    const thresholdBps = computeAdaptiveThresholdBps(
      mad,
      multiplier,
      MIN_ADAPTIVE_THRESHOLD_BPS,
      MAX_ADAPTIVE_THRESHOLD_BPS,
    );

    logger.info('Computed adaptive threshold', {
      windowDays: this.windowDays,
      candlesUsed: candles.length,
      meanAbsDailyReturnPct: (mad * 100).toFixed(2),
      multiplier,
      thresholdBps,
    });

    return thresholdBps;
  }
}
