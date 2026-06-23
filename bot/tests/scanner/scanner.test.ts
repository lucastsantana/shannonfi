import { describe, it, expect } from 'vitest';
import { AssetScanner, ScannerAdapter } from '../../src/scanner/scanner';
import { ScanOptions } from '../../src/scanner/types';
import { getDb, closeDb } from '../../src/core/tracker/db';

function uniqueMemDbPath(): string {
  return `:memory:?mode=memory&cache=shared&hash=${Math.random()}`;
}

const BASE_OPTIONS: ScanOptions = {
  windowDays: 10,
  minVolumeBrl: 1_000,
  minDataPoints: 5,
  returnFloor: -0.20,
  topN: 15,
  minTrendSlope: -0.0005,
  liquidityFullWeightBrl: 50_000,
  quoteCurrency: 'BRL',
};

// 11 flat daily closes (10 returns) at the given price, with volume sized so
// `close * volume` (avgDailyVolumeBrl's actual formula) lands on dailyVolumeBrl —
// a clean "no trend, no volatility" series. Tests override specific symbols to
// inject trend, volatility, or liquidity deviations from this baseline.
function flatCandles(price: number, dailyVolumeBrl: number, count = 11) {
  return Array.from({ length: count }, (_, i) => ({ close: price, volume: dailyVolumeBrl / price, timestamp: i }));
}

function uptrendingCandles(start: number, dailyIncrement: number, dailyVolumeBrl: number, count = 11) {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * dailyIncrement;
    return { close, volume: dailyVolumeBrl / close, timestamp: i };
  });
}

function downtrendingCandles(start: number, dailyDecrement: number, dailyVolumeBrl: number, count = 11) {
  return Array.from({ length: count }, (_, i) => {
    const close = start - i * dailyDecrement;
    return { close, volume: dailyVolumeBrl / close, timestamp: i };
  });
}

function makeAdapter(bySymbol: Record<string, ReturnType<typeof flatCandles>>): ScannerAdapter {
  return {
    getCandlesWithVolume: async (symbol: string) => bySymbol[symbol] ?? [],
  };
}

describe('AssetScanner', () => {
  it('rejects a clearly downtrending candidate even with strong volatility', async () => {
    const dbPath = uniqueMemDbPath();
    const db = getDb(dbPath);
    const adapter = makeAdapter({
      'BTC-BRL': downtrendingCandles(100, 5, 100_000), // strong downtrend, well below minTrendSlope
      'ETH-BRL': flatCandles(100, 100_000),
    });
    const scanner = new AssetScanner(adapter, db, dbPath);

    const result = await scanner.scan(BASE_OPTIONS);

    expect(result.candidates.find((c) => c.baseAsset === 'BTC')).toBeUndefined();
    closeDb();
  });

  it('accepts a sideways or uptrending candidate', async () => {
    const dbPath = uniqueMemDbPath();
    const db = getDb(dbPath);
    const adapter = makeAdapter({
      'BTC-BRL': uptrendingCandles(100, 1, 100_000),
      'ETH-BRL': flatCandles(100, 100_000),
    });
    const scanner = new AssetScanner(adapter, db, dbPath);

    const result = await scanner.scan(BASE_OPTIONS);

    expect(result.candidates.find((c) => c.baseAsset === 'BTC')).toBeDefined();
    expect(result.candidates.find((c) => c.baseAsset === 'ETH')).toBeDefined();
    closeDb();
  });

  it('dampens the score for thin liquidity even above the hard minVolumeBrl floor', async () => {
    const dbPath = uniqueMemDbPath();
    const db = getDb(dbPath);
    // Identical price action, only volume differs — isolates the liquidity weight's effect.
    const adapter = makeAdapter({
      'BTC-BRL': uptrendingCandles(100, 1, 5_000), // above the 1_000 floor, well below the 50_000 saturation point
      'ETH-BRL': uptrendingCandles(100, 1, 100_000), // fully liquid
    });
    const scanner = new AssetScanner(adapter, db, dbPath);

    const result = await scanner.scan(BASE_OPTIONS);
    const btc = result.candidates.find((c) => c.baseAsset === 'BTC')!;
    const eth = result.candidates.find((c) => c.baseAsset === 'ETH')!;

    expect(btc.liquidityWeight).toBeCloseTo(5_000 / 50_000, 5);
    expect(eth.liquidityWeight).toBe(1);
    expect(btc.score).toBeLessThan(eth.score); // same mad/return, only liquidity differs
    closeDb();
  });

  it('never lets liquidity weight exceed 1.0 for extremely high volume', async () => {
    const dbPath = uniqueMemDbPath();
    const db = getDb(dbPath);
    const adapter = makeAdapter({ 'BTC-BRL': uptrendingCandles(100, 1, 10_000_000) });
    const scanner = new AssetScanner(adapter, db, dbPath);

    const result = await scanner.scan(BASE_OPTIONS);
    expect(result.candidates.find((c) => c.baseAsset === 'BTC')!.liquidityWeight).toBe(1);
    closeDb();
  });

  it('still applies the existing volume floor as a hard filter', async () => {
    const dbPath = uniqueMemDbPath();
    const db = getDb(dbPath);
    const adapter = makeAdapter({ 'BTC-BRL': uptrendingCandles(100, 1, 100) }); // below minVolumeBrl: 1_000
    const scanner = new AssetScanner(adapter, db, dbPath);

    const result = await scanner.scan(BASE_OPTIONS);
    expect(result.candidates.find((c) => c.baseAsset === 'BTC')).toBeUndefined();
    closeDb();
  });
});
