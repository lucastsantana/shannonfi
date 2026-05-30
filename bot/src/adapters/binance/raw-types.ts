/**
 * Binance REST API response types.
 * These map directly to Binance's JSON shapes and do not leak out of the adapter layer.
 */

export interface BinanceTickerPrice {
  symbol: string;
  price: string;  // BRL/SOL quote; we parse as float
}

export interface BinanceBalance {
  asset: string;
  free: string;     // available balance as string; parse as float
  locked: string;   // locked balance as string
}

export interface BinanceAccountResponse {
  makerCommission: number;
  takerCommission: number;
  buyerCommission: number;
  sellerCommission: number;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  updateTime: number;
  accountType: string;
  balances: BinanceBalance[];
  permissions: string[];
}

export interface BinanceOrderFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
  tradeId: number;
}

export interface BinanceOrderResponse {
  symbol: string;
  orderId: number;
  orderListId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: BinanceOrderStatus;
  timeInForce: string;
  type: string;
  side: string;
  fills: BinanceOrderFill[];
}

export type BinanceOrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'PENDING_CANCEL' | 'REJECTED' | 'EXPIRED';

export interface BinanceLotSizeFilter {
  filterType: 'LOT_SIZE';
  minQty: string;
  maxQty: string;
  stepSize: string;
}

export interface BinanceSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  baseAssetPrecision: number;
  quoteAsset: string;
  quotePrecision: number;
  orderTypes: string[];
  icebergAllowed: boolean;
  filters: Array<{ filterType: string }>;
}

export interface BinanceExchangeInfo {
  timezone: string;
  serverTime: number;
  rateLimits: Array<{ rateLimitType: string; interval: string; intervalNum: number; limit: number }>;
  exchangeFilters: string[];
  symbols: BinanceSymbolInfo[];
}

// Kline (candlestick) is returned as an array of mixed types:
// [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, numberOfTrades, takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, ignore]
export type BinanceKline = [
  number,    // openTime
  string,    // open
  string,    // high
  string,    // low
  string,    // close (index 4 — what we use)
  string,    // volume
  number,    // closeTime
  string,    // quoteAssetVolume
  number,    // numberOfTrades
  string,    // takerBuyBaseAssetVolume
  string,    // takerBuyQuoteAssetVolume
  string,    // ignore
];

export interface BinanceKlinesResponse {
  // Response from klines endpoint is a 2D array of klines
  // (we request it directly as unknown[][] and parse)
}
