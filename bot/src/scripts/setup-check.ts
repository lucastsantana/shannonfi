/**
 * Pre-flight check for the Shannon's Demon bot.
 *
 * Usage:
 *   npm run setup-check
 *
 * Validates config, tests Mercado Bitcoin connectivity, and reports balances.
 * Reads credentials from GNOME Keyring (same as start.sh).
 */

import { loadConfig } from '../config';
import { MbClient } from '../adapters/mercadobitcoin/client';
import { MbEndpoints } from '../adapters/mercadobitcoin/endpoints';
import { BinanceClient } from '../adapters/binance/client';
import { BinanceEndpoints } from '../adapters/binance/endpoints';
import { execSync } from 'child_process';

function getMbCredentialsFromKeyring(): { clientId: string; clientSecret: string } {
  try {
    const clientId = execSync('secret-tool lookup service mercadobitcoin key clientId 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const clientSecret = execSync('secret-tool lookup service mercadobitcoin key clientSecret 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!clientId || !clientSecret) {
      throw new Error('Credentials not found in keyring');
    }

    return { clientId, clientSecret };
  } catch {
    throw new Error(
      'MB credentials not found in GNOME Keyring.\n' +
      'Store them with:\n' +
      '  secret-tool store service mercadobitcoin key clientId\n' +
      '  secret-tool store service mercadobitcoin key clientSecret',
    );
  }
}

function getBinanceCredentialsFromKeyring(): { apiKey: string; apiSecret: string } {
  try {
    const apiKey = execSync('secret-tool lookup service binance key apiKey 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const apiSecret = execSync('secret-tool lookup service binance key apiSecret 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (!apiKey || !apiSecret) {
      throw new Error('Credentials not found in keyring');
    }

    return { apiKey, apiSecret };
  } catch {
    throw new Error(
      'Binance credentials not found in GNOME Keyring.\n' +
      'Store them with:\n' +
      '  secret-tool store service binance key apiKey\n' +
      '  secret-tool store service binance key apiSecret',
    );
  }
}

async function checkMercadoBitcoin(): Promise<void> {
  const config = loadConfig();
  if (config.exchange !== 'mercadobitcoin') return;

  const { clientId, clientSecret } = getMbCredentialsFromKeyring();
  const apiBaseUrl = config.mercadobitcoin.apiBaseUrl;

  const client = new MbClient(clientId, clientSecret, apiBaseUrl);
  const endpoints = new MbEndpoints(client, config.symbol);

  console.log('\n2. Testing Mercado Bitcoin API authentication...');
  const accountId = await endpoints.getAccountId();
  console.log(`   OK — Authenticated. Account ID: ${accountId}`);

  const baseAsset = config.symbol.split('-')[0]!;

  console.log('\n3. Fetching balances...');
  const balances = await endpoints.getBalances(accountId);
  const baseBalance = parseFloat(balances.find((b) => b.symbol === baseAsset)?.available ?? '0');
  const brlBalance = parseFloat(balances.find((b) => b.symbol === 'BRL')?.available ?? '0');
  console.log(`   ${baseAsset} balance: ${baseBalance.toFixed(6)} ${baseAsset}`);
  console.log(`   BRL balance: R$${brlBalance.toFixed(2)}`);

  if (brlBalance + baseBalance === 0) {
    console.warn('   WARN — All balances are zero');
  }

  console.log(`\n4. Checking ${config.symbol} market (recent candles)...`);
  const candles = await endpoints.getCandles(7, '1d');
  const lastClose = candles.c[candles.c.length - 1];
  if (!lastClose) { console.error('   FAIL — No candle data returned'); process.exit(1); }
  console.log(`   OK — ${candles.t.length} daily candles. Latest close: R$${parseFloat(lastClose).toFixed(2)}/${baseAsset}`);

  const totalBrl = brlBalance + baseBalance * parseFloat(lastClose);
  if (totalBrl < loadConfig().minPortfolioValueBrl) {
    console.warn(`   WARN — Total portfolio R$${totalBrl.toFixed(2)} is below minPortfolioValueBrl (R$${loadConfig().minPortfolioValueBrl})`);
  }
}

async function checkBinance(): Promise<void> {
  const config = loadConfig();
  if (config.exchange !== 'binance') return;

  const { apiKey, apiSecret } = getBinanceCredentialsFromKeyring();
  const apiBaseUrl = config.binance.apiBaseUrl;

  const client = new BinanceClient(apiKey, apiSecret, apiBaseUrl);
  const endpoints = new BinanceEndpoints(client);

  console.log('\n2. Testing Binance API authentication...');
  const account = await endpoints.getAccount();
  console.log(`   OK — Authenticated. Account Type: ${account.accountType}`);

  const baseAsset = config.symbol.split('-')[0]!;

  console.log('\n3. Fetching balances...');
  const baseBalance = parseFloat(account.balances.find((b) => b.asset === baseAsset)?.free ?? '0');
  const brlBalance = parseFloat(account.balances.find((b) => b.asset === 'BRL')?.free ?? '0');
  console.log(`   ${baseAsset} balance: ${baseBalance.toFixed(6)} ${baseAsset}`);
  console.log(`   BRL balance: R$${brlBalance.toFixed(2)}`);

  if (brlBalance + baseBalance === 0) {
    console.warn('   WARN — All balances are zero');
  }

  console.log(`\n4. Checking ${config.symbol} market (recent candles)...`);
  const binanceSymbol = config.symbol.replace('-', '');
  const klines = await endpoints.getKlines(binanceSymbol, '1d', 7);
  const lastClose = parseFloat(klines[klines.length - 1]?.[4] ?? '0');
  if (lastClose === 0) { console.error('   FAIL — No candle data returned'); process.exit(1); }
  console.log(`   OK — ${klines.length} daily candles. Latest close: R$${lastClose.toFixed(2)}/${baseAsset}`);

  const totalBrl = brlBalance + baseBalance * lastClose;
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

  if (config.exchange === 'mercadobitcoin') {
    await checkMercadoBitcoin();
  } else {
    await checkBinance();
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
