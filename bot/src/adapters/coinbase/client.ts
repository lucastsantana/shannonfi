/**
 * Coinbase Advanced Trade API client.
 * Authenticates every request with a freshly-signed JWT (see jwt.ts) — unlike
 * Mercado Bitcoin's cached OAuth2 token or Binance's per-request HMAC signature,
 * each Coinbase request needs its own token bound to that exact method+path.
 */

import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { generateCoinbaseJwt } from './jwt';
import { logger } from '../../core/tracker/logger';

export class CoinbaseClient {
  private http: AxiosInstance;
  private host: string;

  constructor(
    private keyName: string,
    private privateKeyPem: string,
    baseUrl?: string,
  ) {
    const resolvedBaseUrl = baseUrl ?? 'https://api.coinbase.com';
    this.host = new URL(resolvedBaseUrl).host;
    this.http = axios.create({ baseURL: resolvedBaseUrl, timeout: 15_000 });
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429,
    });
  }

  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const jwt = await generateCoinbaseJwt(this.keyName, this.privateKeyPem, 'GET', path, this.host);
    try {
      const resp = await this.http.get<T>(path, {
        params,
        headers: { Authorization: `Bearer ${jwt}` },
      });
      return resp.data;
    } catch (err) {
      const status = (err as any).response?.status;
      const data = (err as any).response?.data;
      logger.error('Coinbase HTTP GET error', { path, status, data });
      throw err;
    }
  }

  async post<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
    const jwt = await generateCoinbaseJwt(this.keyName, this.privateKeyPem, 'POST', path, this.host);
    try {
      const resp = await this.http.post<TRes>(path, body, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
      });
      return resp.data;
    } catch (err) {
      const status = (err as any).response?.status;
      const data = (err as any).response?.data;
      logger.error('Coinbase HTTP POST error', { path, status, data });
      throw err;
    }
  }
}
