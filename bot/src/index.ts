/**
 * Shannon's Demon rebalancing bot — unified entry point.
 *
 * Usage:
 *   node dist/index.js                        — run continuously
 *   node dist/index.js --once                 — single cycle and exit
 *   node dist/index.js --report               — print track record and exit
 *   node dist/index.js --config /path/to.yaml — use alternate config file
 */

import { loadConfig } from './config';
import { MercadoBitcoinAdapter } from './adapters/mercadobitcoin/adapter';
import { BinanceAdapter } from './adapters/binance/adapter';
import { CoinbaseAdapter } from './adapters/coinbase/adapter';
import { ExchangeAdapter } from './adapters/types';
import { RebalancerBot } from './core/rebalancer';
import { TradeHistoryService } from './core/tracker/history';
import { PnlService } from './core/tracker/pnl';
import { CostBasisService } from './core/tracker/costbasis';
import { TaxService } from './core/tracker/tax';
import { VolatilityService } from './core/tracker/volatility';
import { MetricsService } from './core/tracker/metrics';
import { logger } from './core/tracker/logger';
import { getDbConfig, setDbConfig, backfillBaseAsset } from './core/tracker/db';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const report = args.includes('--report');
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  const config = loadConfig(configPath);
  logger.level = config.logLevel;

  // The DB, not the YAML file, is the source of truth for "what symbol is this
  // instance trading right now" — it's what asset rotation (approved via the daily
  // scanner's Telegram flow) updates. Falls back to and seeds from the YAML value
  // on first run, exactly like scan.ts already does, so both the PM2 process and the
  // hourly --once GitHub Actions run always agree on the active symbol.
  const activeSymbol = getDbConfig('current_symbol', config.symbol, config.dbPath) ?? config.symbol;
  if (activeSymbol !== config.symbol) {
    logger.info('Active symbol differs from YAML default — using DB-resolved symbol (rotation occurred)', {
      yamlSymbol: config.symbol,
      activeSymbol,
    });
  }
  setDbConfig('current_symbol', activeSymbol, config.dbPath);
  config.symbol = activeSymbol;
  backfillBaseAsset(activeSymbol.split('-')[0]!, config.dbPath);

  const baseAsset = config.symbol.split('-')[0]!;

  // ── Build adapter ──────────────────────────────────────────────────────────
  // Kept as a factory (not just a one-off instance) so RebalancerBot can rebuild a
  // fresh adapter for a new symbol mid-process if an asset rotation is approved,
  // without RebalancerBot needing to import either adapter class itself.
  const buildAdapter = (symbol: string): ExchangeAdapter => {
    if (config.exchange === 'mercadobitcoin') {
      return new MercadoBitcoinAdapter(config.mercadobitcoin, config.dryRun, config.maxSlippageBps, symbol);
    }
    if (config.exchange === 'binance') {
      return new BinanceAdapter(config.binance, config.dryRun, config.maxSlippageBps, symbol);
    }
    return new CoinbaseAdapter(config.coinbase, config.dryRun, config.maxSlippageBps, symbol);
  };

  const adapter = buildAdapter(config.symbol);
  const exchangeLabel =
    config.exchange === 'mercadobitcoin' ? 'Mercado Bitcoin'
    : config.exchange === 'binance' ? 'Binance'
    : 'Coinbase';
  logger.info(`Using ${exchangeLabel} adapter (${config.symbol})`);

  // ── Build services ─────────────────────────────────────────────────────────
  const retentionDays = config.jsonRetentionDays ?? 15;
  const history = new TradeHistoryService(config.dbPath, retentionDays);
  const pnl = new PnlService(history);
  const costBasis = new CostBasisService(config.dbPath, retentionDays, baseAsset);
  const tax = new TaxService(config.dbPath, retentionDays);
  const volatility = new VolatilityService(adapter, config.volatilityWindowDays);
  const metrics = new MetricsService(history);

  // ── --report mode ──────────────────────────────────────────────────────────
  if (report) {
    pnl.printReport();
    metrics.printReport(history.readSnapshots());
    return;
  }

  // ── Build bot ──────────────────────────────────────────────────────────────
  const bot = new RebalancerBot(
    adapter,
    history,
    pnl,
    costBasis,
    tax,
    volatility,
    metrics,
    config,
    buildAdapter,
  );

  if (once) {
    logger.info('Running single cycle (--once)');
    await bot.checkAndRebalance();
    logger.info('Single cycle complete');
    return;
  }

  await bot.start();
}

main().catch((err: unknown) => {
  logger.error('Fatal error', { error: (err as Error).message });
  process.exit(1);
});
