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
import { CoinbaseAdapter } from './adapters/coinbase/adapter';
import { MercadoBitcoinAdapter } from './adapters/mercadobitcoin/adapter';
import { ExchangeAdapter } from './adapters/types';
import { RebalancerBot } from './core/rebalancer';
import { TradeHistoryService } from './core/tracker/history';
import { PnlService } from './core/tracker/pnl';
import { CostBasisService } from './core/tracker/costbasis';
import { TaxService } from './core/tracker/tax';
import { VolatilityService } from './core/tracker/volatility';
import { MetricsService } from './core/tracker/metrics';
import { logger } from './core/tracker/logger';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const report = args.includes('--report');
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  const config = loadConfig(configPath);
  logger.level = config.logLevel;

  // ── Build adapter ──────────────────────────────────────────────────────────
  let adapter: ExchangeAdapter;
  if (config.exchange === 'coinbase') {
    if (!config.coinbase) throw new Error('Coinbase credentials missing in config');
    adapter = new CoinbaseAdapter(config.coinbase, config.dryRun, config.maxSlippageBps);
    logger.info('Using Coinbase Advanced Trade adapter (SOL-USD, Lei 14.754/2023)');
  } else {
    if (!config.mercadobitcoin) throw new Error('Mercado Bitcoin credentials missing in config');
    adapter = new MercadoBitcoinAdapter(
      config.mercadobitcoin,
      config.dryRun,
      config.maxSlippageBps,
    );
    logger.info('Using Mercado Bitcoin adapter (SOL-BRL, Lei 9.250/1995)');
  }

  // ── Build services ─────────────────────────────────────────────────────────
  const history = new TradeHistoryService(
    config.tradeHistoryPath,
    config.portfolioSnapshotsPath,
  );
  const pnl = new PnlService(history);
  const costBasis = new CostBasisService(config.costBasisPath);
  const tax = new TaxService(config.taxEventsPath);
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
