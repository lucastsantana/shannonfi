import { CoinbaseClient } from './client';
import {
  ListAccountsResponse,
  GetBestBidAskResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  GetOrderResponse,
  GetCandlesResponse,
  CandleGranularity,
} from './raw-types';
import { COINBASE_PRODUCT_ID, COINBASE_BACKTEST_GRANULARITY } from '../../constants';

export class CoinbaseEndpoints {
  constructor(private client: CoinbaseClient) {}

  async listAccounts(): Promise<ListAccountsResponse> {
    return this.client.get<ListAccountsResponse>('/accounts');
  }

  async getBestBidAsk(productId = COINBASE_PRODUCT_ID): Promise<GetBestBidAskResponse> {
    return this.client.get<GetBestBidAskResponse>('/best_bid_ask', {
      product_ids: productId,
    });
  }

  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    return this.client.post<CreateOrderRequest, CreateOrderResponse>('/orders', request);
  }

  async getOrder(orderId: string): Promise<GetOrderResponse> {
    return this.client.get<GetOrderResponse>(`/orders/historical/${orderId}`);
  }

  async getCandles(
    start: number,
    end: number,
    granularity: CandleGranularity = COINBASE_BACKTEST_GRANULARITY,
    productId = COINBASE_PRODUCT_ID,
  ): Promise<GetCandlesResponse> {
    return this.client.get<GetCandlesResponse>(
      `/products/${productId}/candles`,
      { start: String(start), end: String(end), granularity },
    );
  }
}
