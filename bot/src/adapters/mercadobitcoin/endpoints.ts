import { MbClient } from './client';
import {
  MbAccount,
  MbBalance,
  MbCreateOrderRequest,
  MbOrder,
  MbCandlesResponse,
  MbCandleResolution,
} from './raw-types';
import { MB_SYMBOL } from '../../constants';

export class MbEndpoints {
  constructor(private client: MbClient) {}

  async getAccountId(): Promise<string> {
    const accounts = await this.client.get<MbAccount[]>('/accounts');
    const first = accounts[0];
    if (!first) throw new Error('No Mercado Bitcoin accounts found');
    return first.id;
  }

  async getBalances(accountId: string): Promise<MbBalance[]> {
    return this.client.get<MbBalance[]>(`/accounts/${accountId}/balances`);
  }

  async createOrder(accountId: string, request: MbCreateOrderRequest): Promise<MbOrder> {
    return this.client.post<MbCreateOrderRequest, MbOrder>(
      `/accounts/${accountId}/${MB_SYMBOL}/orders`,
      request,
    );
  }

  async getOrder(accountId: string, orderId: string): Promise<MbOrder> {
    return this.client.get<MbOrder>(`/accounts/${accountId}/${MB_SYMBOL}/orders/${orderId}`);
  }

  async getOrders(accountId: string, limit: number = 100): Promise<MbOrder[]> {
    return this.client.get<MbOrder[]>(`/accounts/${accountId}/${MB_SYMBOL}/orders`, { limit });
  }

  async getCandles(
    countback: number,
    resolution: MbCandleResolution = '1d',
    symbol = MB_SYMBOL,
  ): Promise<MbCandlesResponse> {
    const to = Math.floor(Date.now() / 1000);
    return this.client.getPublic<MbCandlesResponse>('/candles', {
      symbol, resolution, to, countback,
    });
  }
}
