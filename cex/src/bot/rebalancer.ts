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
import { fetchUsdBrlRate } from '../coinbase/fx';
import { Config } from '../config';
import { BrlSnapshot, PortfolioSnapshot } from '../coinbase/types';
import { BR_EFFECTIVE_LIMIT_BRL } from '../constants';

/**
 * Core rebalancing loop for Coinbase Advanced Trade API.
 *
 * Tax regime: Coinbase is a US-domiciled (foreign) exchange. Under Lei 14.754/2023,
 * gains from foreign crypto assets are taxed at a flat 15% annually via IRPF. The
 * R$35,000 monthly exemption (Lei 9.250/1995) does NOT apply to foreign exchanges.
 * The neverExceedExemptionLimit guard is kept as an optional volume-management
 * strategy but has no legal exemption effect on Coinbase trades.
 *
 * Guards (in execution order):
 *   minPortfolioValueUsd    → skip if portfolio too small
 *   shouldRebalance()       → drift check (adaptive or fixed threshold)
 *   minRebalanceInterval    → cooldown between rebalances
 *   dayTradeGuard           → blocks opposite-direction trade on same BRT calendar day
 *                             (strategy constraint, not a legal prohibition)
 *   neverExceedExemption    → caps or skips trades above monthly volume target
 *   minTradeSizeUsd         → minimum order size guard
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
    // Restore cooldown and day-trade state from persisted trade history so all
    // guards work correctly after restarts and across --once invocations.
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

  /**
   * Continuous polling loop. Call start() for server / local deployment.
   * Call checkAndRebalance() directly for --once / GitHub Actions mode.
   */
  async start(): Promise<void> {
    this.isRunning = true;

    logger.info("Shannon's Demon CEX bot starting", {
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

    // ── Guard 1: minimum portfolio size ────────────────────────────────────────
    if (portfolioSnapshot.totalValueUsd < this.config.minPortfolioValueUsd) {
      logger.warn('Portfolio below minimum size, skipping', {
        totalValueUsd: portfolioSnapshot.totalValueUsd.toFixed(2),
        minPortfolioValueUsd: this.config.minPortfolioValueUsd,
      });
      await this.persistSnapshot(portfolioSnapshot, false, this.config.rebalanceThresholdBps);
      return;
    }

    // ── Compute effective threshold (adaptive or fixed) ─────────────────────
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

    // ── Guard 2: drift threshold ───────────────────────────────────────────────
    if (!shouldRebalance(portfolioSnapshot.solRatioBps, effectiveThresholdBps)) {
      logger.info('No rebalance needed', {
        deviationBps: portfolioSnapshot.deviationBps,
        effectiveThresholdBps,
      });
      await this.persistSnapshot(portfolioSnapshot, false, effectiveThresholdBps);
      return;
    }

    // ── Guard 3: cooldown interval ─────────────────────────────────────────────
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

    // ── Compute trade direction and amount (needed for day-trade guard) ────────
    let { direction, usdAmount } = computeRebalanceTrade(
      portfolioSnapshot.solValueUsd,
      portfolioSnapshot.usdBalance,
    );

    // ── Guard 4: day-trade guard ───────────────────────────────────────────────
    // Block opposite-direction trade on same BRT calendar day (strategy constraint).
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

    // ── Guard 5: volume cap (opt-in, both directions) ──────────────────────────
    // Note: Coinbase is a foreign exchange — the R$35,000 domestic exemption does
    // not apply (Lei 14.754/2023 governs instead, with flat 15% annual rate).
    // This guard is kept as an optional monthly-volume management tool.
    if (this.config.neverExceedExemptionLimit) {
      const usdBrlRate = await fetchUsdBrlRate(this.config.fxApiUrl);
      if (usdBrlRate !== null) {
        const monthBRT = todayBRT.slice(0, 7);
        const volumeSoFarBrl = this.tax.getMonthlyVolumeBrl(monthBRT);
        const remainingBrl = Math.max(0, BR_EFFECTIVE_LIMIT_BRL - volumeSoFarBrl);
        const remainingUsd = remainingBrl / usdBrlRate;

        if (usdAmount > remainingUsd) {
          if (remainingUsd < this.config.minTradeSizeUsd) {
            logger.info('Monthly exemption limit reached — skipping trade', {
              direction,
              volumeSoFarBrl: volumeSoFarBrl.toFixed(2),
              remainingBrl: remainingBrl.toFixed(2),
              monthBRT,
            });
            await this.persistSnapshot(portfolioSnapshot, false, effectiveThresholdBps);
            return;
          }
          logger.info('Capping trade to preserve monthly tax exemption', {
            direction,
            originalUsdAmount: usdAmount.toFixed(2),
            cappedUsdAmount: remainingUsd.toFixed(2),
            remainingBrl: remainingBrl.toFixed(2),
            monthBRT,
          });
          usdAmount = remainingUsd;
        }
      }
    }

    // ── Guard 6: minimum trade size ────────────────────────────────────────────
    if (usdAmount < this.config.minTradeSizeUsd) {
      logger.info('Trade amount below minimum', {
        usdAmount: usdAmount.toFixed(2),
        minTradeSizeUsd: this.config.minTradeSizeUsd,
      });
      await this.persistSnapshot(portfolioSnapshot, false, effectiveThresholdBps);
      return;
    }

    logger.info('Rebalance triggered', {
      direction,
      usdAmount: usdAmount.toFixed(2),
      solRatioBps: portfolioSnapshot.solRatioBps,
      deviationBps: portfolioSnapshot.deviationBps,
      effectiveThresholdBps,
    });

    const tradeRecord = await this.trader.executeTrade(
      direction,
      usdAmount,
      portfolioSnapshot,
    );

    // Stamp the BRT date for day-trade guard persistence
    tradeRecord.tradeDateBRT = todayBRT;

    if (tradeRecord.status === 'FILLED' || tradeRecord.status === 'DRY_RUN') {
      this.lastRebalanceTime = now;
      this.lastRebalanceDateBRT = todayBRT;
      this.lastRebalanceDirection = direction;

      if (!this.config.dryRun) {
        tradeRecord.portfolioAfter = await this.portfolio.getPortfolio();
      }

      // ── BRL tracking ─────────────────────────────────────────────────────────
      const usdBrlRate = await fetchUsdBrlRate(this.config.fxApiUrl);
      if (usdBrlRate !== null) {
        const solBrlRate = portfolioSnapshot.solPrice * usdBrlRate;
        const brlSnapshot: BrlSnapshot = {
          usdBrlRate,
          solBrlRate,
          timestamp: new Date().toISOString(),
        };
        tradeRecord.brlSnapshot = brlSnapshot;

        if (direction === 'SELL_SOL' && tradeRecord.solAmountFilled != null) {
          const solSold = tradeRecord.solAmountFilled;
          const usdReceived = tradeRecord.usdAmountFilled ?? usdAmount;
          const realizedGain = this.costBasis.updateAfterSell(
            solSold,
            usdReceived,
            usdBrlRate,
            solBrlRate,
          );
          tradeRecord.realizedGainBrl = realizedGain;

          const ledger = this.costBasis.getLedger();
          const costBasisBrl = ledger.sol.averageCostBrl * solSold;
          const grossProceedsBrl = solSold * solBrlRate;
          const taxEvent = this.tax.buildTaxEvent({
            tradeId: tradeRecord.id,
            tradeDateBRT: todayBRT,
            direction,
            tradedVolumeBrl: grossProceedsBrl,
            tradedVolumeUsd: usdReceived,
            grossProceedsBrl,
            costBasisBrl,
            realizedGainBrl: realizedGain,
          });
          this.tax.appendTaxEvent(taxEvent);

          logger.info('BRL tax event recorded (SELL_SOL)', {
            tradedVolumeBrl: grossProceedsBrl.toFixed(2),
            realizedGainBrl: realizedGain.toFixed(2),
            cumMonthlyVolumeBrl: taxEvent.cumMonthlyVolumeBrl.toFixed(2),
            cumMonthlyGainBrl: taxEvent.cumMonthlyGainBrl.toFixed(2),
            exempt: taxEvent.exempt,
            paymentDeadline: taxEvent.paymentDeadline ?? 'exempt',
          });
        } else if (direction === 'BUY_SOL' && tradeRecord.solAmountFilled != null) {
          const solAcquired = tradeRecord.solAmountFilled;
          const usdSpent = tradeRecord.usdAmountFilled ?? usdAmount;
          this.costBasis.updateAfterBuy(solAcquired, usdSpent, usdBrlRate, solBrlRate);
          tradeRecord.realizedGainBrl = 0; // purchases don't realize capital gains

          // BUY_SOL still counts toward the monthly volume limit
          const tradedVolumeBrl = usdSpent * usdBrlRate;
          const taxEvent = this.tax.buildTaxEvent({
            tradeId: tradeRecord.id,
            tradeDateBRT: todayBRT,
            direction,
            tradedVolumeBrl,
            tradedVolumeUsd: usdSpent,
            grossProceedsBrl: 0,
            costBasisBrl: 0,
            realizedGainBrl: 0,
          });
          this.tax.appendTaxEvent(taxEvent);

          logger.info('BRL tax event recorded (BUY_SOL)', {
            tradedVolumeBrl: tradedVolumeBrl.toFixed(2),
            cumMonthlyVolumeBrl: taxEvent.cumMonthlyVolumeBrl.toFixed(2),
            exempt: taxEvent.exempt,
            paymentDeadline: taxEvent.paymentDeadline ?? 'exempt',
          });
        }
      } else {
        tradeRecord.brlSnapshot = null;
        tradeRecord.realizedGainBrl = null;
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

    // Only write one snapshot per BRT day (skip if already written today)
    const existing = this.history.readSnapshots();
    if (existing.some((s) => s.dateBRT === todayBRT)) return;

    // Best-effort BRL valuation (don't block on failure)
    let totalValueBrl: number | null = null;
    let usdBrlRate: number | null = null;
    try {
      usdBrlRate = await fetchUsdBrlRate(this.config.fxApiUrl);
      if (usdBrlRate !== null) {
        totalValueBrl = portfolio.totalValueUsd * usdBrlRate;
      }
    } catch {
      // non-critical
    }

    const snapshot: PortfolioSnapshot = {
      dateBRT: todayBRT,
      timestamp: new Date().toISOString(),
      totalValueUsd: portfolio.totalValueUsd,
      totalValueBrl,
      solBalance: portfolio.solBalance,
      usdBalance: portfolio.usdBalance,
      solPrice: portfolio.solPrice,
      usdBrlRate,
      solRatioBps: portfolio.solRatioBps,
      effectiveThresholdBps,
      rebalancedToday,
    };
    this.history.appendSnapshot(snapshot);
  }

  shutdown(): void {
    logger.info('Shutting down rebalancer bot...');
    this.isRunning = false;
  }
}
