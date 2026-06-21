/**
 * USD/BRL exchange rate service, for adapters whose exchange quotes in USD instead
 * of BRL (e.g. Coinbase). Converts at the adapter boundary so every other layer
 * (math.ts, costbasis.ts, tax.ts, history.ts, dashboard.ts, report-builder.ts) keeps
 * operating on plain "BRL" values exactly as it already does — see
 * docs/coinbase-adapter-plan.md for why this boundary was chosen over threading a
 * currency code through the whole engine.
 *
 * Rate source: BACEN SGS série 1 — "Taxa de câmbio - Livre - Dólar americano
 * (venda)", the official PTAX sell rate. This is the rate Receita Federal guidance
 * points to for converting foreign-currency-denominated gains to BRL for capital
 * gains tax purposes (Lei 9.250/1995 Art. 21 still applies to a Brazilian tax
 * resident's crypto sales "no Brasil ou no exterior" — the law isn't domestic-only).
 * Confirm this is still correct with an accountant before relying on it for an
 * actual tax filing; this is general, non-exhaustive guidance, not tax advice.
 */

import axios from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from './logger';

const http = axios.create({ timeout: 10_000 });
axiosRetry(http, { retries: 2, retryDelay: axiosRetry.exponentialDelay });

const PTAX_VENDA_SGS_SERIES = 1;
// PTAX can lag a day or two on weekends/holidays — pull a trailing window and use
// the most recent published value rather than requesting the exact day, which can
// come back empty.
const TRAILING_WINDOW_DAYS = 7;

interface BacenDailyRate {
  data: string;   // "DD/MM/YYYY"
  valor: string;  // e.g. "5.4321"
}

function formatBacenDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export class FxRateService {
  // Cached result — PTAX is published once per BRT business day, so one fetch per
  // calendar day suffices (same shape as VolatilityService's daily candle cache).
  private cachedDate: string | null = null;
  private cachedRate: number | null = null;

  /**
   * Returns the most recently published PTAX venda (USD/BRL sell) rate, recomputing
   * only once per calendar day (BRT). Throws if BACEN is unreachable and there is no
   * cached value to fall back on — callers (the Coinbase adapter) should treat that
   * as a hard failure rather than silently trading against a stale or fabricated rate.
   */
  async getUsdBrlRate(): Promise<number> {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    if (this.cachedDate === todayBRT && this.cachedRate !== null) {
      logger.debug('Using cached PTAX rate', { date: todayBRT, rate: this.cachedRate });
      return this.cachedRate;
    }

    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - TRAILING_WINDOW_DAYS);

    const url =
      `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${PTAX_VENDA_SGS_SERIES}/dados` +
      `?formato=json&dataInicial=${formatBacenDate(start)}&dataFinal=${formatBacenDate(end)}`;

    let rates: BacenDailyRate[];
    try {
      const res = await http.get<BacenDailyRate[]>(url);
      rates = res.data;
    } catch (err) {
      if (this.cachedRate !== null) {
        logger.warn('PTAX fetch failed, reusing previous day\'s cached rate', {
          error: (err as Error).message,
          staleDate: this.cachedDate,
        });
        return this.cachedRate;
      }
      throw new Error(`Failed to fetch PTAX rate from BACEN: ${(err as Error).message}`);
    }

    if (!Array.isArray(rates) || rates.length === 0) {
      if (this.cachedRate !== null) return this.cachedRate;
      throw new Error('BACEN returned no PTAX data for the trailing window');
    }

    const latest = rates[rates.length - 1]!;
    const rate = parseFloat(latest.valor);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`BACEN returned an invalid PTAX rate: ${latest.valor}`);
    }

    this.cachedDate = todayBRT;
    this.cachedRate = rate;

    logger.info('Fetched PTAX USD/BRL rate (will cache for today)', {
      ptaxDate: latest.data,
      rate,
    });

    return rate;
  }
}
