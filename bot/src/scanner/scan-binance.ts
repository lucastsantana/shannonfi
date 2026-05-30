#!/usr/bin/env ts-node
/**
 * Binance asset scanner CLI
 * Usage: npm run scan:binance -- --config <path> [options]
 *
 * Scans all BRL-paired assets on Binance, scores by Shannon premium,
 * and sends daily report to Telegram.
 *
 * Flags:
 *   --config <path>      required | path to binance config YAML
 *   --window <days>      optional | default 30 (analysis window)
 *   --min-volume <brl>   optional | default 5000 (minimum ADTV filter)
 *   --top <n>           optional | default 15 (display top N)
 *   --dry-run           optional | don't send Telegram (console only)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../core/tracker/logger';
import { BinanceAdapter } from '../adapters/binance/adapter';
import { TelegramService } from '../core/notifier/telegram';
import { AssetScanner } from './scanner';
import { ScanReporter } from './reporter';
import { getDb } from '../core/tracker/db';
import { BinanceConfig, loadConfig as loadConfigFile } from '../config';

interface ScanArgs {
  config: string;
  window: number;
  minVolume: number;
  top: number;
  dryRun: boolean;
}

function parseArgs(): ScanArgs {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      const key = args[i]!.substring(2);
      if (i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
        opts[key] = args[i + 1]!;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }

  return {
    config: (opts.config as string) || './shannonfi.config.yaml',
    window: parseInt((opts.window as string) || '30', 10),
    minVolume: parseInt((opts['min-volume'] as string) || '5000', 10),
    top: parseInt((opts.top as string) || '15', 10),
    dryRun: !!opts['dry-run'],
  };
}

async function main() {
  try {
    const args = parseArgs();
    logger.info('Asset Scanner CLI starting');

    const configPath = resolve(args.config);
    const config = loadConfigFile(configPath);

    if (config.exchange !== 'binance') {
      throw new Error(`Config specifies exchange '${config.exchange}', expected 'binance'`);
    }

    const binanceConfig = config.binance as BinanceConfig;
    if (!binanceConfig) {
      throw new Error('No binance config found in config file');
    }

    // Initialize database
    const dbPath = './data/binance/shannonfi.db';
    const db = getDb(dbPath);

    // Create adapter
    const symbol = config.symbol || 'SOL-BRL';
    const dryRun = config.dryRun || args.dryRun;
    const maxSlippageBps = config.maxSlippageBps || 100;
    const adapter = new BinanceAdapter(binanceConfig, dryRun, maxSlippageBps, symbol);

    // Create scanner
    const scanner = new AssetScanner(adapter, db, dbPath);

    // Run scan
    const scanResult = await scanner.scan({
      windowDays: args.window,
      minVolumeBrl: args.minVolume,
      minDataPoints: 10,
      returnFloor: -0.20,
      topN: args.top,
    });

    // Report
    const telegram = config.telegram ? new TelegramService(config.telegram) : null;
    const reporter = new ScanReporter(telegram, symbol, db);
    await reporter.report(scanResult, args.dryRun);
  } catch (err) {
    logger.error('Scanner failed', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  }
}

main();
