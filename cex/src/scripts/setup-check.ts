import { loadConfig } from '../config';
import { CoinbaseClient } from '../coinbase/client';
import { CoinbaseEndpoints } from '../coinbase/endpoints';

async function runSetupCheck(): Promise<void> {
  console.log("=== Shannon's Demon CEX — Setup Check ===\n");

  // 1. Config validation
  console.log('1. Loading and validating configuration...');
  let config;
  try {
    config = loadConfig();
    console.log('   OK — Config loaded');
    console.log(`   API Key: ${config.coinbaseApiKeyName}`);
    console.log(`   Dry Run: ${config.dryRun}`);
    console.log(`   Threshold: ${config.rebalanceThresholdBps} bps (${config.rebalanceThresholdBps / 100}%)`);
    console.log(`   Poll Interval: ${config.pollIntervalSeconds}s`);
    console.log(`   Min Rebalance Interval: ${config.minRebalanceIntervalSeconds}s\n`);
  } catch (e) {
    console.error('   FAIL — Config error:', (e as Error).message);
    process.exit(1);
  }

  const client = new CoinbaseClient(
    { apiKeyName: config.coinbaseApiKeyName, privateKey: config.coinbasePrivateKey },
    config.coinbaseApiBaseUrl,
  );
  const endpoints = new CoinbaseEndpoints(client);

  // 2. Authentication & account check
  console.log('2. Testing API authentication and accounts...');
  try {
    const accounts = await endpoints.listAccounts();
    console.log(`   OK — Authenticated. Found ${accounts.accounts.length} accounts`);

    const solAccount = accounts.accounts.find((a) => a.currency === 'SOL' && a.active);
    const usdAccount = accounts.accounts.find((a) => a.currency === 'USD' && a.active);

    if (!solAccount) {
      console.error('   FAIL — No active SOL account found');
      process.exit(1);
    }
    if (!usdAccount) {
      console.error('   FAIL — No active USD account found');
      process.exit(1);
    }

    console.log(`   SOL balance: ${parseFloat(solAccount.available_balance.value).toFixed(6)} SOL`);
    console.log(`   USD balance: $${parseFloat(usdAccount.available_balance.value).toFixed(2)}\n`);

    const totalUsd =
      parseFloat(usdAccount.available_balance.value);
    if (totalUsd < config.minPortfolioValueUsd) {
      console.warn(
        `   WARN — USD balance $${totalUsd.toFixed(2)} is below minPortfolioValueUsd ($${config.minPortfolioValueUsd}). Bot will skip rebalances.`,
      );
    }
  } catch (e) {
    console.error('   FAIL — Auth error:', (e as Error).message);
    process.exit(1);
  }

  // 3. SOL-USD market availability
  console.log('3. Checking SOL-USD market...');
  try {
    const bbAsk = await endpoints.getBestBidAsk();
    const pricebook = bbAsk.pricebooks.find((p) => p.product_id === 'SOL-USD');
    if (!pricebook || pricebook.bids.length === 0 || pricebook.asks.length === 0) {
      throw new Error('SOL-USD pricebook empty or missing');
    }
    const bid = parseFloat(pricebook.bids[0]!.price);
    const ask = parseFloat(pricebook.asks[0]!.price);
    const mid = (bid + ask) / 2;
    const spreadBps = ((ask - bid) / mid) * 10_000;
    console.log(`   OK — SOL-USD trading`);
    console.log(`   Bid: $${bid.toFixed(4)}, Ask: $${ask.toFixed(4)}, Mid: $${mid.toFixed(4)}`);
    console.log(`   Spread: ${spreadBps.toFixed(1)} bps\n`);
  } catch (e) {
    console.error('   FAIL — SOL-USD unavailable:', (e as Error).message);
    process.exit(1);
  }

  // 4. Historical candles (backtest prerequisite)
  console.log('4. Checking historical candles access...');
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 7 * 24 * 3600;
    const candles = await endpoints.getCandles(start, end, 'ONE_DAY');
    console.log(`   OK — ${candles.candles.length} daily candles available for the past 7 days\n`);
  } catch (e) {
    console.error('   FAIL — Candles error:', (e as Error).message);
    process.exit(1);
  }

  console.log('All checks passed. The bot is ready to run.');
  console.log('\nTo start in dry-run mode:');
  console.log('  DRY_RUN=true node dist/index.js --once');
  console.log('\nTo start for real:');
  console.log('  node dist/index.js --once   (single check)');
  console.log('  node dist/index.js          (continuous loop)\n');
}

runSetupCheck().catch((err) => {
  console.error('Setup check failed:', (err as Error).message);
  process.exit(1);
});
