#!/usr/bin/env node
/**
 * Asset scanner CLI for Shannon's Demon bot.
 * Usage:
 *   npm run scan -- --config configs/hype-mb.yaml
 *   npm run scan -- --config configs/hype-mb.yaml --window 30 --min-volume 5000
 *   npm run scan -- --config configs/hype-mb.yaml --reload-scan 5
 */

import path from 'path';
import { loadConfig } from '../config';
import { getDb, getDbConfig, setDbConfig } from '../core/tracker/db';
import { MercadoBitcoinAdapter } from '../adapters/mercadobitcoin/adapter';
import { TelegramService } from '../core/notifier/telegram';
import { AssetScanner } from './scanner';
import { ScanReporter } from './reporter';
import { ScanOptions } from './types';
import { logger } from '../core/tracker/logger';

interface CliArgs {
  config: string;
  window: number;
  minVolume: number;
  minDataPoints: number;
  returnFloor: number;
  top: number;
  reloadScan?: number;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: any = {
    config: undefined,
    window: 30,
    minVolume: 5_000,
    minDataPoints: 10,
    returnFloor: -0.20,
    top: 15,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--config') {
      result.config = args[++i] || undefined;
    } else if (arg === '--window') {
      result.window = parseInt(args[++i] || '30', 10);
    } else if (arg === '--min-volume') {
      result.minVolume = parseFloat(args[++i] || '5000');
    } else if (arg === '--min-data-points') {
      result.minDataPoints = parseInt(args[++i] || '10', 10);
    } else if (arg === '--return-floor') {
      result.returnFloor = parseFloat(args[++i] || '-0.20');
    } else if (arg === '--top') {
      result.top = parseInt(args[++i] || '15', 10);
    } else if (arg === '--reload-scan') {
      result.reloadScan = parseInt(args[++i] || '0', 10);
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    }
  }

  if (!result.config) {
    throw new Error('--config is required');
  }

  return result as CliArgs;
}

async function main(): Promise<void> {
  const cliArgs = parseArgs();
  logger.info('Asset Scanner CLI starting', { config: cliArgs.config });

  // Load config
  const configPath = path.resolve(cliArgs.config);
  let config: any;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    logger.error('Failed to load config', { error: (err as Error).message });
    process.exit(1);
  }

  // Open database with the config path
  // Important: use config.dbPath to ensure we use the right database for this instance
  const dbPath = config.dbPath || './data/shannonfi.db';
  const db = getDb(dbPath);

  // Initialize config table with current symbol if not set
  const currentSymbol = getDbConfig('current_symbol');
  if (!currentSymbol) {
    setDbConfig('current_symbol', config.symbol);
    logger.info('Initialized config with symbol', { symbol: config.symbol });
  }

  // Set up MB adapter (assume Mercado Bitcoin for scanner)
  if (config.exchange !== 'mercadobitcoin') {
    logger.error('Scanner only supports Mercado Bitcoin currently');
    process.exit(1);
  }

  let mbAdapter: MercadoBitcoinAdapter;
  try {
    mbAdapter = new MercadoBitcoinAdapter(
      config.mercadobitcoin || {},
      config.dryRun || false,
      config.maxSlippageBps || 100,
      config.symbol || 'SOL-BRL',
    );
  } catch (err) {
    logger.error('Failed to initialize adapter', { error: (err as Error).message });
    process.exit(1);
  }

  // Set up Telegram if configured
  // Note: defer Telegram setup until after database is initialized to avoid path switching
  let telegram: TelegramService | null = null;
  if (config.telegram) {
    try {
      // Create Telegram service with config directly (skip loading config again)
      telegram = new TelegramService(config.telegram);
      logger.info('Telegram notifications enabled');
    } catch (err) {
      logger.warn('Telegram setup failed, continuing without notifications', {
        error: (err as Error).message,
      });
      telegram = null;
    }
  }

  try {
    // Get current symbol from DB
    const activeSymbol = getDbConfig('current_symbol', config.symbol);

    try {
    // Set up reporter
    const reporter = new ScanReporter(telegram, activeSymbol!, db);

    if (cliArgs.reloadScan !== undefined) {
      // Replay a cached scan
      logger.info('Reloading cached scan', { scanId: cliArgs.reloadScan });
      await reporter.reportCached(cliArgs.reloadScan, cliArgs.dryRun);
    } else {
      // Run a new scan
      const scanner = new AssetScanner(mbAdapter, db, dbPath);
      const options: ScanOptions = {
        windowDays: cliArgs.window,
        minVolumeBrl: cliArgs.minVolume,
        minDataPoints: cliArgs.minDataPoints,
        returnFloor: cliArgs.returnFloor,
        topN: cliArgs.top,
      };

      const scanResult = await scanner.scan(options);
      scanResult.currentSymbol = activeSymbol!;
      await reporter.report(scanResult, cliArgs.dryRun);
    }
  } catch (err) {
    throw err;
  } finally {
    // Ensure database stays open until we're done
  }

    logger.info('Scanner completed successfully');
  } catch (err) {
    logger.error('Scanner failed', { error: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error('Unexpected error', { error: err.message, stack: err.stack });
  process.exit(1);
});
