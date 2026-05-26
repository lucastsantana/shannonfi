/**
 * Pre-flight check for the Shannon's Demon bot.
 *
 * Usage:
 *   npm run setup-check
 *
 * Validates config, tests exchange connectivity, and reports balances.
 * Requires a valid shannonfi.config.yaml in the bot/ directory.
 */

import { loadConfig } from '../config';
import { CoinbaseClient } from '../adapters/coinbase/client';
import { CoinbaseEndpoints } from '../adapters/coinbase/endpoints';
import { fetchUsdBrlRate } from '../adapters/coinbase/fx';
import { MbClient } from '../adapters/mercadobitcoin/client';
import { MbEndpoints } from '../adapters/mercadobitcoin/endpoints';

async function checkCoinbase(): Promise<void> {
  const config = loadConfig();
  if (!config.coinbase) throw new Error('coinbase credentials missing in config');
  const { coinbase: cb } = config;

  const client = new CoinbaseClient(
    { apiKeyName: cb.apiKeyName, privateKey: cb.privateKey ?? '' },
    cb.apiBaseUrl,
  );
  const endpoints = new CoinbaseEndpoints(client);

  console.log('\n2. Testing Coinbase API authentication and accounts...');
  const accounts = await endpoints.listAccounts();
  console.log(`   OK — Authenticated. Found ${accounts.accounts.length} accounts`);

  const solAccount = accounts.accounts.find((a) => a.currency === 'SOL' && a.active);
  const usdAccount = accounts.accounts.find((a) => a.currency === 'USD' && a.active);

  if (!solAccount) { console.error('   FAIL — No active SOL account found'); process.exit(1); }
  if (!usdAccount) { console.error('   FAIL — No active USD account found'); process.exit(1); }

  const usdBalance = parseFloat(usdAccount.available_balance.value);
  const solBalance = parseFloat(solAccount.available_balance.value);
  console.log(`   SOL balance: ${solBalance.toFixed(6)} SOL`);
  console.log(`   USD balance: $${usdBalance.toFixed(2)}`);

  console.log('\n3. Fetching USD/BRL rate...');
  const rate = await fetchUsdBrlRate(cb.fxApiUrl);
  if (!rate) { console.error('   FAIL — Cannot fetch USD/BRL rate'); process.exit(1); }
  console.log(`   OK — USD/BRL: ${rate.toFixed(4)}`);

  const totalBrl = (usdBalance + solBalance * 0) * rate; // approx
  if (totalBrl < config.minPortfolioValueBrl) {
    console.warn(`   WARN — Portfolio may be below minPortfolioValueBrl (R$${config.minPortfolioValueBrl})`);
  }

  console.log('\n4. Checking SOL-USD market...');
  const bbAsk = await endpoints.getBestBidAsk();
  const pricebook = bbAsk.pricebooks[0];
  if (!pricebook || pricebook.bids.length === 0) {
    console.error('   FAIL — SOL-USD pricebook empty'); process.exit(1);
  }
  const bid = parseFloat(pricebook.bids[0]!.price);
  const ask = parseFloat(pricebook.asks[0]!.price);
  const mid = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / mid) * 10_000;
  console.log(`   OK — SOL/USD mid: $${mid.toFixed(4)}  (SOL/BRL: R$${(mid * rate).toFixed(2)})  spread: ${spreadBps.toFixed(1)} bps`);

  console.log('\n5. Checking historical candles access...');
  const end = Math.floor(Date.now() / 1000);
  const start = end - 7 * 86_400;
  const candles = await endpoints.getCandles(start, end, 'ONE_DAY');
  console.log(`   OK — ${candles.candles.length} daily candles available for the past 7 days`);
}

async function checkMercadoBitcoin(): Promise<void> {
  const config = loadConfig();
  if (!config.mercadobitcoin) throw new Error('mercadobitcoin credentials missing in config');
  const { mercadobitcoin: mb } = config;

  const client = new MbClient(mb.clientId, mb.clientSecret, mb.apiBaseUrl);
  const endpoints = new MbEndpoints(client);

  console.log('\n2. Testing Mercado Bitcoin API authentication...');
  const accountId = await endpoints.getAccountId();
  console.log(`   OK — Authenticated. Account ID: ${accountId}`);

  console.log('\n3. Fetching balances...');
  const balances = await endpoints.getBalances(accountId);
  const solBalance = parseFloat(balances.find((b) => b.symbol === 'SOL')?.available ?? '0');
  const brlBalance = parseFloat(balances.find((b) => b.symbol === 'BRL')?.available ?? '0');
  console.log(`   SOL balance: ${solBalance.toFixed(6)} SOL`);
  console.log(`   BRL balance: R$${brlBalance.toFixed(2)}`);

  if (brlBalance + solBalance === 0) {
    console.warn('   WARN — All balances are zero');
  }

  console.log('\n4. Checking SOL-BRL market (recent candles)...');
  const candles = await endpoints.getCandles(7, '1d');
  const lastClose = candles.c[candles.c.length - 1];
  if (!lastClose) { console.error('   FAIL — No candle data returned'); process.exit(1); }
  console.log(`   OK — ${candles.t.length} daily candles. Latest close: R$${parseFloat(lastClose).toFixed(2)}/SOL`);

  const totalBrl = brlBalance + solBalance * parseFloat(lastClose);
  if (totalBrl < loadConfig().minPortfolioValueBrl) {
    console.warn(`   WARN — Total portfolio R$${totalBrl.toFixed(2)} is below minPortfolioValueBrl (R$${loadConfig().minPortfolioValueBrl})`);
  }
}

async function runSetupCheck(): Promise<void> {
  console.log("=== Shannon's Demon — Setup Check ===\n");

  console.log('1. Loading and validating configuration...');
  const config = loadConfig();
  console.log('   OK — Config loaded');
  console.log(`   Exchange:   ${config.exchange}`);
  console.log(`   Dry Run:    ${config.dryRun}`);
  console.log(`   Threshold:  ${config.rebalanceThresholdBps} bps (${config.rebalanceThresholdBps / 100}%)`);
  console.log(`   Adaptive:   ${config.useAdaptiveThreshold}`);
  console.log(`   Log Level:  ${config.logLevel}`);

  if (config.exchange === 'coinbase') {
    await checkCoinbase();
  } else {
    await checkMercadoBitcoin();
  }

  console.log('\n✓ All checks passed. The bot is ready to run.');
  console.log('\nDry-run single cycle:');
  console.log('  npm run dev:once   (or: node dist/index.js --once with dryRun: true in config)');
  console.log('\nLive single cycle:');
  console.log('  node dist/index.js --once');
  console.log('\nContinuous loop:');
  console.log('  node dist/index.js\n');
}

runSetupCheck().catch((err) => {
  console.error('Setup check failed:', (err as Error).message);
  process.exit(1);
});
