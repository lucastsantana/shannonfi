import Database from 'better-sqlite3';
import { AssetScanner, ScannerAdapter } from './scanner';
import { ScanOptions } from './types';
import { ScanReporter } from '../publishers/scan-reporter';
import { TelegramService } from '../publishers/telegram';

const DEFAULT_SCAN_OPTIONS: Omit<ScanOptions, 'quoteCurrency'> = {
  windowDays: 30,
  minVolumeBrl: 5_000,
  minDataPoints: 10,
  returnFloor: -0.20,
  topN: 15,
  minTrendSlope: -0.0005,
  liquidityFullWeightBrl: 50_000,
};

/**
 * Runs one scan and posts the Telegram report (with approve/reject buttons) — the
 * same sequence scan.ts's CLI runs, extracted so RebalancerBot can trigger an
 * initial scan itself (see `bootstrapViaScan` in config.ts) without duplicating
 * scan.ts's CLI-argument plumbing.
 */
export async function runAssetScan(params: {
  adapter: ScannerAdapter;
  db: Database.Database;
  dbPath: string;
  exchange: string;
  activeSymbol: string;
  telegram: TelegramService | null;
  options?: Partial<ScanOptions>;
  dryRun?: boolean;
}): Promise<void> {
  const { adapter, db, dbPath, exchange, activeSymbol, telegram, dryRun = false } = params;

  const scanner = new AssetScanner(adapter, db, dbPath);
  const options: ScanOptions = {
    ...DEFAULT_SCAN_OPTIONS,
    ...params.options,
    quoteCurrency: activeSymbol.split('-')[1]!,
  };

  const scanResult = await scanner.scan(options);
  scanResult.currentSymbol = activeSymbol;

  const reporter = new ScanReporter(telegram, activeSymbol, db, exchange);
  await reporter.report(scanResult, dryRun);
}
