import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import axiosRetry from 'axios-retry';
import Bottleneck from 'bottleneck';
import { generateJwt, AuthConfig } from './auth';
import {
  COINBASE_API_BASE,
  COINBASE_BROKERAGE_PATH as BROKERAGE_PATH,
  COINBASE_PRIVATE_RATE_LIMIT_RPS as PRIVATE_RATE_LIMIT_RPS,
} from '../../constants';
import { logger } from '../../core/tracker/logger';

const MAX_API_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

export class CoinbaseClient {
  private http: AxiosInstance;
  private limiter: Bottleneck;
  private authConfig: AuthConfig;

  constructor(authConfig: AuthConfig, baseUrl = COINBASE_API_BASE) {
    this.authConfig = authConfig;

    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Retry on network errors and 5xx — not 4xx (those are caller logic errors)
    axiosRetry(this.http, {
      retries: MAX_API_RETRIES,
      retryDelay: (retryCount) =>
        axiosRetry.exponentialDelay(retryCount, undefined, RETRY_BASE_DELAY_MS),
      retryCondition: (error) =>
        axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        (error.response !== undefined && error.response.status >= 500),
      onRetry: (retryCount, error) => {
        logger.warn('API request retry', {
          retryCount,
          status: error.response?.status,
          message: error.message,
        });
      },
    });

    // Token bucket: 10 req/s; minTime: 105ms keeps effective rate at ~9.5/s
    this.limiter = new Bottleneck({
      reservoir: PRIVATE_RATE_LIMIT_RPS,
      reservoirRefreshAmount: PRIVATE_RATE_LIMIT_RPS,
      reservoirRefreshInterval: 1_000,
      maxConcurrent: 3,
      minTime: 105,
    });
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const fullPath = `${BROKERAGE_PATH}${path}`;
    const queryString = params
      ? '?' + new URLSearchParams(params).toString()
      : '';

    return this.limiter.schedule(async () => {
      const jwt = generateJwt(this.authConfig, 'GET', `${fullPath}${queryString}`);
      const config: AxiosRequestConfig = {
        headers: { Authorization: `Bearer ${jwt}` },
        params,
      };
      const response = await this.http.get<T>(fullPath, config);
      return response.data;
    });
  }

  async post<TBody, TResponse>(path: string, body: TBody): Promise<TResponse> {
    const fullPath = `${BROKERAGE_PATH}${path}`;

    return this.limiter.schedule(async () => {
      const jwt = generateJwt(this.authConfig, 'POST', fullPath);
      const config: AxiosRequestConfig = {
        headers: { Authorization: `Bearer ${jwt}` },
      };
      const response = await this.http.post<TResponse>(fullPath, body, config);
      return response.data;
    });
  }
}
