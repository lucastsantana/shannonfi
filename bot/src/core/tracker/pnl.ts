import { TradeRecord } from '../../adapters/types';
import { TradeHistoryService } from './history';
import { logger } from './logger';

export class PnlService {
  constructor(private history: TradeHistoryService) {}

  async logRebalance(record: TradeRecord): Promise<void> {
    const before = record.portfolioBefore;
    const after = record.portfolioAfter;
    logger.info('=== Rebalance Summary ===', {
      exchange: record.exchange,
      direction: record.direction,
      status: record.status,
      dryRun: record.dryRun,
      brlTarget: record.brlAmountTarget.toFixed(2),
      baseFilled: record.baseAmountFilled?.toFixed(6) ?? 'N/A',
      brlFilled: record.brlAmountFilled?.toFixed(2) ?? 'N/A',
      fillPriceBrl: record.fillPrice?.toFixed(2) ?? 'N/A',
      feeBrl: record.feeBrl?.toFixed(2) ?? 'N/A',
      portfolioValueBefore: 'R$' + before.totalValueBrl.toFixed(2),
      portfolioValueAfter: after ? 'R$' + after.totalValueBrl.toFixed(2) : 'N/A',
      baseRatioBefore: (before.baseRatioBps / 100).toFixed(2) + '%',
      baseRatioAfter: after ? (after.baseRatioBps / 100).toFixed(2) + '%' : 'N/A',
    });
  }

  printReport(): void {
    const trades = this.history.readTrades();
    const filled = trades.filter(
      (t) => t.status === 'FILLED',
    );
    const dryRuns = trades.filter((t) => t.status === 'DRY_RUN');

    if (filled.length === 0 && dryRuns.length === 0) {
      logger.info('No completed trades to report');
      return;
    }

    const allCompleted = [...filled, ...dryRuns].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const firstTrade = allCompleted[0]!;
    const lastTrade = allCompleted[allCompleted.length - 1]!;
    const initialValue = firstTrade.portfolioBefore.totalValueBrl;
    const currentValue =
      lastTrade.portfolioAfter?.totalValueBrl ?? lastTrade.portfolioBefore.totalValueBrl;
    const totalFees = filled.reduce((sum, t) => sum + (t.feeBrl ?? 0), 0);
    const returnPct = ((currentValue - initialValue) / initialValue) * 100;
    const sign = returnPct >= 0 ? '+' : '';

    console.log("\n=== Shannon's Demon — Performance Report ===");
    console.log(`Exchange:       ${firstTrade.exchange}`);
    console.log(`Period:         ${firstTrade.timestamp.slice(0, 10)} → ${lastTrade.timestamp.slice(0, 10)}`);
    console.log(`Initial Value:  R$${initialValue.toFixed(2)}`);
    console.log(`Current Value:  R$${currentValue.toFixed(2)}`);
    console.log(`Return:         ${sign}${returnPct.toFixed(2)}%`);
    console.log(`Total Fees:     R$${totalFees.toFixed(2)}`);
    console.log(`Rebalances:     ${filled.length} live, ${dryRuns.length} dry-run`);
    console.log('='.repeat(50));
  }
}
