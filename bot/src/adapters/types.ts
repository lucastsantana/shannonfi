/**
 * Shared BRL-native types and the ExchangeAdapter interface.
 *
 * All monetary values are in BRL throughout the engine.
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
   * Direction is relative to the base asset (the non-BRL side of the pair).
   */
  executeTrade(
    direction: 'BUY_BASE' | 'SELL_BASE',
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
  baseBalance: number;    // balance of the base asset (non-BRL side)
  brlBalance: number;     // cash balance in BRL
  basePrice: number;      // BRL/BASE at time of snapshot
  baseValueBrl: number;
  totalValueBrl: number;
  baseRatioBps: number;   // base asset % * 10_000
  deviationBps: number;   // |baseRatioBps - 5000|
  timestamp: string;      // ISO 8601
}

export type TradeStatus = 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'DRY_RUN' | 'PENDING';

/** BRL-native trade record. */
export interface TradeRecord {
  id: string;
  clientOrderId: string;
  exchangeOrderId: string | null;
  exchange: 'mercadobitcoin' | 'binance';
  timestamp: string;
  direction: 'BUY_BASE' | 'SELL_BASE';
  brlAmountTarget: number;
  baseAmountFilled: number | null;
  brlAmountFilled: number | null;
  fillPrice: number | null;       // BRL/SOL
  feeBrl: number | null;
  status: TradeStatus;
  portfolioBefore: Portfolio;
  portfolioAfter: Portfolio | null;
  dryRun: boolean;
  realizedGainBrl: number | null;
  tradeDateBRT: string | null;    // YYYY-MM-DD BRT
  baseAsset: string | null;       // which asset this trade was for (supports asset rotation)
}

/** Daily BRL-native portfolio snapshot for track record. */
export interface PortfolioSnapshot {
  dateBRT: string;
  timestamp: string;
  totalValueBrl: number;
  baseBalance: number;
  brlBalance: number;
  basePrice: number;              // BRL/BASE
  baseRatioBps: number;
  effectiveThresholdBps: number;
  rebalancedToday: boolean;
  exchange: 'mercadobitcoin' | 'binance';
  baseAsset: string | null;       // which asset was active at this snapshot (supports asset rotation)
}
