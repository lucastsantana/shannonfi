/**
 * External benchmark data fetchers.
 * CDI from BACEN SGS series 12 (public, no API key).
 * IBOV from Yahoo Finance ^BVSP (public, no API key).
 * Both degrade gracefully to available=false on failure.
 */

import axios from 'axios';
import axiosRetry from 'axios-retry';
import { BenchmarkReturn } from '../scripts/report-types';

const http = axios.create({ timeout: 10_000 });
axiosRetry(http, { retries: 2, retryDelay: axiosRetry.exponentialDelay });

interface BacenDailyRate {
  data: string;   // "DD/MM/YYYY"
  valor: string;  // e.g. "0.05296" (percent per day)
}

function formatBacenDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function compoundDailyRates(rates: BacenDailyRate[]): number {
  return rates.reduce((acc, r) => acc * (1 + parseFloat(r.valor) / 100), 1) - 1;
}

function isoToUnix(isoDate: string): number {
  return Math.floor(new Date(isoDate + 'T00:00:00Z').getTime() / 1000);
}

function parseYahooClose(data: unknown): number[] {
  const result = (data as any)?.chart?.result?.[0];
  if (!result) throw new Error('Unexpected Yahoo Finance response shape');
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  return closes.filter((c: unknown) => typeof c === 'number' && !isNaN(c));
}

export class BenchmarksService {
  async fetchCdi(startDate: string, endDate: string): Promise<BenchmarkReturn> {
    try {
      const url =
        `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados.json` +
        `?formato=json&dataInicial=${formatBacenDate(startDate)}&dataFinal=${formatBacenDate(endDate)}`;
      const res = await http.get<BacenDailyRate[]>(url);
      const rates = res.data;
      if (!Array.isArray(rates) || rates.length === 0) {
        return { monthlyReturn: 0, cumulativeReturn: 0, available: false, source: 'BACEN SGS 12' };
      }
      const compound = compoundDailyRates(rates);
      return {
        monthlyReturn: compound,
        cumulativeReturn: compound,
        available: true,
        source: 'BACEN SGS série 12',
      };
    } catch {
      return { monthlyReturn: 0, cumulativeReturn: 0, available: false, source: 'BACEN SGS 12' };
    }
  }

  async fetchIbov(startDate: string, endDate: string): Promise<BenchmarkReturn> {
    try {
      const period1 = isoToUnix(startDate);
      const period2 = isoToUnix(endDate) + 86400; // inclusive end
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP` +
        `?period1=${period1}&period2=${period2}&interval=1d`;
      const res = await http.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
      });
      const closes = parseYahooClose(res.data);
      if (closes.length < 2) {
        return { monthlyReturn: 0, cumulativeReturn: 0, available: false, source: 'Yahoo Finance ^BVSP' };
      }
      const ret = (closes[closes.length - 1]! - closes[0]!) / closes[0]!;
      return {
        monthlyReturn: ret,
        cumulativeReturn: ret,
        available: true,
        source: 'Yahoo Finance ^BVSP',
      };
    } catch {
      return { monthlyReturn: 0, cumulativeReturn: 0, available: false, source: 'Yahoo Finance ^BVSP' };
    }
  }
}
