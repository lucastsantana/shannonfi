#!/usr/bin/env node
/**
 * Unified asset scanner CLI for Shannon's Demon bot.
 * Works with Mercado Bitcoin and Binance exchanges.
 *
 * Usage:
 *   # Mercado Bitcoin
 *   npm run scan -- --config configs/hype-mb.yaml
 *   npm run scan -- --config configs/hype-mb.yaml --window 30 --min-volume 5000
 *
 *   # Binance
 *   npm run scan -- --config configs/btc-binance.yaml
 *   npm run scan -- --config configs/btc-binance.yaml --window 60 --top 20
 */

import path from 'path';
import { loadConfig } from '../config';
import { getDb, getDbConfig, setDbConfig, backfillBaseAsset } from '../core/tracker/db';
import { MercadoBitcoinAdapter } from '../adapters/mercadobitcoin/adapter';
import { BinanceAdapter } from '../adapters/binance/adapter';
import { CoinbaseAdapter } from '../adapters/coinbase/adapter';
import { TelegramService } from '../publishers/telegram';
import { AssetScanner } from './scanner';
import { ScanReporter } from '../publishers/scan-reporter';
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

  // The DB, not the YAML file, is the source of truth for "what symbol is this instance
  // trading right now" once asset rotation is in play — seed it from YAML on first run,
  // then always prefer the DB value (same resolution index.ts uses) so the scanner's own
  // adapter/reporting never drifts back to a stale YAML symbol after a rotation.
  const activeSymbol = getDbConfig('current_symbol', config.symbol, dbPath) ?? config.symbol;
  setDbConfig('current_symbol', activeSymbol, dbPath);
  backfillBaseAsset(activeSymbol.split('-')[0]!, dbPath);

  // Set up adapter based on exchange type
  let adapter: any;
  try {
    if (config.exchange === 'mercadobitcoin') {
      adapter = new MercadoBitcoinAdapter(
        config.mercadobitcoin || {},
        config.dryRun || false,
        config.maxSlippageBps || 100,
        activeSymbol,
      );
      logger.info('Initialized Mercado Bitcoin adapter');
    } else if (config.exchange === 'binance') {
      adapter = new BinanceAdapter(
        config.binance || {},
        config.dryRun || false,
        config.maxSlippageBps || 100,
        activeSymbol,
      );
      logger.info('Initialized Binance adapter');
    } else if (config.exchange === 'coinbase') {
      adapter = new CoinbaseAdapter(
        config.coinbase || {},
        config.dryRun || false,
        config.maxSlippageBps || 100,
        activeSymbol,
      );
      logger.info('Initialized Coinbase adapter');
    } else {
      throw new Error(`Unsupported exchange: ${config.exchange}. Supported: mercadobitcoin, binance, coinbase`);
    }
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
    try {
    // Set up reporter
    const reporter = new ScanReporter(telegram, activeSymbol, db, config.exchange);

    if (cliArgs.reloadScan !== undefined) {
      // Replay a cached scan
      logger.info('Reloading cached scan', { scanId: cliArgs.reloadScan });
      await reporter.reportCached(cliArgs.reloadScan, cliArgs.dryRun);
    } else {
      // Run a new scan
      const scanner = new AssetScanner(adapter, db, dbPath);
      const options: ScanOptions = {
        windowDays: cliArgs.window,
        minVolumeBrl: cliArgs.minVolume,
        minDataPoints: cliArgs.minDataPoints,
        returnFloor: cliArgs.returnFloor,
        topN: cliArgs.top,
        quoteCurrency: activeSymbol.split('-')[1]!,
      };

      const scanResult = await scanner.scan(options);
      scanResult.currentSymbol = activeSymbol;
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
