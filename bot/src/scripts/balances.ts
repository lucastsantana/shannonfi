#!/usr/bin/env node
/**
 * Balances: lists every account visible to the configured exchange credentials
 * with a nonzero balance. Useful for checking what's actually funded before
 * running a dry-run or live cycle — setup-check only checks the configured
 * instance's base/quote pair, not the full account list.
 *
 * Usage:
 *   npm run balances -- --config configs/coinbase-shannon-1.yaml
 */

import { loadConfig } from '../config';
import { getCoinbaseCredentials } from '../core/keyring';
import { CoinbaseClient } from '../adapters/coinbase/client';
import { CoinbaseEndpoints } from '../adapters/coinbase/endpoints';
import { logger } from '../core/tracker/logger';

async function checkCoinbaseBalances(symbol: string): Promise<void> {
  const creds = await getCoinbaseCredentials();
  const client = new CoinbaseClient(creds.keyName, creds.privateKeyPem);
  const endpoints = new CoinbaseEndpoints(client, symbol);

  let cursor: string | undefined;
  const nonzero: { currency: string; available: string; hold: string }[] = [];
  let total = 0;

  do {
    const resp = await endpoints.getAccounts(cursor);
    total += resp.accounts.length;
    for (const account of resp.accounts) {
      const available = parseFloat(account.available_balance.value);
      const hold = parseFloat(account.hold?.value ?? '0');
      if (available > 0 || hold > 0) {
        nonzero.push({ currency: account.currency, available: account.available_balance.value, hold: account.hold?.value ?? '0' });
      }
    }
    cursor = resp.has_next ? resp.cursor : undefined;
  } while (cursor);

  if (nonzero.length === 0) {
    console.log(`Checked ${total} account(s) — all balances are zero.`);
    return;
  }

  console.log(`Found ${nonzero.length} account(s) with a nonzero balance (of ${total} total):`);
  for (const a of nonzero) {
    console.log(`  ${a.currency}: available=${a.available} hold=${a.hold}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  const config = loadConfig(configPath);
  logger.level = 'info';

  if (config.exchange !== 'coinbase') {
    console.error(`Balances script currently only supports Coinbase (got exchange: ${config.exchange}).`);
    process.exit(1);
  }

  await checkCoinbaseBalances(config.symbol);
}

main().catch((err) => {
  console.error('Balances check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
