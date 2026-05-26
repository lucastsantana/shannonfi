import { ExchangeAdapter, PortfolioSnapshot } from '../adapters/types';
import { TradeHistoryService } from './tracker/history';
import { PnlService } from './tracker/pnl';
import { CostBasisService } from './tracker/costbasis';
import { TaxService } from './tracker/tax';
import { VolatilityService } from './tracker/volatility';
import { MetricsService } from './tracker/metrics';
import { logger } from './tracker/logger';
import { shouldRebalance, computeRebalanceTrade } from '../math';
import { Config } from '../config';
import { BR_EFFECTIVE_LIMIT_BRL } from '../constants';

/**
 * BRL-native rebalancing engine. Exchange differences are fully encapsulated in
 * the adapter — this class never touches USD, FX rates, or exchange credentials.
 *
 * Guards (in execution order):
 *   1. minPortfolioValueBrl — skip if portfolio too small
 *   2. drift threshold      — adaptive (MAD-based) or fixed
 *   3. cooldown interval    — minimum seconds between rebalances
 *   4. day-trade guard      — blocks opposite-direction trade on same BRT calendar day
 *   5. exemption cap        — optional monthly volume cap (see Config.neverExceedExemptionLimit)
 *   6. minTradeSizeBrl      — skip if computed trade is too small to be worth executing
 */
export class RebalancerBot {
  private lastRebalanceTime: number;
  private lastRebalanceDateBRT: string | null;
  private lastRebalanceDirection: 'BUY_SOL' | 'SELL_SOL' | null;
  private isRunning = false;

  constructor(
    private adapter: ExchangeAdapter,
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
    logger.info("Shannon's Demon bot starting", {
      exchange: this.config.exchange,
      dryRun: this.config.dryRun,
      useAdaptiveThreshold: this.config.useAdaptiveThreshold,
      thresholdBps: this.config.rebalanceThresholdBps,
      neverExceedExemptionLimit: this.config.neverExceedExemptionLimit,
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
    const portfolio = await this.adapter.getPortfolio();

    logger.info('Portfolio snapshot', {
      exchange: this.config.exchange,
      solBalance: portfolio.solBalance.toFixed(6),
      brlBalance: portfolio.brlBalance.toFixed(2),
      solPriceBrl: portfolio.solPrice.toFixed(2),
      totalValueBrl: portfolio.totalValueBrl.toFixed(2),
      solRatio: (portfolio.solRatioBps / 100).toFixed(2) + '%',
      deviationBps: portfolio.deviationBps,
      ...(portfolio.usdBrlRate != null ? { usdBrlRate: portfolio.usdBrlRate.toFixed(4) } : {}),
    });

    // ── Guard 1: minimum portfolio size ────────────────────────────────────────
    if (portfolio.totalValueBrl < this.config.minPortfolioValueBrl) {
      logger.warn('Portfolio below minimum size, skipping', {
        totalValueBrl: portfolio.totalValueBrl.toFixed(2),
        minPortfolioValueBrl: this.config.minPortfolioValueBrl,
      });
      await this.persistSnapshot(portfolio, false, this.config.rebalanceThresholdBps);
      return;
    }

    // ── Compute effective threshold ─────────────────────────────────────────────
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

    // ── Guard 2: drift threshold ────────────────────────────────────────────────
    if (!shouldRebalance(portfolio.solRatioBps, effectiveThresholdBps)) {
      logger.info('No rebalance needed', {
        deviationBps: portfolio.deviationBps,
        effectiveThresholdBps,
      });
      await this.persistSnapshot(portfolio, false, effectiveThresholdBps);
      return;
    }

    // ── Guard 3: cooldown interval ──────────────────────────────────────────────
    const now = Date.now();
    const secondsSinceLast = (now - this.lastRebalanceTime) / 1000;
    if (secondsSinceLast < this.config.minRebalanceIntervalSeconds) {
      logger.info('Rebalance cooldown active', {
        secondsSinceLast: secondsSinceLast.toFixed(0),
        minRebalanceIntervalSeconds: this.config.minRebalanceIntervalSeconds,
      });
      await this.persistSnapshot(portfolio, false, effectiveThresholdBps);
      return;
    }

    // ── Compute trade (needed before day-trade guard) ───────────────────────────
    let { direction, brlAmount } = computeRebalanceTrade(
      portfolio.solValueBrl,
      portfolio.brlBalance,
    );

    // ── Guard 4: day-trade guard ────────────────────────────────────────────────
    // Blocks opposite-direction trades on the same BRT calendar day to avoid
    // wash-trade tax complications. Same-direction and different-day trades pass.
    const todayBRT = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Sao_Paulo',
    });
    const isOpposite =
      this.lastRebalanceDirection !== null && this.lastRebalanceDirection !== direction;
    if (this.lastRebalanceDateBRT === todayBRT && isOpposite) {
      logger.info('Day-trade guard: opposite-direction trade blocked (BRT)', {
        date: todayBRT,
        proposedDirection: direction,
        priorDirection: this.lastRebalanceDirection,
      });
      await this.persistSnapshot(portfolio, false, effectiveThresholdBps);
      return;
    }

    // ── Guard 5: exemption / volume cap ────────────────────────────────────────
    if (this.config.neverExceedExemptionLimit) {
      const monthBRT = todayBRT.slice(0, 7);

      // Mercado Bitcoin (domestic): only SELL proceeds count toward the R$35k limit.
      // Coinbase (foreign): both directions tracked for the discretionary volume cap.
      const volumeSoFar =
        this.config.exchange === 'mercadobitcoin' && direction === 'BUY_SOL'
          ? null  // BUY on MB is never capped
          : this.config.exchange === 'mercadobitcoin'
            ? this.tax.getMonthlySalesBrl(monthBRT)
            : this.tax.getMonthlyVolumeBrl(monthBRT);

      if (volumeSoFar !== null) {
        const remaining = Math.max(0, BR_EFFECTIVE_LIMIT_BRL - volumeSoFar);
        if (brlAmount > remaining) {
          if (remaining < this.config.minTradeSizeBrl) {
            logger.info('Monthly volume cap reached — skipping trade', {
              direction,
              volumeSoFar: volumeSoFar.toFixed(2),
              remaining: remaining.toFixed(2),
              monthBRT,
            });
            await this.persistSnapshot(portfolio, false, effectiveThresholdBps);
            return;
          }
          logger.info('Capping trade to stay within monthly volume limit', {
            direction,
            original: brlAmount.toFixed(2),
            capped: remaining.toFixed(2),
            monthBRT,
          });
          brlAmount = remaining;
        }
      }
    }

    // ── Guard 6: minimum trade size ─────────────────────────────────────────────
    if (brlAmount < this.config.minTradeSizeBrl) {
      logger.info('Trade amount below minimum', {
        brlAmount: brlAmount.toFixed(2),
        minTradeSizeBrl: this.config.minTradeSizeBrl,
      });
      await this.persistSnapshot(portfolio, false, effectiveThresholdBps);
      return;
    }

    logger.info('Rebalance triggered', {
      direction,
      brlAmount: brlAmount.toFixed(2),
      solRatioBps: portfolio.solRatioBps,
      effectiveThresholdBps,
    });

    const tradeRecord = await this.adapter.executeTrade(direction, brlAmount, portfolio);
    tradeRecord.tradeDateBRT = todayBRT;

    if (tradeRecord.status === 'FILLED' || tradeRecord.status === 'DRY_RUN') {
      this.lastRebalanceTime = now;
      this.lastRebalanceDateBRT = todayBRT;
      this.lastRebalanceDirection = direction;

      if (!this.config.dryRun) {
        tradeRecord.portfolioAfter = await this.adapter.getPortfolio();
      }

      // ── Cost basis and tax recording ──────────────────────────────────────────
      if (direction === 'SELL_SOL' && tradeRecord.solAmountFilled != null) {
        const solSold = tradeRecord.solAmountFilled;
        const brlReceived = tradeRecord.brlAmountFilled ?? brlAmount;
        const ledger = this.costBasis.getLedger();
        const costBasisBrl = ledger.sol.averageCostBrl * solSold;
        const realizedGainBrl = this.costBasis.updateAfterSell(solSold, brlReceived);
        tradeRecord.realizedGainBrl = realizedGainBrl;

        const taxEvent = this.tax.buildTaxEvent({
          tradeId: tradeRecord.id,
          tradeDateBRT: todayBRT,
          direction,
          tradedVolumeBrl: brlReceived,
          grossProceedsBrl: brlReceived,
          costBasisBrl,
          realizedGainBrl,
          exchange: tradeRecord.exchange,
        });
        this.tax.appendTaxEvent(taxEvent);

        logger.info('Tax event recorded (SELL_SOL)', {
          tradedVolumeBrl: brlReceived.toFixed(2),
          realizedGainBrl: realizedGainBrl.toFixed(2),
          cumMonthlySalesBrl: taxEvent.cumMonthlySalesBrl.toFixed(2),
          exempt: taxEvent.exempt,
          paymentDeadline: taxEvent.paymentDeadline ?? 'exempt',
        });

      } else if (direction === 'BUY_SOL' && tradeRecord.solAmountFilled != null) {
        const solAcquired = tradeRecord.solAmountFilled;
        const brlSpent = tradeRecord.brlAmountFilled ?? brlAmount;
        this.costBasis.updateAfterBuy(solAcquired, brlSpent);
        tradeRecord.realizedGainBrl = 0;

        const taxEvent = this.tax.buildTaxEvent({
          tradeId: tradeRecord.id,
          tradeDateBRT: todayBRT,
          direction,
          tradedVolumeBrl: this.config.exchange === 'coinbase' ? brlSpent : 0,
          grossProceedsBrl: 0,
          costBasisBrl: 0,
          realizedGainBrl: 0,
          exchange: tradeRecord.exchange,
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
    await this.persistSnapshot(portfolio, true, effectiveThresholdBps);
  }

  private async persistSnapshot(
    portfolio: Awaited<ReturnType<ExchangeAdapter['getPortfolio']>>,
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
      exchange: this.config.exchange,
      ...(portfolio.usdBrlRate != null ? { usdBrlRate: portfolio.usdBrlRate } : {}),
    };
    this.history.appendSnapshot(snapshot);
  }

  shutdown(): void {
    logger.info('Shutting down rebalancer...');
    this.isRunning = false;
  }
}
