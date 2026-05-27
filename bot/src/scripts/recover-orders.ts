#!/usr/bin/env node
/**
 * Recovery helper: lists recorded order IDs and instructs user on recovery.
 * Use this to identify untracked orders that executed on MB but crashed during polling.
 */

import { TradeHistoryService } from '../core/tracker/history';
import { logger } from '../core/tracker/logger';
import { loadConfig } from '../config';

async function main() {
  const config = loadConfig();
  logger.level = 'info';

  const history = new TradeHistoryService(config.dbPath);

  const trades = history.readTrades();
  const recordedOrderIds = new Set(trades.map((t) => t.exchangeOrderId).filter(Boolean));

  console.log('\n=== Shannon\'s Demon — Order Recovery ===\n');
  console.log(`Recorded orders: ${recordedOrderIds.size}`);
  if (recordedOrderIds.size > 0) {
    console.log('Order IDs on file:');
    Array.from(recordedOrderIds).forEach((id) => console.log(`  - ${id}`));
  }

  console.log('\nTo recover untracked orders:');
  console.log('1. Visit: https://www.mercadobitcoin.com.br/account/orders');
  console.log('2. Find any FILLED orders that are NOT in the list above');
  console.log('3. Note their order ID, timestamp, side (buy/sell), filled qty, and price');
  console.log('4. Add an entry to data/trade_history.json manually, or');
  console.log('5. Re-run the bot and it will re-fetch and record going forward\n');
}

main().catch((err) => {
  logger.error('Recovery helper failed', { error: (err as Error).message });
  process.exit(1);
});
