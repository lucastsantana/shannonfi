/**
 * Shared BRL-native types and the ExchangeAdapter interface.
 *
 * All monetary values are in BRL throughout the engine. Each adapter is
 * responsible for converting from its native currency (USD for Coinbase,
 * BRL for Mercado Bitcoin) before returning these types.
 */

// ─── ExchangeAdapter interface ────────────────────────────────────────────────

export type CandleResolution = '1m' | '15m' | '1h' | '1d';

export interface ExchangeAdapter {
  /**
   * Returns the current SOL price in BRL. Cheap single-endpoint call used
   * every poll cycle to check drift before fetching balances.
   * Coinbase adapter: mid of best bid/ask × live FX rate.
   * Mercado Bitcoin adapter: latest daily candle close (public endpoint, no auth).
   */
  getPrice(): Promise<number>;

  /**
   * Returns current portfolio state in BRL.
   * If knownPrice is supplied the adapter skips its price fetch and uses it directly,
   * avoiding a redundant API call when the engine already has a fresh price.
   * Coinbase adapter: fetches USD accounts, converts via live FX rate.
   * Mercado Bitcoin adapter: fetches BRL balances natively.
   */
  getPortfolio(knownPrice?: number): Promise<Portfolio>;

  /**
   * Executes a market order. brlAmount is always BRL-denominated.
   * Coinbase adapter: converts BRL→USD, places USD order, converts fill back to BRL.
   * Mercado Bitcoin adapter: passes BRL directly to the API.
   */
  executeTrade(
    direction: 'BUY_SOL' | 'SELL_SOL',
    brlAmount: number,
    portfolioBefore: Portfolio,
  ): Promise<TradeRecord>;

  /**
   * Returns close prices in BRL for the last `countback` candles.
   * Coinbase adapter: fetches SOL-USD closes and multiplies by live FX rate.
   * Mercado Bitcoin adapter: returns SOL-BRL closes directly.
   * Used by VolatilityService (cached — only called once per calendar day).
   */
  getCandles(countback: number, resolution: CandleResolution): Promise<number[]>;
}

// ─── Shared domain types ──────────────────────────────────────────────────────

/** BRL-native portfolio snapshot returned by every adapter. */
export interface Portfolio {
  solBalance: number;
  brlBalance: number;     // cash balance (BRL equivalent for Coinbase, native BRL for MB)
  solPrice: number;       // BRL/SOL at time of snapshot
  solValueBrl: number;
  totalValueBrl: number;
  solRatioBps: number;    // sol% * 10_000
  deviationBps: number;   // |solRatioBps - 5000|
  timestamp: string;      // ISO 8601
  usdBrlRate?: number;    // populated by Coinbase adapter for audit trail
}

/**
 * Normalized trade status.
 * Both adapters emit 'FILLED' (uppercase) for completed live trades.
 * Legacy on-disk records from the earlier mb/ package may have lowercase 'filled' —
 * history readers accept both during the migration window.
 */
export type TradeStatus =
  | 'FILLED'
  | 'filled'        // legacy MB on-disk compat
  | 'CANCELLED'
  | 'cancelled'     // legacy MB on-disk compat
  | 'EXPIRED'
  | 'FAILED'
  | 'DRY_RUN'
  | 'PENDING';

/** BRL-native trade record. */
export interface TradeRecord {
  id: string;
  clientOrderId: string;
  exchangeOrderId: string | null;
  exchange: 'coinbase' | 'mercadobitcoin';
  timestamp: string;
  direction: 'BUY_SOL' | 'SELL_SOL';
  brlAmountTarget: number;
  solAmountFilled: number | null;
  brlAmountFilled: number | null;
  fillPrice: number | null;       // BRL/SOL
  feeBrl: number | null;
  status: TradeStatus;
  portfolioBefore: Portfolio;
  portfolioAfter: Portfolio | null;
  dryRun: boolean;
  realizedGainBrl: number | null;
  tradeDateBRT: string | null;    // YYYY-MM-DD BRT
  usdBrlRate?: number | null;     // Coinbase adapter: FX rate used for this trade
}

/** Daily BRL-native portfolio snapshot for track record. */
export interface PortfolioSnapshot {
  dateBRT: string;
  timestamp: string;
  totalValueBrl: number;
  solBalance: number;
  brlBalance: number;
  solPrice: number;               // BRL/SOL
  solRatioBps: number;
  effectiveThresholdBps: number;
  rebalancedToday: boolean;
  exchange: 'coinbase' | 'mercadobitcoin';
  usdBrlRate?: number | null;     // Coinbase adapter only
}
