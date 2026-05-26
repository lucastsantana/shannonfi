import { PortfolioService } from './portfolio';
import { TraderService } from './trader';
import { TradeHistoryService } from '../tracker/history';
import { PnlService } from '../tracker/pnl';
import { logger } from '../tracker/logger';
import { shouldRebalance, computeRebalanceTrade } from '../math';
import { Config } from '../config';

/**
 * Core rebalancing loop — TypeScript port of rebalance.rs + keeper.ts polling loop.
 *
 * Guards map to on-chain error codes:
 *   minPortfolioValueUsd    → InsufficientVaultSol
 *   shouldRebalance()       → BelowThreshold
 *   minRebalanceInterval    → SlotNotElapsed
 *   minTradeSizeUsd         → minimum order size guard
 */
export class RebalancerBot {
  private lastRebalanceTime: number;
  private isRunning = false;

  constructor(
    private portfolio: PortfolioService,
    private trader: TraderService,
    private history: TradeHistoryService,
    private pnl: PnlService,
    private config: Config,
  ) {
    // Restore cooldown state from persisted trade history so the
    // MIN_REBALANCE_INTERVAL_SECONDS guard works correctly after restarts
    // and across --once invocations (e.g. GitHub Actions runs).
    this.lastRebalanceTime = history.getLastRebalanceTime();
    if (this.lastRebalanceTime > 0) {
      logger.info('Restored last rebalance time from history', {
        lastRebalanceTime: new Date(this.lastRebalanceTime).toISOString(),
      });
    }
  }

  /**
   * Continuous polling loop. Runs every pollIntervalSeconds.
   * Call start() for server / local deployment.
   * Call checkAndRebalance() directly for --once / GitHub Actions mode.
   */
  async start(): Promise<void> {
    this.isRunning = true;

    logger.info("Shannon's Demon CEX bot starting", {
      dryRun: this.config.dryRun,
      thresholdBps: this.config.rebalanceThresholdBps,
      pollIntervalSeconds: this.config.pollIntervalSeconds,
      minRebalanceIntervalSeconds: this.config.minRebalanceIntervalSeconds,
    });

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    while (this.isRunning) {
      try {
        await this.checkAndRebalance();
      } catch (err) {
        logger.error('Error in rebalance cycle', {
          error: (err as Error).message,
        });
      }
      await new Promise((r) =>
        setTimeout(r, this.config.pollIntervalSeconds * 1_000),
      );
    }
  }

  async checkAndRebalance(): Promise<void> {
    const portfolioSnapshot = await this.portfolio.getPortfolio();

    logger.info('Portfolio snapshot', {
      solBalance: portfolioSnapshot.solBalance.toFixed(6),
      usdBalance: portfolioSnapshot.usdBalance.toFixed(2),
      solPrice: portfolioSnapshot.solPrice.toFixed(2),
      totalValueUsd: portfolioSnapshot.totalValueUsd.toFixed(2),
      solRatio: (portfolioSnapshot.solRatioBps / 100).toFixed(2) + '%',
      deviationBps: portfolioSnapshot.deviationBps,
    });

    if (portfolioSnapshot.totalValueUsd < this.config.minPortfolioValueUsd) {
      logger.warn('Portfolio below minimum size, skipping', {
        totalValueUsd: portfolioSnapshot.totalValueUsd.toFixed(2),
        minPortfolioValueUsd: this.config.minPortfolioValueUsd,
      });
      return;
    }

    if (
      !shouldRebalance(
        portfolioSnapshot.solRatioBps,
        this.config.rebalanceThresholdBps,
      )
    ) {
      logger.info('No rebalance needed', {
        deviationBps: portfolioSnapshot.deviationBps,
        thresholdBps: this.config.rebalanceThresholdBps,
      });
      return;
    }

    const now = Date.now();
    const secondsSinceLastRebalance = (now - this.lastRebalanceTime) / 1000;
    if (secondsSinceLastRebalance < this.config.minRebalanceIntervalSeconds) {
      logger.info('Rebalance cooldown active', {
        secondsSinceLastRebalance: secondsSinceLastRebalance.toFixed(0),
        minRebalanceIntervalSeconds: this.config.minRebalanceIntervalSeconds,
      });
      return;
    }

    const { direction, usdAmount } = computeRebalanceTrade(
      portfolioSnapshot.solValueUsd,
      portfolioSnapshot.usdBalance,
    );

    if (usdAmount < this.config.minTradeSizeUsd) {
      logger.info('Trade amount below minimum', {
        usdAmount: usdAmount.toFixed(2),
        minTradeSizeUsd: this.config.minTradeSizeUsd,
      });
      return;
    }

    logger.info('Rebalance triggered', {
      direction,
      usdAmount: usdAmount.toFixed(2),
      solRatioBps: portfolioSnapshot.solRatioBps,
      deviationBps: portfolioSnapshot.deviationBps,
    });

    const tradeRecord = await this.trader.executeTrade(
      direction,
      usdAmount,
      portfolioSnapshot,
    );

    if (tradeRecord.status === 'FILLED' || tradeRecord.status === 'DRY_RUN') {
      this.lastRebalanceTime = now;

      if (!this.config.dryRun) {
        tradeRecord.portfolioAfter = await this.portfolio.getPortfolio();
      }
    }

    await this.history.appendTrade(tradeRecord);
    await this.pnl.logRebalance(tradeRecord);
  }

  shutdown(): void {
    logger.info('Shutting down rebalancer bot...');
    this.isRunning = false;
  }
}
