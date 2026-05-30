import Database from 'better-sqlite3';
import { computeMeanAbsoluteDailyReturn } from '../math';
import { AssetCandidate, ScanResult, ScanOptions } from './types';
import { logger } from '../core/tracker/logger';
import { getDb } from '../core/tracker/db';

// Generic adapter interface for scanner (duck typing)
interface ScannerAdapter {
  getCandlesWithVolume(
    symbol: string,
    countback: number,
  ): Promise<Array<{ close: number; volume: number; timestamp: number }>>;
}

const STABLECOIN_SYMBOLS = new Set([
  'USDC-BRL',
  'USDT-BRL',
  'BRZ-BRL',
  'DAI-BRL',
  'BUSD-BRL',
  'PAXG-BRL',
  'BRAX-BRL',
  'EUR-BRL',
  'jBRL-BRL', // wrapped BRL
]);

// Symbols confirmed to NOT exist on MB (return empty from /tickers)
const UNAVAILABLE_SYMBOLS = new Set([
  'MATIC-BRL',
  'BNB-BRL',
  'AVA-BRL', // Use AVAX-BRL instead
]);

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

    // Discover BRL-paired symbols
    // Use hardcoded list of known symbols; if /tickers is available, validate against it
    const knownSymbols = [
      'BTC-BRL', 'ETH-BRL', 'SOL-BRL', 'HYPE-BRL', 'XRP-BRL', 'ADA-BRL',
      'DOGE-BRL', 'LINK-BRL', 'LTC-BRL', 'BCH-BRL', 'AVAX-BRL', 'ARB-BRL',
      'OP-BRL', 'PEPE-BRL', 'SHIB-BRL',
      // Stablecoins (will be filtered out)
      'USDC-BRL', 'USDT-BRL', 'DAI-BRL', 'BRZ-BRL',
    ];

    // Filter out unavailable and stablecoin symbols
    let brlSymbols = knownSymbols.filter(
      (s) => !UNAVAILABLE_SYMBOLS.has(s) && !STABLECOIN_SYMBOLS.has(s),
    );

    logger.info('Symbol discovery complete', { total: brlSymbols.length });

    // Score each symbol with rate limiting (200ms between API calls)
    const candidates: Omit<AssetCandidate, 'rank'>[] = [];
    for (let i = 0; i < brlSymbols.length; i++) {
      const symbol = brlSymbols[i]!;
      try {
        const candidate = await this.scoreSymbol(symbol, options.windowDays);
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

    // Filter by return floor and volume
    const filtered = candidates.filter(
      (c) => c.rollingReturn >= options.returnFloor && c.avgDailyVolumeBrl >= options.minVolumeBrl,
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
    const currentSymbol = 'HYPE-BRL'; // Placeholder, will be set by caller
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

  private async scoreSymbol(symbol: string, windowDays: number): Promise<Omit<AssetCandidate, 'rank'> | null> {
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
    const firstClose = closes[0]!;
    const lastClose = closes[closes.length - 1]!;
    const rollingReturn = (lastClose - firstClose) / firstClose;

    // Compute average daily BRL volume
    const avgDailyVolumeBrl = candles.reduce((sum, c) => sum + c.close * c.volume, 0) / candles.length;

    // Score: MAD × (1 + rolling_return)
    const score = mad * (1 + rollingReturn);

    const baseAsset = symbol.split('-')[0]!;

    return {
      symbol,
      baseAsset,
      mad,
      rollingReturn,
      avgDailyVolumeBrl,
      score,
      dataPoints: candles.length,
    };
  }
}
