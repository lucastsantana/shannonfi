// Mercado Bitcoin API v4 response types

// ─── OAuth2 token ────────────────────────────────────────────────────────────

export interface OAuth2TokenResponse {
  access_token: string;
  expires_in: number;   // seconds
  token_type: string;
  scope: string;
}

// ─── GET /api/v4/accounts ────────────────────────────────────────────────────

export interface MbAccount {
  id: string;
  name: string;
  type: string;
  currency: string;
  currency_sign: string;
}

// ─── GET /api/v4/accounts/{accountId}/balances ───────────────────────────────

export interface MbBalance {
  symbol: string;      // "BRL", "SOL", etc.
  available: string;   // parse as float
  on_hold: string;
  total: string;
}

// ─── POST /api/v4/accounts/{accountId}/{symbol}/orders ───────────────────────

export type MbOrderSide = 'buy' | 'sell';
export type MbOrderType = 'market' | 'limit' | 'stoplimit' | 'post-only';

export interface MbCreateOrderRequest {
  type: MbOrderType;
  side: MbOrderSide;
  qty?: string;        // base asset quantity — for SELL
  cost?: number;       // BRL to spend — for market BUY
  async?: boolean;
  externalId?: string; // client order ID
}

// MB POST /orders returns a minimal response — orderId + status only.
// The full MbOrder shape is only returned by GET /orders/{orderId}.
export interface MbCreateOrderResponse {
  orderId: string;
  status: string;
}

export type MbOrderStatus = 'created' | 'working' | 'filled' | 'cancelled' | 'partially_filled';

export interface MbOrderExecution {
  id: string;
  price: number;
  qty: string;
  fee_rate: string;
  liquidity: 'maker' | 'taker';
  executed_at: string;
}

export interface MbOrder {
  id: string;
  instrument: string;      // "SOL-BRL"
  side: MbOrderSide;
  type: MbOrderType;
  status: MbOrderStatus;
  qty: string;             // base (SOL) quantity
  filledQty: string;
  avgPrice: number;        // BRL/SOL fill price (0 if not filled)
  cost: number;            // BRL spent/received
  fee: string;             // BRL fees
  created_at: string;
  updated_at: string;
  executions: MbOrderExecution[];
  externalId?: string;
}

// ─── GET /api/v4/candles ─────────────────────────────────────────────────────

// Columnar format: parallel arrays indexed by bar
export interface MbCandlesResponse {
  t: number[];    // Unix timestamps
  o: string[];    // open prices (BRL)
  h: string[];    // high prices
  l: string[];    // low prices
  c: string[];    // close prices
  v: string[];    // volume (SOL)
}

export type MbCandleResolution = '1m' | '15m' | '1h' | '3h' | '1d' | '1w' | '1M';

// ─── GET /api/v4/tickers ─────────────────────────────────────────────────────

export interface MbTicker {
  pair: string;     // e.g. "HYPE-BRL"
  high: string;     // highest price in 24h
  low: string;      // lowest price in 24h
  vol: string;      // volume in base asset (e.g. HYPE) over 24h
  last: string;     // last price
  buy: string;      // current buy price
  sell: string;     // current sell price
  open: string;     // opening price in 24h
  date: number;     // unix timestamp
}

// Note: /tickers endpoint returns an array, not an object
export type MbTickersResponse = MbTicker[];

// ─── GET /api/v4/accounts/{accountId}/wallet/fiat/{symbol}/deposits ──────────

export interface MbFiatDepositSource {
  bank_code?: string;
  bank_name?: string;
  account_branch?: string;
  account_number?: string;
}

export interface MbFiatDeposit {
  id: number;
  amount: string;        // BRL, parse as float
  coin: string;          // "BRL"
  status: string;        // e.g. "CREDITED"
  transferType: string;  // e.g. "pix"
  source?: MbFiatDepositSource;
  created_at: number;    // unix seconds
  updated_at: number;
}

// ─── GET /api/v4/accounts/{accountId}/wallet/{symbol}/withdraw ───────────────

// 1 = open, 2 = done, 3 = canceled
export type MbWithdrawStatus = 1 | 2 | 3;

export interface MbWithdrawal {
  id: number;
  coin: string;           // "BRL" for fiat withdrawals
  quantity: string;       // gross amount debited from the account, parse as float
  net_quantity: string;   // quantity minus fee — what actually arrives at the destination
  fee: string;
  status: MbWithdrawStatus;
  created_at: string;     // unix seconds, as a string
  updated_at: string;
}

// Portfolio, TradeRecord, and PortfolioSnapshot are defined in ../types.ts
