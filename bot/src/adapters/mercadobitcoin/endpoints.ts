import { MbClient } from './client';
import {
  MbAccount,
  MbBalance,
  MbCreateOrderRequest,
  MbCreateOrderResponse,
  MbOrder,
  MbCandlesResponse,
  MbCandleResolution,
} from './raw-types';
export class MbEndpoints {
  constructor(private client: MbClient, private symbol: string) {}

  async getAccountId(): Promise<string> {
    const accounts = await this.client.get<MbAccount[]>('/accounts');
    const first = accounts[0];
    if (!first) throw new Error('No Mercado Bitcoin accounts found');
    return first.id;
  }

  async getBalances(accountId: string): Promise<MbBalance[]> {
    return this.client.get<MbBalance[]>(`/accounts/${accountId}/balances`);
  }

  async createOrder(accountId: string, request: MbCreateOrderRequest): Promise<MbCreateOrderResponse> {
    return this.client.post<MbCreateOrderRequest, MbCreateOrderResponse>(
      `/accounts/${accountId}/${this.symbol}/orders`,
      request,
    );
  }

  async getOrder(accountId: string, orderId: string): Promise<MbOrder> {
    return this.client.get<MbOrder>(`/accounts/${accountId}/${this.symbol}/orders/${orderId}`);
  }

  async getOrders(accountId: string, limit: number = 100): Promise<MbOrder[]> {
    return this.client.get<MbOrder[]>(`/accounts/${accountId}/${this.symbol}/orders`, { limit });
  }

  async getCandles(
    countback: number,
    resolution: MbCandleResolution = '1d',
    symbolOverride?: string,
  ): Promise<MbCandlesResponse> {
    const to = Math.floor(Date.now() / 1000);
    return this.client.getPublic<MbCandlesResponse>('/candles', {
      symbol: symbolOverride ?? this.symbol, resolution, to, countback,
    });
  }
}
