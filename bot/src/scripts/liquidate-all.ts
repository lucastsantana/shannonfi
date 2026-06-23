#!/usr/bin/env node
/**
 * Liquidate-all: sells every non-cash asset in a Coinbase account into the
 * instance's configured quote currency (USDC by default — see config.ts and
 * docs/coinbase-adapter-plan.md for why USDC, not USD, is the supported quote
 * currency for Brazilian-held Coinbase accounts) via market orders. Unlike
 * liquidate.ts (which sells only the instance's configured base asset), this
 * walks every account with a nonzero balance — useful for consolidating an
 * account before pointing the bot at a specific pair.
 *
 * Always shows a preview and asks for interactive confirmation before placing any
 * order. Pass --yes to skip the interactive prompt (e.g. for scripted use) — this
 * does NOT skip the preview, it only skips waiting for a typed "yes".
 *
 * Usage:
 *   npm run liquidate-all -- --config configs/coinbase-shannon-1.yaml             — preview + confirm + execute
 *   npm run liquidate-all -- --config configs/coinbase-shannon-1.yaml --dry-run   — preview only, places no orders
 *   npm run liquidate-all -- --config configs/coinbase-shannon-1.yaml --yes       — skip the interactive prompt
 */

import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from '../config';
import { getCoinbaseCredentials } from '../core/keyring';
import { CoinbaseClient } from '../adapters/coinbase/client';
import { CoinbaseEndpoints } from '../adapters/coinbase/endpoints';
import { logger } from '../core/tracker/logger';
import { COINBASE_FILL_POLL_INTERVAL_MS, COINBASE_FILL_POLL_MAX_ATTEMPTS } from '../constants';

const CASH_CURRENCIES = new Set(['USD', 'USDC']);

interface Holding {
  currency: string;
  available: number;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function pollOrderFill(endpoints: CoinbaseEndpoints, orderId: string) {
  for (let attempt = 0; attempt < COINBASE_FILL_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, COINBASE_FILL_POLL_INTERVAL_MS));
    try {
      const resp = await endpoints.getOrder(orderId);
      const terminal: string[] = ['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED'];
      if (terminal.includes(resp.order.status)) return resp.order;
    } catch (err) {
      if (attempt === COINBASE_FILL_POLL_MAX_ATTEMPTS - 1) throw err;
    }
  }
  return (await endpoints.getOrder(orderId)).order;
}

async function getNonCashHoldings(endpoints: CoinbaseEndpoints): Promise<Holding[]> {
  const holdings: Holding[] = [];
  let cursor: string | undefined;
  do {
    const resp = await endpoints.getAccounts(cursor);
    for (const account of resp.accounts) {
      const available = parseFloat(account.available_balance.value);
      if (available > 0 && !CASH_CURRENCIES.has(account.currency)) {
        holdings.push({ currency: account.currency, available });
      }
    }
    cursor = resp.has_next ? resp.cursor : undefined;
  } while (cursor);
  return holdings;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  const config = loadConfig(configPath);
  logger.level = 'info';

  if (config.exchange !== 'coinbase') {
    console.error(`liquidate-all currently only supports Coinbase (got exchange: ${config.exchange}).`);
    process.exit(1);
  }

  const quoteCurrency = config.symbol.split('-')[1]!;

  const creds = getCoinbaseCredentials();
  const client = new CoinbaseClient(creds.keyName, creds.privateKeyPem, config.coinbase.apiBaseUrl);
  // productId arg is a default used by getCandles/getProduct when no override is
  // passed; this script always passes an explicit per-asset product, so it's unused.
  const endpoints = new CoinbaseEndpoints(client, config.symbol);

  const holdings = await getNonCashHoldings(endpoints);
  if (holdings.length === 0) {
    console.log(`No non-cash holdings found — nothing to liquidate into ${quoteCurrency}.`);
    return;
  }

  console.log(`\nFound ${holdings.length} asset(s) to liquidate to ${quoteCurrency}:\n`);
  for (const h of holdings) {
    console.log(`  ${h.currency}: ${h.available}`);
  }
  console.log(
    `\nEach will be sold via a ${dryRun ? 'SIMULATED ' : ''}market order to ${quoteCurrency} (product <CURRENCY>-${quoteCurrency}).\n`,
  );

  if (!dryRun) {
    if (!yes) {
      const ok = await confirm('Type "yes" to proceed with REAL market sell orders, anything else to cancel: ');
      if (!ok) {
        console.log('Cancelled — no orders placed.');
        return;
      }
    } else {
      console.log('--yes passed, skipping interactive confirmation.');
    }
  }

  for (const h of holdings) {
    const productId = `${h.currency}-${quoteCurrency}`;
    if (dryRun) {
      console.log(`[DRY RUN] Would sell ${h.available} ${h.currency} via ${productId}`);
      continue;
    }

    const clientOrderId = uuidv4();
    try {
      const created = await endpoints.createOrder({
        client_order_id: clientOrderId,
        product_id: productId,
        side: 'SELL',
        order_configuration: { market_market_ioc: { base_size: h.available.toString() } },
      });

      if (!created.success || !created.success_response) {
        console.log(`FAILED  ${h.currency}: ${JSON.stringify(created.error_response)}`);
        continue;
      }

      const filled = await pollOrderFill(endpoints, created.success_response.order_id);
      if (filled.status === 'FILLED') {
        console.log(
          `FILLED  ${h.currency}: sold ${filled.filled_size} for ${filled.filled_value} ${quoteCurrency} (fee ${filled.total_fees} ${quoteCurrency})`,
        );
      } else {
        console.log(`${filled.status}  ${h.currency}: order ${created.success_response.order_id} did not fill`);
      }
    } catch (err) {
      console.log(`ERROR   ${h.currency}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch((err) => {
  console.error('liquidate-all failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
