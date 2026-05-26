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
  qty?: string;        // SOL quantity — for SELL (base asset)
  cost?: number;       // BRL to spend — for market BUY (quote asset)
  async?: boolean;
  externalId?: string; // client order ID
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

// ─── Internal Portfolio & Trade Types ────────────────────────────────────────

export interface Portfolio {
  solBalance: number;
  brlBalance: number;
  solPrice: number;      // BRL/SOL
  solValueBrl: number;
  totalValueBrl: number;
  solRatioBps: number;   // sol% * 10000
  deviationBps: number;  // |solRatioBps - 5000|
  timestamp: string;
}

export interface TradeRecord {
  id: string;
  clientOrderId: string;
  mbOrderId: string | null;
  timestamp: string;
  direction: 'BUY_SOL' | 'SELL_SOL';
  brlAmountTarget: number;    // BRL amount we intended to trade
  solAmountFilled: number | null;
  brlAmountFilled: number | null;
  fillPrice: number | null;   // BRL/SOL
  feeBrl: number | null;
  status: MbOrderStatus | 'DRY_RUN' | 'PENDING';
  portfolioBefore: Portfolio;
  portfolioAfter: Portfolio | null;
  dryRun: boolean;
  // Tax tracking
  realizedGainBrl: number | null;
  tradeDateBRT: string | null;  // YYYY-MM-DD
}

// Daily portfolio snapshot for track record metrics.
export interface PortfolioSnapshot {
  dateBRT: string;            // YYYY-MM-DD
  timestamp: string;          // ISO 8601
  totalValueBrl: number;
  solBalance: number;
  brlBalance: number;
  solPrice: number;           // BRL/SOL
  solRatioBps: number;
  effectiveThresholdBps: number;
  rebalancedToday: boolean;
}
