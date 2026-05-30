/**
 * Binance REST API endpoints.
 * Wraps the BinanceClient with specific endpoint logic.
 */

import { BinanceClient } from './client';
import {
  BinanceTickerPrice,
  BinanceAccountResponse,
  BinanceOrderResponse,
  BinanceExchangeInfo,
  BinanceKline,
} from './raw-types';

export class BinanceEndpoints {
  constructor(private client: BinanceClient) {}

  /**
   * Get current spot price for a symbol (e.g. SOLBRL).
   * Public endpoint.
   */
  async getTickerPrice(symbol: string): Promise<BinanceTickerPrice> {
    return this.client.get<BinanceTickerPrice>('/api/v3/ticker/price', { symbol });
  }

  /**
   * Get account balances (authenticated).
   */
  async getAccount(): Promise<BinanceAccountResponse> {
    return this.client.signed<BinanceAccountResponse>('GET', '/api/v3/account');
  }

  /**
   * Place a market order (authenticated).
   * For BUY: use quoteOrderQty (spend X BRL)
   * For SELL: use quantity (sell X base assets)
   */
  async createOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET';
    quantity?: string;
    quoteOrderQty?: string;
    newClientOrderId?: string;
  }): Promise<BinanceOrderResponse> {
    return this.client.signed<BinanceOrderResponse>('POST', '/api/v3/order', params);
  }

  /**
   * Get order status (authenticated).
   */
  async getOrder(symbol: string, orderId: string | number): Promise<BinanceOrderResponse> {
    return this.client.signed<BinanceOrderResponse>('GET', '/api/v3/order', {
      symbol,
      orderId: typeof orderId === 'string' ? parseInt(orderId, 10) : orderId,
    });
  }

  /**
   * Get candlestick data (klines) for a symbol (public).
   * Returns up to `limit` candles with the specified interval.
   */
  async getKlines(
    symbol: string,
    interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d',
    limit: number,
  ): Promise<BinanceKline[]> {
    const data = await this.client.get<unknown[][]>('/api/v3/klines', {
      symbol,
      interval,
      limit,
    });
    return data as BinanceKline[];
  }

  /**
   * Get exchange info including LOT_SIZE filters for all symbols (public).
   */
  async getExchangeInfo(symbol?: string): Promise<BinanceExchangeInfo> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.client.get<BinanceExchangeInfo>('/api/v3/exchangeInfo', params);
  }
}
