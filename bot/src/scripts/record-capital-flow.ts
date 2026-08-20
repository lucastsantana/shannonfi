#!/usr/bin/env node
/**
 * Record a deposit or withdrawal against an instance's fund-share ledger, so its
 * NAV/share (and therefore every return/CAGR/Sharpe/benchmark metric derived from it)
 * stays unaffected by capital moving in or out — see ShareLedgerService.
 *
 * IMPORTANT — run this BEFORE moving the money on the exchange (wiring BRL in, or
 * withdrawing BRL out), not after. The script reads the account's current live value
 * as the pre-flow baseline; if the money's already moved, pass --already-moved so it
 * backs the amount out instead.
 *
 * Usage:
 *   npm run record-flow -- --config <path> --type deposit --brl 5000
 *   npm run record-flow -- --config <path> --type withdrawal --brl 1000 --note "profit take"
 *   npm run record-flow -- --config <path> --type deposit --brl 5000 --already-moved
 */

import { loadConfig } from '../config';
import { MercadoBitcoinAdapter } from '../adapters/mercadobitcoin/adapter';
import { CoinbaseAdapter } from '../adapters/coinbase/adapter';
import { ExchangeAdapter } from '../adapters/types';
import { ShareLedgerService } from '../core/tracker/shares';
import { logger } from '../core/tracker/logger';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
  const typeIdx = args.indexOf('--type');
  const typeArg = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
  const brlIdx = args.indexOf('--brl');
  const brlArg = brlIdx !== -1 ? args[brlIdx + 1] : undefined;
  const noteIdx = args.indexOf('--note');
  const note = noteIdx !== -1 ? args[noteIdx + 1] : undefined;
  const alreadyMoved = args.includes('--already-moved');

  if (typeArg !== 'deposit' && typeArg !== 'withdrawal') {
    console.error('Usage: record-flow -- --config <path> --type deposit|withdrawal --brl <amount> [--note "..."] [--already-moved]');
    process.exit(1);
  }
  const brlAmount = Number(brlArg);
  if (!brlArg || !Number.isFinite(brlAmount) || brlAmount <= 0) {
    console.error('--brl must be a positive number');
    process.exit(1);
  }

  const config = loadConfig(configPath);
  logger.level = 'info';

  let adapter: ExchangeAdapter;
  if (config.exchange === 'mercadobitcoin') {
    adapter = new MercadoBitcoinAdapter(config.mercadobitcoin, config.dryRun, config.maxSlippageBps, config.symbol);
  } else {
    adapter = new CoinbaseAdapter(config.coinbase, config.dryRun, config.maxSlippageBps, config.symbol);
  }

  const portfolio = await adapter.getPortfolio();
  const type = typeArg === 'deposit' ? 'DEPOSIT' : 'WITHDRAWAL';

  console.log(`\n=== Shannon's Demon — Record Capital Flow ===\n`);
  console.log(`Exchange:          ${config.exchange}`);
  console.log(`Type:              ${type}`);
  console.log(`BRL amount:        R$ ${brlAmount.toFixed(2)}`);
  console.log(`Live total value:  R$ ${portfolio.totalValueBrl.toFixed(2)} ${alreadyMoved ? '(already includes this flow)' : '(pre-flow)'}`);

  const shares = new ShareLedgerService(config.dbPath, config.jsonRetentionDays ?? 15);
  const record = shares.recordCapitalFlow({
    type,
    brlAmount,
    currentTotalValueBrl: portfolio.totalValueBrl,
    alreadyApplied: alreadyMoved,
    exchange: config.exchange,
    ...(note !== undefined ? { note } : {}),
  });

  console.log(`\nNAV/share before:  ${record.navPerShareBefore.toFixed(6)}`);
  console.log(`Shares ${type === 'DEPOSIT' ? 'issued' : 'redeemed'}:      ${Math.abs(record.sharesDelta).toFixed(6)}`);
  console.log(`Total shares now:  ${record.totalSharesAfter.toFixed(6)}`);
  console.log(`\nRecorded. ${alreadyMoved ? '' : `Now go ${type === 'DEPOSIT' ? 'deposit' : 'withdraw'} R$ ${brlAmount.toFixed(2)} on the exchange.`}`);
}

main().catch((err: unknown) => {
  logger.error('record-capital-flow failed', { error: (err as Error).message });
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
