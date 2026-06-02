#!/usr/bin/env node
/**
 * Liquidate: sells the entire base asset position to BRL in a single market order.
 *
 * Usage:
 *   npm run liquidate                        — preview only (no trade)
 *   npm run liquidate -- --yes               — execute real liquidation
 *   npm run liquidate -- --dry-run           — simulate without placing an order
 *   npm run liquidate -- --config /path.yaml — use alternate config file
 */

import { loadConfig } from '../config';
import { MercadoBitcoinAdapter } from '../adapters/mercadobitcoin/adapter';
import { BinanceAdapter } from '../adapters/binance/adapter';
import { ExchangeAdapter } from '../adapters/types';
import { TradeHistoryService } from '../core/tracker/history';
import { CostBasisService } from '../core/tracker/costbasis';
import { TaxService } from '../core/tracker/tax';
import { PnlService } from '../core/tracker/pnl';
import { logger } from '../core/tracker/logger';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const dryRunFlag = args.includes('--dry-run');
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  const config = loadConfig(configPath);
  logger.level = 'info';

  const baseAsset = config.symbol.split('-')[0]!;
  const dryRun = dryRunFlag || config.dryRun;

  let adapter: ExchangeAdapter;
  if (config.exchange === 'mercadobitcoin') {
    adapter = new MercadoBitcoinAdapter(
      config.mercadobitcoin,
      dryRun,
      config.maxSlippageBps,
      config.symbol,
    );
  } else {
    adapter = new BinanceAdapter(
      config.binance,
      dryRun,
      config.maxSlippageBps,
      config.symbol,
    );
  }

  const portfolio = await adapter.getPortfolio();

  console.log(`\n=== Shannon's Demon — Liquidate ===\n`);
  console.log(`Symbol:       ${config.symbol}`);
  console.log(`${baseAsset} balance: ${portfolio.baseBalance.toFixed(8)}`);
  console.log(`${baseAsset} price:   R$ ${portfolio.basePrice.toFixed(2)}`);
  console.log(`${baseAsset} value:   R$ ${portfolio.baseValueBrl.toFixed(2)}`);
  console.log(`BRL balance:  R$ ${portfolio.brlBalance.toFixed(2)}`);
  console.log(`Total value:  R$ ${portfolio.totalValueBrl.toFixed(2)}`);

  if (portfolio.baseBalance < 1e-8) {
    console.log(`\nNothing to liquidate — ${baseAsset} balance is ~0.`);
    process.exit(0);
  }

  console.log(`\nAction: SELL ${portfolio.baseBalance.toFixed(8)} ${baseAsset}`);
  console.log(`        → ~R$ ${portfolio.baseValueBrl.toFixed(2)} BRL at market price`);

  if (dryRun) {
    console.log('\n[DRY RUN] No real order will be placed.');
  } else if (!yes) {
    console.log('\nThis will sell your entire ' + baseAsset + ' position.');
    console.log('To execute, re-run with --yes:');
    console.log(`  npm run liquidate -- --yes`);
    process.exit(0);
  }

  const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const brlAmount = portfolio.baseBalance * portfolio.basePrice;

  console.log('\nPlacing order...');
  const tradeRecord = await adapter.executeTrade('SELL_BASE', brlAmount, portfolio);
  tradeRecord.tradeDateBRT = todayBRT;

  if (tradeRecord.status === 'FILLED') {
    tradeRecord.portfolioAfter = await adapter.getPortfolio();
  }

  // Record trade, cost basis, and tax — same logic as RebalancerBot
  const retentionDays = config.jsonRetentionDays ?? 15;
  const history = new TradeHistoryService(config.dbPath, retentionDays);
  const costBasis = new CostBasisService(config.dbPath, retentionDays, baseAsset);
  const tax = new TaxService(config.dbPath, retentionDays);
  const pnl = new PnlService(history);

  if (tradeRecord.status === 'FILLED' || tradeRecord.status === 'DRY_RUN') {
    const baseSold = tradeRecord.baseAmountFilled ?? portfolio.baseBalance;
    const brlReceived = tradeRecord.brlAmountFilled ?? brlAmount;
    const costBasisBrl = costBasis.getLedger().base.averageCostBrl * baseSold;
    const realizedGainBrl = costBasis.updateAfterSell(baseSold, brlReceived);
    tradeRecord.realizedGainBrl = realizedGainBrl;

    // Trade must be inserted before tax event (FK: tax_events.trade_id → trades.id)
    await history.appendTrade(tradeRecord);
    await pnl.logRebalance(tradeRecord);

    const taxEvent = tax.buildTaxEvent({
      tradeId: tradeRecord.id,
      tradeDateBRT: todayBRT,
      direction: 'SELL_BASE',
      tradedVolumeBrl: brlReceived,
      grossProceedsBrl: brlReceived,
      costBasisBrl,
      realizedGainBrl,
      exchange: tradeRecord.exchange,
    });
    tax.appendTaxEvent(taxEvent);

    console.log(`\nTax: ${taxEvent.exempt ? 'EXEMPT' : 'TAXABLE'} (cumulative this month: R$ ${taxEvent.cumMonthlySalesBrl.toFixed(2)})`);
    if (!taxEvent.exempt && taxEvent.paymentDeadline) {
      console.log(`Payment deadline: ${taxEvent.paymentDeadline}`);
    }
    console.log(`Realized gain/loss: R$ ${realizedGainBrl.toFixed(2)}`);
  } else {
    await history.appendTrade(tradeRecord);
    await pnl.logRebalance(tradeRecord);
  }

  console.log(`\nStatus: ${tradeRecord.status}`);

  if (tradeRecord.status === 'FILLED') {
    const filled = tradeRecord.baseAmountFilled!;
    const brlFilled = tradeRecord.brlAmountFilled!;
    const fillPrice = tradeRecord.fillPrice!;
    console.log(`Sold:       ${filled.toFixed(8)} ${baseAsset}`);
    console.log(`Received:   R$ ${brlFilled.toFixed(2)}`);
    console.log(`Fill price: R$ ${fillPrice.toFixed(2)}`);
    if (tradeRecord.feeBrl != null) {
      console.log(`Fee:        R$ ${tradeRecord.feeBrl.toFixed(2)}`);
    }
  }

  if (tradeRecord.portfolioAfter) {
    const after = tradeRecord.portfolioAfter;
    console.log(`\nFinal portfolio:`);
    console.log(`  ${baseAsset}: ${after.baseBalance.toFixed(8)}`);
    console.log(`  BRL: R$ ${after.brlBalance.toFixed(2)}`);
    console.log(`  Total: R$ ${after.totalValueBrl.toFixed(2)}`);
  }
}

main().catch((err: unknown) => {
  logger.error('Liquidate failed', { error: (err as Error).message });
  console.error('\nError:', (err as Error).message);
  process.exit(1);
});
