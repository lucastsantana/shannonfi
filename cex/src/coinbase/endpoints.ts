import { CoinbaseClient } from './client';
import {
  ListAccountsResponse,
  GetBestBidAskResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  GetOrderResponse,
  GetCandlesResponse,
  CandleGranularity,
} from './types';
import { PRODUCT_ID, BACKTEST_GRANULARITY } from '../constants';

export class CoinbaseEndpoints {
  constructor(private client: CoinbaseClient) {}

  /** GET /api/v3/brokerage/accounts */
  async listAccounts(): Promise<ListAccountsResponse> {
    return this.client.get<ListAccountsResponse>('/accounts');
  }

  /**
   * GET /api/v3/brokerage/best_bid_ask?product_ids=SOL-USD
   * Mid price = (best_bid + best_ask) / 2
   */
  async getBestBidAsk(productId = PRODUCT_ID): Promise<GetBestBidAskResponse> {
    return this.client.get<GetBestBidAskResponse>('/best_bid_ask', {
      product_ids: productId,
    });
  }

  /**
   * POST /api/v3/brokerage/orders
   * BUY:  order_configuration.market_market_ioc.quote_size  (USD to spend)
   * SELL: order_configuration.market_market_ioc.base_size   (SOL to sell)
   */
  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    return this.client.post<CreateOrderRequest, CreateOrderResponse>(
      '/orders',
      request,
    );
  }

  /** GET /api/v3/brokerage/orders/historical/{order_id} */
  async getOrder(orderId: string): Promise<GetOrderResponse> {
    return this.client.get<GetOrderResponse>(`/orders/historical/${orderId}`);
  }

  /**
   * GET /api/v3/brokerage/products/SOL-USD/candles
   * Max 300 candles per request. ONE_DAY covers ~10 months per call.
   * backtest.ts pages through multiple windows for longer periods.
   */
  async getCandles(
    start: number,
    end: number,
    granularity: CandleGranularity = BACKTEST_GRANULARITY,
    productId = PRODUCT_ID,
  ): Promise<GetCandlesResponse> {
    return this.client.get<GetCandlesResponse>(
      `/products/${productId}/candles`,
      {
        start: String(start),
        end: String(end),
        granularity,
      },
    );
  }
}
