import { TradeRecord } from '../coinbase/types';
import { TradeHistoryService } from './history';
import { logger } from './logger';

export class PnlService {
  constructor(private history: TradeHistoryService) {}

  async logRebalance(record: TradeRecord): Promise<void> {
    const before = record.portfolioBefore;
    const after = record.portfolioAfter;

    logger.info('=== Rebalance Summary ===', {
      direction: record.direction,
      status: record.status,
      dryRun: record.dryRun,
      usdTarget: record.usdAmountTarget.toFixed(2),
      solFilled: record.solAmountFilled?.toFixed(6) ?? 'N/A',
      usdFilled: record.usdAmountFilled?.toFixed(2) ?? 'N/A',
      fillPrice: record.fillPrice?.toFixed(4) ?? 'N/A',
      feeUsd: record.feeUsd?.toFixed(4) ?? 'N/A',
      portfolioValueBefore: before.totalValueUsd.toFixed(2),
      portfolioValueAfter: after?.totalValueUsd.toFixed(2) ?? 'N/A',
      solRatioBefore: (before.solRatioBps / 100).toFixed(2) + '%',
      solRatioAfter: after ? (after.solRatioBps / 100).toFixed(2) + '%' : 'N/A',
    });
  }

  printReport(): void {
    const trades = this.history.readTrades();
    const filled = trades.filter((t) => t.status === 'FILLED');
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
    const initialValue = firstTrade.portfolioBefore.totalValueUsd;
    const currentValue =
      lastTrade.portfolioAfter?.totalValueUsd ??
      lastTrade.portfolioBefore.totalValueUsd;
    const totalFees = filled.reduce((sum, t) => sum + (t.feeUsd ?? 0), 0);
    const returnPct = ((currentValue - initialValue) / initialValue) * 100;
    const returnSign = returnPct >= 0 ? '+' : '';

    console.log("\n=== Shannon's Demon CEX — Performance Report ===");
    console.log(`Period:         ${firstTrade.timestamp} → ${lastTrade.timestamp}`);
    console.log(`Initial Value:  $${initialValue.toFixed(2)}`);
    console.log(`Current Value:  $${currentValue.toFixed(2)}`);
    console.log(`Return:         ${returnSign}${returnPct.toFixed(2)}%`);
    console.log(`Total Fees:     $${totalFees.toFixed(4)}`);
    console.log(`Rebalances:     ${filled.length} live, ${dryRuns.length} dry-run`);
    console.log('='.repeat(50));
  }
}
