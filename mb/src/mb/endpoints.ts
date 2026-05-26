import { MbClient } from './client';
import {
  MbAccount,
  MbBalance,
  MbCreateOrderRequest,
  MbOrder,
  MbCandlesResponse,
  MbCandleResolution,
} from './types';
import { SYMBOL } from '../constants';

export class MbEndpoints {
  constructor(private client: MbClient) {}

  /** GET /api/v4/accounts — returns first account id */
  async getAccountId(): Promise<string> {
    const accounts = await this.client.get<MbAccount[]>('/accounts');
    const first = accounts[0];
    if (!first) throw new Error('No Mercado Bitcoin accounts found');
    return first.id;
  }

  /** GET /api/v4/accounts/{id}/balances */
  async getBalances(accountId: string): Promise<MbBalance[]> {
    return this.client.get<MbBalance[]>(`/accounts/${accountId}/balances`);
  }

  /**
   * POST /api/v4/accounts/{id}/{symbol}/orders
   * BUY: pass cost (BRL to spend), omit qty
   * SELL: pass qty (SOL to sell), omit cost
   */
  async createOrder(
    accountId: string,
    request: MbCreateOrderRequest,
  ): Promise<MbOrder> {
    return this.client.post<MbCreateOrderRequest, MbOrder>(
      `/accounts/${accountId}/${SYMBOL}/orders`,
      request,
    );
  }

  /** GET /api/v4/accounts/{id}/{symbol}/orders/{orderId} */
  async getOrder(accountId: string, orderId: string): Promise<MbOrder> {
    return this.client.get<MbOrder>(
      `/accounts/${accountId}/${SYMBOL}/orders/${orderId}`,
    );
  }

  /**
   * GET /api/v4/candles — public endpoint, no auth needed.
   * countback: number of bars ending at `to` (unix seconds).
   */
  async getCandles(
    countback: number,
    resolution: MbCandleResolution = '1d',
    symbol = SYMBOL,
  ): Promise<MbCandlesResponse> {
    const to = Math.floor(Date.now() / 1000);
    return this.client.getPublic<MbCandlesResponse>('/candles', {
      symbol,
      resolution,
      to,
      countback,
    });
  }
}
