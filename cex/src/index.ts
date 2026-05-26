import { loadConfig } from './config';
import { CoinbaseClient } from './coinbase/client';
import { CoinbaseEndpoints } from './coinbase/endpoints';
import { PortfolioService } from './bot/portfolio';
import { TraderService } from './bot/trader';
import { RebalancerBot } from './bot/rebalancer';
import { TradeHistoryService } from './tracker/history';
import { PnlService } from './tracker/pnl';
import { CostBasisService } from './tracker/costbasis';
import { TaxService } from './tracker/tax';
import { VolatilityService } from './tracker/volatility';
import { MetricsService } from './tracker/metrics';
import { logger } from './tracker/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const onceMode = process.argv.includes('--once');

  const coinbaseClient = new CoinbaseClient(
    {
      apiKeyName: config.coinbaseApiKeyName,
      privateKey: config.coinbasePrivateKey,
    },
    config.coinbaseApiBaseUrl,
  );
  const endpoints = new CoinbaseEndpoints(coinbaseClient);
  const portfolio = new PortfolioService(endpoints);
  const trader = new TraderService(endpoints, config);
  const history = new TradeHistoryService(
    config.tradeHistoryPath,
    config.portfolioSnapshotsPath,
  );
  const pnl = new PnlService(history);
  const costBasis = new CostBasisService(config.costBasisPath);
  const tax = new TaxService(config.taxEventsPath);
  const volatility = new VolatilityService(endpoints, config.volatilityWindowDays);
  const metrics = new MetricsService(history);

  const bot = new RebalancerBot(
    portfolio,
    trader,
    history,
    pnl,
    costBasis,
    tax,
    volatility,
    metrics,
    config,
  );

  if (onceMode) {
    logger.info('Running single rebalance check (--once mode)');
    await bot.checkAndRebalance();
    pnl.printReport();
    metrics.printReport(history.readSnapshots());
    process.exit(0);
  } else {
    await bot.start();
  }
}

main().catch((err) => {
  logger.error('Fatal error', {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
