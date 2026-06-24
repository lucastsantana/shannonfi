import Database from 'better-sqlite3';
import { computeMeanAbsoluteDailyReturn, computeNormalizedTrendSlope } from '../math';
import { AssetCandidate, ScanResult, ScanOptions } from './types';
import { logger } from '../core/tracker/logger';
import { getDb } from '../core/tracker/db';

// Generic adapter interface for scanner (duck typing)
export interface ScannerAdapter {
  getCandlesWithVolume(
    symbol: string,
    countback: number,
  ): Promise<Array<{ close: number; volume: number; timestamp: number }>>;

  // Optional: discover the tradable base-asset universe dynamically from the
  // exchange's own product catalog (e.g. CoinbaseAdapter.listAvailableBaseAssets,
  // ranked by the exchange's own 24h volume and capped to `maxCandidates`).
  // Adapters that don't implement this (Mercado Bitcoin, Binance) fall back to
  // the hardcoded KNOWN_BASE_ASSETS list below unchanged.
  listAvailableBaseAssets?(maxCandidates: number): Promise<string[]>;
}

// Fallback base assets when the adapter has no dynamic discovery — also still
// used by Mercado Bitcoin/Binance. Some may not exist on every exchange (e.g.
// listed on Mercado Bitcoin but not yet on Coinbase) — scoreSymbol() failures
// are caught per-symbol and skipped (see the catch in scan() below), so an
// incomplete list costs a few wasted lookups, not correctness.
const KNOWN_BASE_ASSETS = [
  'BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'ADA',
  'DOGE', 'LINK', 'LTC', 'BCH', 'AVAX', 'ARB',
  'OP', 'PEPE', 'SHIB',
];

// Effectively unlimited — the point of dynamic discovery is to find lower-volume
// "hidden" candidates a top-N-by-volume pre-filter would exclude before they're
// ever scored, so this deliberately does NOT pre-rank by exchange-reported
// volume the way an earlier version of this code did. The existing post-scoring
// minVolumeBrl floor (ScanOptions) is the real, deliberate volume filter — it
// runs after a candidate's actual MAD/trend/liquidity have been computed, not
// before. At Coinbase's current ~400-500 USDC pairs and the existing
// 200ms-between-calls rate limit, a full scan takes a few minutes — comfortably
// inside scan.yml's 15-minute timeout (verified live: ~650ms/symbol observed).
const MAX_DYNAMIC_CANDIDATES = 1000;

const STABLECOIN_BASE_ASSETS = new Set([
  'USDC', 'USDT', 'BRZ', 'DAI', 'BUSD', 'PAXG', 'BRAX', 'EUR', 'jBRL', 'USD1',
]);

// Base assets confirmed to NOT exist for a given quote currency (e.g. wrong ticker,
// delisted). Keyed by quote currency since availability differs per exchange.
const UNAVAILABLE_BASE_ASSETS: Record<string, Set<string>> = {
  BRL: new Set(['MATIC', 'BNB', 'AVA']), // AVA: use AVAX instead
  USD: new Set(),
};

export class AssetScanner {
  private dbPath: string | undefined;

  constructor(
    private adapter: ScannerAdapter,
    _db: Database.Database,
    dbPath?: string,
  ) {
    this.dbPath = dbPath;
  }

  async scan(options: ScanOptions): Promise<ScanResult> {
    logger.info('Asset scanner starting', { windowDays: options.windowDays });
    const startTime = Date.now();

    // Discover symbols quoted in this instance's quote currency (BRL for MB/Binance,
    // USDC for Coinbase) — the same base-asset universe, just suffixed differently.
    const quoteCurrency = options.quoteCurrency;
    const unavailable = UNAVAILABLE_BASE_ASSETS[quoteCurrency] ?? new Set<string>();

    let baseAssets: string[] = KNOWN_BASE_ASSETS;
    let discoverySource: 'dynamic' | 'hardcoded' = 'hardcoded';
    if (this.adapter.listAvailableBaseAssets) {
      try {
        baseAssets = await this.adapter.listAvailableBaseAssets(MAX_DYNAMIC_CANDIDATES);
        discoverySource = 'dynamic';
      } catch (err) {
        logger.warn('Dynamic base-asset discovery failed, falling back to hardcoded list', {
          error: (err as Error).message,
        });
      }
    }

    let brlSymbols = [...new Set(baseAssets)]
      .filter((b) => !STABLECOIN_BASE_ASSETS.has(b) && !unavailable.has(b))
      .map((b) => `${b}-${quoteCurrency}`);

    logger.info('Symbol discovery complete', { total: brlSymbols.length, quoteCurrency, discoverySource });

    // Score each symbol with rate limiting (200ms between API calls)
    const candidates: Omit<AssetCandidate, 'rank'>[] = [];
    for (let i = 0; i < brlSymbols.length; i++) {
      const symbol = brlSymbols[i]!;
      try {
        const candidate = await this.scoreSymbol(symbol, options.windowDays, options.liquidityFullWeightBrl);
        if (candidate) {
          candidates.push(candidate);
        }
      } catch (err) {
        logger.warn('Failed to score symbol', { symbol, error: (err as Error).message });
      }
      // Rate limiting: 200ms between API calls
      if (i < brlSymbols.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // Filter by return floor, volume, and trend direction — "sideways or trending
    // up" means rejecting candidates whose normalized slope is clearly negative,
    // even if their volatility score alone looks attractive.
    const filtered = candidates.filter(
      (c) =>
        c.rollingReturn >= options.returnFloor &&
        c.avgDailyVolumeBrl >= options.minVolumeBrl &&
        c.trendSlope >= options.minTrendSlope,
    );

    // Sort by score (descending) and assign ranks
    filtered.sort((a, b) => b.score - a.score);
    const ranked: AssetCandidate[] = filtered.map((c, i) => ({
      ...c,
      rank: i + 1,
    }));

    // Take top N
    const topCandidates = ranked.slice(0, options.topN);

    const elapsedMs = Date.now() - startTime;
    logger.info('Asset scanner complete', {
      totalScanned: brlSymbols.length,
      qualified: filtered.length,
      topN: topCandidates.length,
      elapsedMs,
    });

    // Store in DB (use getDb() to ensure we have the right connection)
    const timestamp = new Date().toISOString();
    const currentSymbol = `${KNOWN_BASE_ASSETS[0]}-${quoteCurrency}`; // Placeholder, overwritten by caller
    const db = getDb(this.dbPath);

    const result = db
      .prepare(
        `INSERT INTO scans (timestamp, window_days, total_scanned, status, scan_data)
         VALUES (?, ?, ?, 'COMPLETED', ?)`,
      )
      .run(timestamp, options.windowDays, brlSymbols.length, JSON.stringify(topCandidates)) as any;

    const scanId = (result.lastInsertRowid as number) || result.changes;

    const scanResult: ScanResult = {
      id: scanId,
      timestamp,
      windowDays: options.windowDays,
      totalScanned: brlSymbols.length,
      candidates: topCandidates,
      status: 'COMPLETED',
      currentSymbol,
    };

    return scanResult;
  }

  private async scoreSymbol(
    symbol: string,
    windowDays: number,
    liquidityFullWeightBrl: number,
  ): Promise<Omit<AssetCandidate, 'rank'> | null> {
    const countback = windowDays + 1; // +1 to get windowDays returns
    const candles = await this.adapter.getCandlesWithVolume(symbol, countback);

    if (candles.length < 2) {
      logger.debug('Insufficient candle data', { symbol, count: candles.length });
      return null;
    }

    // Compute MAD (Mean Absolute Daily Return)
    const closes = candles.map((c) => c.close);
    const mad = computeMeanAbsoluteDailyReturn(closes);

    // Compute rolling return: (last - first) / first
    if (closes.length < 2) {
      logger.warn('Insufficient candle data for rolling return', { symbol, count: closes.length });
      return null;
    }
    const firstClose = closes[0]!;
    if (firstClose <= 0) {
      logger.warn('Invalid first close price', { symbol, price: firstClose });
      return null;
    }
    const lastClose = closes[closes.length - 1]!;
    const rollingReturn = (lastClose - firstClose) / firstClose;

    // Compute average daily BRL volume
    const avgDailyVolumeBrl = candles.reduce((sum, c) => sum + c.close * c.volume, 0) / candles.length;

    // Trend direction over the window — see computeNormalizedTrendSlope's docstring.
    const trendSlope = computeNormalizedTrendSlope(closes);

    // Liquidity weight: dampens the score for thin markets even above the hard
    // minVolumeBrl floor, instead of treating "just barely passed the floor" and
    // "extremely liquid" as equally good. Saturates at 1.0 — high volume doesn't
    // boost the score beyond that, it just stops being a penalty.
    const liquidityWeight = Math.min(1, avgDailyVolumeBrl / liquidityFullWeightBrl);

    // Score: MAD × (1 + rolling_return) × liquidity_weight
    const score = mad * (1 + rollingReturn) * liquidityWeight;

    const baseAsset = symbol.split('-')[0]!;

    return {
      symbol,
      baseAsset,
      mad,
      rollingReturn,
      avgDailyVolumeBrl,
      trendSlope,
      liquidityWeight,
      score,
      dataPoints: candles.length,
    };
  }
}
