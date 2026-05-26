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
   * Returns the current SOL price in BRL.
   * Cheap single-endpoint call used every poll cycle to check drift before fetching balances.
   * Fetches latest daily candle close from the public endpoint (no auth required).
   */
  getPrice(): Promise<number>;

  /**
   * Returns current portfolio state in BRL.
   * If knownPrice is supplied the adapter skips its price fetch and uses it directly,
   * avoiding a redundant API call when the engine already has a fresh price.
   */
  getPortfolio(knownPrice?: number): Promise<Portfolio>;

  /**
   * Executes a market order denominated in BRL.
   */
  executeTrade(
    direction: 'BUY_SOL' | 'SELL_SOL',
    brlAmount: number,
    portfolioBefore: Portfolio,
  ): Promise<TradeRecord>;

  /**
   * Returns close prices in BRL for the last `countback` candles.
   * Used by VolatilityService (cached — only called once per calendar day).
   */
  getCandles(countback: number, resolution: CandleResolution): Promise<number[]>;
}

// ─── Shared domain types ──────────────────────────────────────────────────────

/** BRL-native portfolio snapshot. */
export interface Portfolio {
  solBalance: number;
  brlBalance: number;     // cash balance in BRL
  solPrice: number;       // BRL/SOL at time of snapshot
  solValueBrl: number;
  totalValueBrl: number;
  solRatioBps: number;    // sol% * 10_000
  deviationBps: number;   // |solRatioBps - 5000|
  timestamp: string;      // ISO 8601
}

export type TradeStatus = 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'DRY_RUN' | 'PENDING';

/** BRL-native trade record. */
export interface TradeRecord {
  id: string;
  clientOrderId: string;
  exchangeOrderId: string | null;
  exchange: 'mercadobitcoin';
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
  exchange: 'mercadobitcoin';
}
