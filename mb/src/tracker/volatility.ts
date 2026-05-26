import { MbEndpoints } from '../mb/endpoints';
import { computeMeanAbsoluteDailyReturn, computeAdaptiveThresholdBps } from '../math';
import { logger } from './logger';

export class VolatilityService {
  constructor(
    private endpoints: MbEndpoints,
    private windowDays = 30,
  ) {}

  /**
   * Fetches windowDays+1 daily candles for SOL-BRL, computes the 30-day mean
   * absolute daily return, and returns an adaptive threshold in BPS.
   */
  async computeAdaptiveThresholdBps(multiplier: number): Promise<number> {
    const candles = await this.endpoints.getCandles(this.windowDays + 1, '1d');
    const closes = candles.c.map((c) => parseFloat(c));

    if (closes.length < 2) {
      throw new Error('Insufficient candle data for volatility computation');
    }

    const mad = computeMeanAbsoluteDailyReturn(closes);
    const thresholdBps = computeAdaptiveThresholdBps(mad, multiplier);

    logger.info('Computed adaptive threshold (SOL-BRL)', {
      windowDays: this.windowDays,
      candlesReceived: closes.length,
      madPct: (mad * 100).toFixed(2) + '%',
      multiplier,
      thresholdBps,
    });

    return thresholdBps;
  }
}
