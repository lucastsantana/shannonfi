import { CoinbaseClient } from './client';
import {
  CoinbaseAccountsResponse,
  CoinbaseCandlesResponse,
  CoinbaseCreateOrderRequest,
  CoinbaseCreateOrderResponse,
  CoinbaseGetOrderResponse,
  CoinbaseGranularity,
  CoinbaseProduct,
  CoinbaseProductsListResponse,
} from './raw-types';

export class CoinbaseEndpoints {
  constructor(private client: CoinbaseClient, private productId: string) {}

  async getCandles(
    countback: number,
    granularity: CoinbaseGranularity = 'ONE_DAY',
    productIdOverride?: string,
  ): Promise<CoinbaseCandlesResponse> {
    const end = Math.floor(Date.now() / 1000);
    // Approximate seconds-per-candle just to size the start window generously —
    // ONE_DAY is the only granularity this adapter actually uses today.
    const secondsPerCandle = granularity === 'ONE_DAY' ? 86_400 : 3_600;
    const start = end - secondsPerCandle * (countback + 2);
    // Use the public market endpoint — no auth required, same response format.
    return this.client.getPublic<CoinbaseCandlesResponse>(
      `/api/v3/brokerage/market/products/${productIdOverride ?? this.productId}/candles`,
      { start, end, granularity },
    );
  }

  async getAccounts(cursor?: string): Promise<CoinbaseAccountsResponse> {
    return this.client.get<CoinbaseAccountsResponse>('/api/v3/brokerage/accounts', {
      limit: 250,
      ...(cursor ? { cursor } : {}),
    });
  }

  async getProduct(productIdOverride?: string): Promise<CoinbaseProduct> {
    return this.client.get<CoinbaseProduct>(`/api/v3/brokerage/products/${productIdOverride ?? this.productId}`);
  }

  /**
   * Lists every SPOT product Coinbase offers (verified live: ~930 products, no
   * pagination needed — a single call returns everything). Used by the scanner to
   * discover the tradable base-asset universe dynamically instead of a hand-
   * maintained list — see scanner.ts's listAvailableBaseAssets().
   */
  async listProducts(): Promise<CoinbaseProductsListResponse> {
    // Public market endpoint — no auth required.
    return this.client.getPublic<CoinbaseProductsListResponse>('/api/v3/brokerage/market/products', {
      product_type: 'SPOT',
    });
  }

  async createOrder(request: CoinbaseCreateOrderRequest): Promise<CoinbaseCreateOrderResponse> {
    return this.client.post<CoinbaseCreateOrderRequest, CoinbaseCreateOrderResponse>(
      '/api/v3/brokerage/orders',
      request,
    );
  }

  async getOrder(orderId: string): Promise<CoinbaseGetOrderResponse> {
    return this.client.get<CoinbaseGetOrderResponse>(`/api/v3/brokerage/orders/historical/${orderId}`);
  }
}
