// Coinbase Advanced Trade API v3 raw response types.
// These are internal to the CoinbaseAdapter — do not use outside this adapter.

export interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
  default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  type: 'ACCOUNT_TYPE_CRYPTO' | 'ACCOUNT_TYPE_FIAT';
  ready: boolean;
  hold: { value: string; currency: string };
}

export interface ListAccountsResponse {
  accounts: CoinbaseAccount[];
  has_next: boolean;
  cursor: string;
  size: number;
}

export interface PricebookEntry { price: string; size: string }

export interface Pricebook {
  product_id: string;
  bids: PricebookEntry[];
  asks: PricebookEntry[];
  time: string;
}

export interface GetBestBidAskResponse {
  pricebooks: Pricebook[];
}

export type OrderSide = 'BUY' | 'SELL';

export interface MarketMarketIoc {
  quote_size?: string;
  base_size?: string;
}

export interface CreateOrderRequest {
  client_order_id: string;
  product_id: string;
  side: OrderSide;
  order_configuration: { market_market_ioc: MarketMarketIoc };
}

export interface CreateOrderSuccessResponse {
  order_id: string;
  product_id: string;
  side: OrderSide;
  client_order_id: string;
}

export interface CreateOrderResponse {
  success: boolean;
  failure_reason: string;
  client_order_id: string;
  success_response?: CreateOrderSuccessResponse;
  error_response?: {
    error: string;
    message: string;
    preview_failure_reason: string;
    new_order_failure_reason: string;
  };
}

export type CoinbaseOrderStatus =
  | 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN_ORDER_STATUS';

export interface HistoricalOrder {
  order_id: string;
  product_id: string;
  user_id: string;
  order_configuration: { market_market_ioc: MarketMarketIoc };
  side: OrderSide;
  client_order_id: string;
  status: CoinbaseOrderStatus;
  time_in_force: string;
  created_time: string;
  completion_percentage: string;
  filled_size: string;
  average_filled_price: string;
  fee: string;
  number_of_fills: string;
  filled_value: string;
  pending_cancel: boolean;
  size_in_quote: boolean;
  total_fees: string;
  size_inclusive_of_fees: boolean;
  total_value_after_fees: string;
  trigger_status: string;
  order_type: string;
  reject_reason: string;
  settled: boolean;
  product_type: string;
  reject_message: string;
  cancel_message: string;
  last_fill_time: string;
}

export interface GetOrderResponse {
  order: HistoricalOrder;
}

export type CandleGranularity =
  | 'UNKNOWN_GRANULARITY' | 'ONE_MINUTE' | 'FIVE_MINUTE' | 'FIFTEEN_MINUTE'
  | 'THIRTY_MINUTE' | 'ONE_HOUR' | 'TWO_HOUR' | 'SIX_HOUR' | 'ONE_DAY';

export interface Candle {
  start: string;
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;
}

export interface GetCandlesResponse {
  candles: Candle[];
}
