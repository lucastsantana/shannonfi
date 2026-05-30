/**
 * Binance HMAC-SHA256 signed HTTP client.
 * Handles both public (unauthenticated) and signed (authenticated) requests.
 */

import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '../../core/tracker/logger';

export class BinanceClient {
  private http: AxiosInstance;

  constructor(
    private apiKey: string,
    private apiSecret: string,
    baseURL: string,
  ) {
    this.http = axios.create({ baseURL, timeout: 15_000 });
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429,
    });
  }

  /**
   * Public (unauthenticated) GET request.
   * Used for candles, ticker, and exchange info endpoints.
   */
  async get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    try {
      const resp = await this.http.get<T>(path, { params });
      return resp.data;
    } catch (err) {
      const status = (err as any).response?.status;
      const data = (err as any).response?.data;
      logger.error('Binance HTTP GET error', { path, status, data });
      throw err;
    }
  }

  /**
   * Signed (authenticated) request using HMAC-SHA256.
   * Adds X-MBX-APIKEY header and signature to query params.
   * Timestamp is automatically added and included in the signature.
   */
  async signed<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const timestamp = Date.now();
    const queryParams: Record<string, string | number | boolean> = { ...params, timestamp };

    // Build query string from params (sorted by key)
    const queryKeys = Object.keys(queryParams).sort();
    const queryString = queryKeys
      .map((k) => `${k}=${encodeURIComponent(String(queryParams[k]))}`)
      .join('&');

    const signature = this.sign(queryString);

    try {
      const signedParams: Record<string, string | number | boolean> = { ...queryParams, signature };
      const resp = method === 'GET'
        ? await this.http.get<T>(path, {
            params: signedParams,
            headers: { 'X-MBX-APIKEY': this.apiKey },
          })
        : await this.http.post<T>(path, {}, {
            params: signedParams,
            headers: { 'X-MBX-APIKEY': this.apiKey },
          });
      return resp.data;
    } catch (err) {
      const status = (err as any).response?.status;
      const data = (err as any).response?.data;
      logger.error(`Binance HTTP ${method} error`, { path, status, data });
      throw err;
    }
  }

  private sign(queryString: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }
}
