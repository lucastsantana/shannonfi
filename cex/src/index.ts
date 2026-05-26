import { loadConfig } from './config';
import { CoinbaseClient } from './coinbase/client';
import { CoinbaseEndpoints } from './coinbase/endpoints';
import { PortfolioService } from './bot/portfolio';
import { TraderService } from './bot/trader';
import { RebalancerBot } from './bot/rebalancer';
import { TradeHistoryService } from './tracker/history';
import { PnlService } from './tracker/pnl';
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
  const history = new TradeHistoryService(config.tradeHistoryPath);
  const pnl = new PnlService(history);
  const bot = new RebalancerBot(portfolio, trader, history, pnl, config);

  if (onceMode) {
    logger.info('Running single rebalance check (--once mode)');
    await bot.checkAndRebalance();
    pnl.printReport();
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
