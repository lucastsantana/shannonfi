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

  const baseAsset = config.symbol.split('-')[0]!;

  // ── Build adapter ──────────────────────────────────────────────────────────
  const adapter: ExchangeAdapter = new MercadoBitcoinAdapter(
    config.mercadobitcoin,
    config.dryRun,
    config.maxSlippageBps,
    config.symbol,
  );
  logger.info(`Using Mercado Bitcoin adapter (${config.symbol}, Lei 9.250/1995)`);

  // ── Build services ─────────────────────────────────────────────────────────
  const history = new TradeHistoryService(config.dbPath);
  const pnl = new PnlService(history);
  const costBasis = new CostBasisService(config.dbPath, baseAsset);
  const tax = new TaxService(config.dbPath);
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
