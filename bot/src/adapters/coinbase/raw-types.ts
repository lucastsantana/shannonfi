/** Coinbase Advanced Trade API response shapes (the subset this adapter uses). */

export type CoinbaseGranularity =
  | 'ONE_MINUTE' | 'FIVE_MINUTE' | 'FIFTEEN_MINUTE' | 'THIRTY_MINUTE'
  | 'ONE_HOUR' | 'TWO_HOUR' | 'SIX_HOUR' | 'ONE_DAY';

export interface CoinbaseCandle {
  start: string;   // Unix timestamp, as a string
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;
}

export interface CoinbaseCandlesResponse {
  candles: CoinbaseCandle[];
}

export interface CoinbaseAmount {
  value: string;
  currency: string;
}

export interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: CoinbaseAmount;
  hold: CoinbaseAmount;
}

export interface CoinbaseAccountsResponse {
  accounts: CoinbaseAccount[];
  has_next: boolean;
  cursor: string;
}

export interface CoinbaseCreateOrderRequest {
  client_order_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  order_configuration: {
    market_market_ioc:
      | { quote_size: string }
      | { base_size: string };
  };
}

export interface CoinbaseCreateOrderResponse {
  success: boolean;
  success_response?: {
    order_id: string;
    product_id: string;
    side: string;
    client_order_id: string;
  };
  error_response?: {
    error: string;
    message: string;
    error_details?: string;
  };
}

export type CoinbaseOrderStatus =
  | 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export interface CoinbaseOrder {
  order_id: string;
  product_id: string;
  status: CoinbaseOrderStatus;
  filled_size: string;
  average_filled_price: string;
  total_fees: string;
  filled_value: string;
}

export interface CoinbaseGetOrderResponse {
  order: CoinbaseOrder;
}

export interface CoinbaseProduct {
  product_id: string;
  base_min_size: string;
  base_increment: string;
  quote_min_size: string;
}

/** Subset of fields actually used from GET /api/v3/brokerage/products (list, not one product) — the real response has ~40 fields, most unused here. */
export interface CoinbaseProductSummary {
  product_id: string;
  base_currency_id: string;
  quote_currency_id: string;
  status: string; // 'online' when tradable
  trading_disabled: boolean;
  is_disabled: boolean;
  approximate_quote_24h_volume: string; // 24h volume in quote-currency terms, e.g. USDC
}

export interface CoinbaseProductsListResponse {
  products: CoinbaseProductSummary[];
  num_products: number;
}
