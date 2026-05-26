import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { OAuth2TokenResponse } from './raw-types';
import { logger } from '../../core/tracker/logger';

const MB_API_BASE = 'https://api.mercadobitcoin.net/api/v4';
const TOKEN_REFRESH_BUFFER_MS = 60_000; // refresh 60s before expiry

export class MbClient {
  private http: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private clientId: string,
    private clientSecret: string,
    baseUrl = MB_API_BASE,
  ) {
    this.http = axios.create({ baseURL: baseUrl, timeout: 15_000 });
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        err.response?.status === 429,
    });
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.accessToken;
    }

    logger.debug('Refreshing Mercado Bitcoin OAuth2 token');
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'global',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const resp = await this.http.post<OAuth2TokenResponse>(
      '/oauth2/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    this.accessToken = resp.data.access_token;
    this.tokenExpiresAt = Date.now() + resp.data.expires_in * 1000;
    logger.debug('OAuth2 token refreshed', { expiresIn: resp.data.expires_in });
    return this.accessToken;
  }

  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const token = await this.ensureToken();
    try {
      const resp = await this.http.get<T>(path, {
        params,
        headers: { Authorization: `Bearer ${token}` },
      });
      return resp.data;
    } catch (err) {
      const status = (err as any).response?.status;
      const data = (err as any).response?.data;
      logger.error('HTTP GET error', { path, status, data });
      throw err;
    }
  }

  async getPublic<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const resp = await this.http.get<T>(path, { params });
    return resp.data;
  }

  async post<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
    const token = await this.ensureToken();
    try {
      const resp = await this.http.post<TRes>(path, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      return resp.data;
    } catch (err) {
      const status = (err as any).response?.status;
      const data = (err as any).response?.data;
      logger.error('HTTP POST error', { path, status, data });
      throw err;
    }
  }
}
