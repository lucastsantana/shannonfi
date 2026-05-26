import { PortfolioService } from './portfolio';
import { TraderService } from './trader';
import { TradeHistoryService } from '../tracker/history';
import { PnlService } from '../tracker/pnl';
import { CostBasisService } from '../tracker/costbasis';
import { TaxService } from '../tracker/tax';
import { VolatilityService } from '../tracker/volatility';
import { MetricsService } from '../tracker/metrics';
import { logger } from '../tracker/logger';
import { shouldRebalance, computeRebalanceTrade } from '../math';
import { Config } from '../config';
import { PortfolioSnapshot } from '../mb/types';
import { BR_EFFECTIVE_LIMIT_BRL } from '../constants';

/**
 * Core rebalancing loop for Mercado Bitcoin (SOL-BRL).
 *
 * All accounting is BRL-native: no FX conversion needed.
 * The R$35,000 monthly exemption (Lei 9.250/1995 Art. 21) applies here because
 * Mercado Bitcoin is a domestic exchange. Only SELL_SOL proceeds count toward
 * the threshold — BUY_SOL purchases do not.
 *
 * Guards (in execution order):
 *   minPortfolioValueBrl   → skip if portfolio too small
 *   shouldRebalance()      → drift check (adaptive or fixed threshold)
 *   minRebalanceInterval   → cooldown between rebalances
 *   dayTradeGuard          → blocks opposite-direction trade on same BRT calendar day
 *   neverExceedExemption   → caps or skips SELL_SOL to stay under R$34,650/month
 *   minTradeSizeBrl        → minimum order size guard
 */
export class RebalancerBot {
  private lastRebalanceTime: number;
  private lastRebalanceDateBRT: string | null;
  private lastRebalanceDirection: 'BUY_SOL' | 'SELL_SOL' | null;
  private isRunning = false;

  constructor(
    private portfolio: PortfolioService,
    private trader: TraderService,
    private history: TradeHistoryService,
    private pnl: PnlService,
    private costBasis: CostBasisService,
    private tax: TaxService,
    private volatility: VolatilityService,
    private metrics: MetricsService,
    private config: Config,
  ) {
    this.lastRebalanceTime = history.getLastRebalanceTime();
    const { dateBRT, direction } = history.getLastRebalanceInfo();
    this.lastRebalanceDateBRT = dateBRT;
    this.lastRebalanceDirection = direction;

    if (this.lastRebalanceTime > 0) {
      logger.info('Restored rebalance state from history', {
        lastRebalanceTime: new Date(this.lastRebalanceTime).toISOString(),
        lastRebalanceDateBRT: this.lastRebalanceDateBRT,
        lastRebalanceDirection: this.lastRebalanceDirection,
      });
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;

    logger.info("Shannon's Demon MB bot starting", {
      dryRun: this.config.dryRun,
      useAdaptiveThreshold: this.config.useAdaptiveThreshold,
      thresholdBps: this.config.rebalanceThresholdBps,
      volatilityMultiplier: this.config.thresholdVolatilityMultiplier,
      neverExceedExemptionLimit: this.config.neverExceedExemptionLimit,
      pollIntervalSeconds: this.config.pollIntervalSeconds,
      minRebalanceIntervalSeconds: this.config.minRebalanceIntervalSeconds,
    });

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    while (this.isRunning) {
      try {
        await this.checkAndRebalance();
      } catch (err) {
        logger.error('Error in rebalance cycle', { error: (err as Error).message });
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalSeconds * 1_000));
    }
  }

  async checkAndRebalance(): Promise<void> {
    const portfolioSnapshot = await this.portfolio.getPortfolio();

    logger.info('Portfolio snapshot', {
      solBalance: portfolioSnapshot.solBalance.toFixed(6),
      brlBalance: portfolioSnapshot.brlBalance.toFixed(2),
      solPriceBrl: portfolioSnapshot.solPrice.toFixed(2),
      totalValueBrl: portfolioSnapshot.totalValueBrl.toFixed(2),
      solRatio: (portfolioSnapshot.solRatioBps / 100).toFixed(2) + '%',
      deviationBps: portfolioSnapshot.deviationBps,
    });

    // ── Guard 1: minimum portfolio size ─────────────────────────────────────
    if (portfolioSnapshot.totalValueBrl < this.config.minPortfolioValueBrl) {
      logger.warn('Portfolio below minimum size, skipping', {
        totalValueBrl: portfolioSnapshot.totalValueBrl.toFixed(2),
        minPortfolioValueBrl: this.config.minPortfolioValueBrl,
      });
      await this.persistSnapshot(portfolioSnapshot, false, this.config.rebalanceThresholdBps);
      return;
    }

    // ── Compute effective threshold (adaptive or fixed) ──────────────────────
    let effectiveThresholdBps = this.config.rebalanceThresholdBps;
    if (this.config.useAdaptiveThreshold) {
      try {
        effectiveThresholdBps = await this.volatility.computeAdaptiveThresholdBps(
          this.config.thresholdVolatilityMultiplier,
        );
      } catch (err) {
        logger.warn('Adaptive threshold unavailable, using static threshold', {
          error: (err as Error).message,
          fallbackBps: this.config.rebalanceThresholdBps,
        });
      }
    }

    // ── Guard 2: drift threshold ─────────────────────────────────────────────
    if (!shouldRebalance(portfolioSnapshot.solRatioBps, effectiveThresholdBps)) {
      logger.info('No rebalance needed', {
        deviationBps: portfolioSnapshot.deviationBps,
        effectiveThresholdBps,
      });
      await this.persistSnapshot(portfolioSnapshot, false, effectiveThresholdBps);
      return;
    }

    // ── Guard 3: cooldown interval ───────────────────────────────────────────
    const now = Date.now();
    const secondsSinceLastRebalance = (now - this.lastRebalanceTime) / 1000;
    if (secondsSinceLastRebalance < this.config.minRebalanceIntervalSeconds) {
      logger.info('Rebalance cooldown active', {
        secondsSinceLastRebalance: secondsSinceLastRebalance.toFixed(0),
        minRebalanceIntervalSeconds: this.config.minRebalanceIntervalSeconds,
      });
      await this.persistSnapshot(portfolioSnapshot, false, effectiveThresholdBps);
      return;
    }

    // ── Compute trade direction and BRL amount ───────────────────────────────
    let { direction, brlAmount } = computeRebalanceTrade(
      portfolioSnapshot.solValueBrl,
      portfolioSnapshot.brlBalance,
    );

    // ── Guard 4: day-trade guard ─────────────────────────────────────────────
    // Block a trade if it's the opposite direction from the last trade today.
    // This avoids wash-trade tax complications on the same BRT calendar day.
    const todayBRT = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Sao_Paulo',
    });
    const isOppositeDirection =
      this.lastRebalanceDirection !== null && this.lastRebalanceDirection !== direction;
    if (this.lastRebalanceDateBRT === todayBRT && isOppositeDirection) {
      logger.info('Day-trade guard: opposite-direction trade blocked today (BRT)', {
        date: todayBRT,
        proposedDirection: direction,
        priorDirection: this.lastRebalanceDirection,
      });
      await this.persistSnapshot(portfolioSnapshot, false, effectiveThresholdBps);
      return;
    }

    // ── Guard 5: exemption limit cap (SELL_SOL only — buys don't count) ──────
    // Under Lei 9.250/1995 Art. 21, only sales (alienações) count toward the
    // R$35,000 monthly threshold. BUY_SOL purchases are not restricted.
    if (this.config.neverExceedExemptionLimit && direction === 'SELL_SOL') {
      const monthBRT = todayBRT.slice(0, 7);
      const salesSoFarBrl = this.tax.getMonthlySalesBrl(monthBRT);
      const remainingBrl = Math.max(0, BR_EFFECTIVE_LIMIT_BRL - salesSoFarBrl);

      if (brlAmount > remainingBrl) {
        if (remainingBrl < this.config.minTradeSizeBrl) {
          logger.info('Monthly sales exemption limit reached — skipping SELL trade', {
            salesSoFarBrl: salesSoFarBrl.toFixed(2),
            remainingBrl: remainingBrl.toFixed(2),
            monthBRT,
          });
          await this.persistSnapshot(portfolioSnapshot, false, effectiveThresholdBps);
          return;
        }
        logger.info('Capping SELL trade to preserve monthly tax exemption', {
          originalBrlAmount: brlAmount.toFixed(2),
          cappedBrlAmount: remainingBrl.toFixed(2),
          remainingBrl: remainingBrl.toFixed(2),
          monthBRT,
        });
        brlAmount = remainingBrl;
      }
    }

    // ── Guard 6: minimum trade size ──────────────────────────────────────────
    if (brlAmount < this.config.minTradeSizeBrl) {
      logger.info('Trade amount below minimum', {
        brlAmount: brlAmount.toFixed(2),
        minTradeSizeBrl: this.config.minTradeSizeBrl,
      });
      await this.persistSnapshot(portfolioSnapshot, false, effectiveThresholdBps);
      return;
    }

    logger.info('Rebalance triggered', {
      direction,
      brlAmount: brlAmount.toFixed(2),
      solRatioBps: portfolioSnapshot.solRatioBps,
      deviationBps: portfolioSnapshot.deviationBps,
      effectiveThresholdBps,
    });

    const tradeRecord = await this.trader.executeTrade(
      direction,
      brlAmount,
      portfolioSnapshot,
    );

    tradeRecord.tradeDateBRT = todayBRT;

    if (tradeRecord.status === 'filled' || tradeRecord.status === 'DRY_RUN') {
      this.lastRebalanceTime = now;
      this.lastRebalanceDateBRT = todayBRT;
      this.lastRebalanceDirection = direction;

      if (!this.config.dryRun) {
        tradeRecord.portfolioAfter = await this.portfolio.getPortfolio();
      }

      // ── Cost basis and tax tracking ─────────────────────────────────────────
      if (direction === 'SELL_SOL' && tradeRecord.solAmountFilled != null) {
        const solSold = tradeRecord.solAmountFilled;
        const brlReceived = tradeRecord.brlAmountFilled ?? brlAmount;

        const realizedGainBrl = this.costBasis.updateAfterSell(solSold, brlReceived);
        tradeRecord.realizedGainBrl = realizedGainBrl;

        const ledger = this.costBasis.getLedger();
        const costBasisBrl = ledger.sol.averageCostBrl * solSold;
        const grossProceedsBrl = brlReceived;

        const taxEvent = this.tax.buildTaxEvent({
          tradeId: tradeRecord.id,
          tradeDateBRT: todayBRT,
          direction,
          tradedVolumeBrl: grossProceedsBrl,
          grossProceedsBrl,
          costBasisBrl,
          realizedGainBrl,
        });
        this.tax.appendTaxEvent(taxEvent);

        logger.info('BRL tax event recorded (SELL_SOL)', {
          tradedVolumeBrl: grossProceedsBrl.toFixed(2),
          realizedGainBrl: realizedGainBrl.toFixed(2),
          cumMonthlySalesBrl: taxEvent.cumMonthlySalesBrl.toFixed(2),
          cumMonthlyGainBrl: taxEvent.cumMonthlyGainBrl.toFixed(2),
          exempt: taxEvent.exempt,
          paymentDeadline: taxEvent.paymentDeadline ?? 'exempt',
        });
      } else if (direction === 'BUY_SOL' && tradeRecord.solAmountFilled != null) {
        const solAcquired = tradeRecord.solAmountFilled;
        const brlSpent = tradeRecord.brlAmountFilled ?? brlAmount;
        this.costBasis.updateAfterBuy(solAcquired, brlSpent);
        tradeRecord.realizedGainBrl = 0;

        // BUY events are logged for audit but don't affect the exemption threshold
        const taxEvent = this.tax.buildTaxEvent({
          tradeId: tradeRecord.id,
          tradeDateBRT: todayBRT,
          direction,
          tradedVolumeBrl: 0,
          grossProceedsBrl: 0,
          costBasisBrl: 0,
          realizedGainBrl: 0,
        });
        this.tax.appendTaxEvent(taxEvent);

        logger.info('Cost basis updated (BUY_SOL)', {
          solAcquired: solAcquired.toFixed(6),
          brlSpent: brlSpent.toFixed(2),
        });
      }
    }

    await this.history.appendTrade(tradeRecord);
    await this.pnl.logRebalance(tradeRecord);
    await this.persistSnapshot(portfolioSnapshot, true, effectiveThresholdBps);
  }

  private async persistSnapshot(
    portfolio: Awaited<ReturnType<PortfolioService['getPortfolio']>>,
    rebalancedToday: boolean,
    effectiveThresholdBps: number,
  ): Promise<void> {
    const todayBRT = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Sao_Paulo',
    });

    const existing = this.history.readSnapshots();
    if (existing.some((s) => s.dateBRT === todayBRT)) return;

    const snapshot: PortfolioSnapshot = {
      dateBRT: todayBRT,
      timestamp: new Date().toISOString(),
      totalValueBrl: portfolio.totalValueBrl,
      solBalance: portfolio.solBalance,
      brlBalance: portfolio.brlBalance,
      solPrice: portfolio.solPrice,
      solRatioBps: portfolio.solRatioBps,
      effectiveThresholdBps,
      rebalancedToday,
    };
    this.history.appendSnapshot(snapshot);
  }

  shutdown(): void {
    logger.info('Shutting down MB rebalancer bot...');
    this.isRunning = false;
  }
}
