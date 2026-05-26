import axios from 'axios';
import { logger } from '../tracker/logger';

const DEFAULT_FX_API_URL = 'https://api.frankfurter.app/latest?from=USD&to=BRL';
const FX_TIMEOUT_MS = 5_000;

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: { BRL: number };
}

/**
 * Fetches the current USD/BRL exchange rate from the Frankfurter API (ECB rates).
 * Returns null if the request fails — callers must handle graceful degradation.
 *
 * The API URL can be overridden via the FX_API_URL env var (useful in tests).
 */
export async function fetchUsdBrlRate(fxApiUrl?: string): Promise<number | null> {
  const url = fxApiUrl ?? process.env['FX_API_URL'] ?? DEFAULT_FX_API_URL;
  try {
    const resp = await axios.get<FrankfurterResponse>(url, { timeout: FX_TIMEOUT_MS });
    const rate = resp.data.rates?.BRL;
    if (!rate || rate <= 0) {
      logger.warn('FX API returned invalid BRL rate', { rate });
      return null;
    }
    return rate;
  } catch (err) {
    logger.warn('Failed to fetch USD/BRL rate — BRL tracking skipped this cycle', {
      error: (err as Error).message,
      url,
    });
    return null;
  }
}
