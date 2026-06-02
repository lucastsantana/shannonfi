import { ExchangeAdapter } from '../../adapters/types';
import { computeMeanAbsoluteDailyReturn, computeAdaptiveThresholdBps } from '../../math';
import { logger } from './logger';

export class VolatilityService {
  // Cached result — daily candles don't change intraday, so one fetch per calendar day suffices.
  private cachedDate: string | null = null;
  private cachedThresholdBps: number | null = null;

  constructor(
    private adapter: ExchangeAdapter,
    private windowDays = 30,
  ) {}

  /**
   * Returns the adaptive threshold in BPS, recomputing only once per calendar day (BRT).
   * On subsequent calls within the same day the cached value is returned immediately
   * without any API request.
   */
  async computeAdaptiveThresholdBps(multiplier: number): Promise<number> {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    if (this.cachedDate === todayBRT && this.cachedThresholdBps !== null) {
      logger.debug('Using cached adaptive threshold', {
        date: todayBRT,
        thresholdBps: this.cachedThresholdBps,
      });
      return this.cachedThresholdBps;
    }

    const closes = await this.adapter.getCandles(this.windowDays + 1, '1d');

    if (closes.length < 2) {
      throw new Error('Insufficient candle data for volatility computation');
    }

    const mad = computeMeanAbsoluteDailyReturn(closes);
    const thresholdBps = computeAdaptiveThresholdBps(mad, multiplier);

    this.cachedDate = todayBRT;
    this.cachedThresholdBps = thresholdBps;

    logger.info('Computed adaptive threshold (will cache for today)', {
      date: todayBRT,
      windowDays: this.windowDays,
      candlesReceived: closes.length,
      madPct: (mad * 100).toFixed(2) + '%',
      multiplier,
      thresholdBps,
    });

    return thresholdBps;
  }
}
