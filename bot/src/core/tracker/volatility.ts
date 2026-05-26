import { ExchangeAdapter } from '../../adapters/types';
import { computeMeanAbsoluteDailyReturn, computeAdaptiveThresholdBps } from '../../math';
import { logger } from './logger';

export class VolatilityService {
  constructor(
    private adapter: ExchangeAdapter,
    private windowDays = 30,
  ) {}

  /**
   * Fetches windowDays+1 daily close prices (BRL) from the adapter, computes
   * mean absolute daily return, and returns an adaptive threshold in BPS.
   */
  async computeAdaptiveThresholdBps(multiplier: number): Promise<number> {
    const closes = await this.adapter.getCandles(this.windowDays + 1, '1d');

    if (closes.length < 2) {
      throw new Error('Insufficient candle data for volatility computation');
    }

    const mad = computeMeanAbsoluteDailyReturn(closes);
    const thresholdBps = computeAdaptiveThresholdBps(mad, multiplier);

    logger.info('Computed adaptive threshold', {
      windowDays: this.windowDays,
      candlesReceived: closes.length,
      madPct: (mad * 100).toFixed(2) + '%',
      multiplier,
      thresholdBps,
    });

    return thresholdBps;
  }
}
