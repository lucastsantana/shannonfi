import { ExchangeAdapter, Portfolio, PortfolioSnapshot } from '../adapters/types';
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

// Small delay between sequential API calls during a rebalance execution,
// to avoid hitting MB's 60 req/60s limit when multiple calls fire back-to-back.
const INTER_REQUEST_DELAY_MS = 500;

/**
 * BRL-native rebalancing engine. Exchange differences are fully encapsulated in
 * the adapter — this class never touches USD, FX rates, or exchange credentials.
 *
 * Request budget per cycle (Mercado Bitcoin, no rebalance):
 *   - getPrice()  → 1 public candle request (no auth)
 *   - All guards pass cheaply via in-memory state (no further requests)
 *   Total: 1 request per cycle
 *
 * Request budget per cycle (Mercado Bitcoin, rebalance triggered):
 *   - getPrice()       → 1 public candle request
 *   - getPortfolio()   → 1 auth request (balances; price reused)
 *   - getCandles()     → 1 request (volatility; cached after first call each day)
 *   - createOrder()    → 1 request
 *   - pollOrderFill()  → up to 10 requests at 3s intervals (30s max)
 *   - getPortfolio()   → 1 request (post-trade snapshot)
 *   Total: ~15 requests worst-case, well within 60 req/60s
 *
 * Guards (in execution order):
 *   1. drift threshold  — checked against price only; no balance fetch needed
 *   2. cooldown         — in-memory, zero cost
 *   3. day-trade guard  — in-memory, zero cost
 *   4. minPortfolioValueBrl — requires balance fetch (only reached if drift exceeded)
 *   5. exemption cap    — in-memory tax ledger, zero cost
 *   6. minTradeSizeBrl  — computed from balances already fetched
 */
export class RebalancerBot {
  private lastRebalanceTime: number;
  private lastRebalanceDateBRT: string | null;
  private lastRebalanceDirection: 'BUY_BASE' | 'SELL_BASE' | null;
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
      pollIntervalSeconds: this.config.pollIntervalSeconds,
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
    const todayBRT = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Sao_Paulo',
    });

    // ── Step 1: fetch price only — cheapest possible request ───────────────────
    const basePrice = await this.adapter.getPrice();
    logger.info('Price check', {
      exchange: this.config.exchange,
      basePriceBrl: basePrice.toFixed(2),
    });

    // ── Step 2: get threshold (cached daily — zero cost after first call today) ─
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

    // ── Step 3: estimate drift from price alone ────────────────────────────────
    // We don't have balances yet — use price to do a cheap pre-check based on
    // the last known portfolio ratio. If we've never rebalanced, skip the
    // pre-check and proceed to fetch balances.
    //
    // This is intentionally an approximation: the true ratio requires balances.
    // Its only purpose is to save the balance fetch on most cycles.
    const lastTrade = this.history.readTrades().filter(
      (t) => t.status === 'FILLED' || t.status === 'DRY_RUN',
    ).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()).pop();

    if (lastTrade?.portfolioAfter) {
      const prev = lastTrade.portfolioAfter;
      const prevPrice = prev.basePrice;
      if (prevPrice > 0) {
        // Estimate current base value using price drift; cash is unchanged
        const priceRatio = basePrice / prevPrice;
        const estBaseValueBrl = prev.baseValueBrl * priceRatio;

        if (!shouldRebalance(estBaseValueBrl, prev.brlBalance, effectiveThresholdBps)) {
          logger.info('No rebalance needed (price-only estimate)', {
            estBaseValueBrl: estBaseValueBrl.toFixed(2),
            brlBalance: prev.brlBalance.toFixed(2),
            effectiveThresholdBps,
          });
          return;
        }
        logger.debug('Price estimate suggests rebalance — fetching balances', {
          estBaseValueBrl: estBaseValueBrl.toFixed(2),
        });
      }
    }

    // ── Step 4: cooldown check — in-memory, zero cost ─────────────────────────
    const now = Date.now();
    const secondsSinceLast = (now - this.lastRebalanceTime) / 1000;
    if (secondsSinceLast < this.config.minRebalanceIntervalSeconds) {
      logger.info('Rebalance cooldown active', {
        secondsSinceLast: secondsSinceLast.toFixed(0),
        minRebalanceIntervalSeconds: this.config.minRebalanceIntervalSeconds,
      });
      return;
    }

    // ── Step 5: day-trade guard pre-check (direction requires balances, but we  ─
    // can still skip the balance fetch if both directions would be blocked today)
    // Only a same-day opposite trade blocks — if lastRebalanceDirection is null
    // or it was a different day, no guard applies regardless of direction.
    const allDirectionsBlocked =
      this.lastRebalanceDateBRT === todayBRT &&
      this.lastRebalanceDirection !== null;

    if (allDirectionsBlocked) {
      // Both BUY and SELL are not necessarily blocked — only the opposite direction is.
      // We can't know the direction without balances, so proceed to fetch them.
      // The guard is re-evaluated below after we know direction.
    }

    // ── Step 6: fetch balances now that we're committed to possibly rebalancing ─
    await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
    const portfolio = await this.adapter.getPortfolio(basePrice);

    logger.info('Portfolio snapshot', {
      exchange: this.config.exchange,
      baseBalance: portfolio.baseBalance.toFixed(6),
      brlBalance: portfolio.brlBalance.toFixed(2),
      basePriceBrl: portfolio.basePrice.toFixed(2),
      totalValueBrl: portfolio.totalValueBrl.toFixed(2),
      baseRatio: (portfolio.baseRatioBps / 100).toFixed(2) + '%',
      deviationBps: portfolio.deviationBps,
    });

    // ── Guard: minimum portfolio size ──────────────────────────────────────────
    if (portfolio.totalValueBrl < this.config.minPortfolioValueBrl) {
      logger.warn('Portfolio below minimum size, skipping', {
        totalValueBrl: portfolio.totalValueBrl.toFixed(2),
        minPortfolioValueBrl: this.config.minPortfolioValueBrl,
      });
      await this.persistSnapshot(portfolio, false, effectiveThresholdBps);
      return;
    }

    // ── Guard: drift threshold (precise, with actual balances) ─────────────────
    if (!shouldRebalance(portfolio.baseValueBrl, portfolio.brlBalance, effectiveThresholdBps)) {
      logger.info('No rebalance needed', {
        deviationBps: portfolio.deviationBps,
        effectiveThresholdBps,
      });
      await this.persistSnapshot(portfolio, false, effectiveThresholdBps);
      return;
    }

    // ── Compute trade direction and amount ─────────────────────────────────────
    let { direction, brlAmount } = computeRebalanceTrade(
      portfolio.baseValueBrl,
      portfolio.brlBalance,
    );

    // ── Guard: day-trade guard ─────────────────────────────────────────────────
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

    // ── Guard: exemption / volume cap ─────────────────────────────────────────
    // Lei 9.250/1995 Art. 21: only SELL proceeds count toward the R$35k exemption limit
    if (this.config.neverExceedExemptionLimit && direction === 'SELL_BASE') {
      const monthBRT = todayBRT.slice(0, 7);
      const volumeSoFar = this.tax.getMonthlySalesBrl(monthBRT);

      {
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

    // ── Guard: minimum trade size ──────────────────────────────────────────────
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
      baseRatioBps: portfolio.baseRatioBps,
      effectiveThresholdBps,
    });

    // Small delay before placing the order to avoid request bursts
    await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
    const tradeRecord = await this.adapter.executeTrade(direction, brlAmount, portfolio);
    tradeRecord.tradeDateBRT = todayBRT;

    // Declared here so it's in scope after the status block, for FK-ordered persistence.
    let pendingTaxEvent: ReturnType<TaxService['buildTaxEvent']> | null = null;

    if (tradeRecord.status === 'FILLED' || tradeRecord.status === 'DRY_RUN') {
      this.lastRebalanceTime = now;
      this.lastRebalanceDateBRT = todayBRT;
      this.lastRebalanceDirection = direction;

      if (!this.config.dryRun) {
        await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
        tradeRecord.portfolioAfter = await this.adapter.getPortfolio();
      }

      // ── Cost basis and tax recording ────────────────────────────────────────
      // Build tax event in memory first (so realizedGainBrl is set on tradeRecord),
      // then persist trade before tax event (tax_events.trade_id FK → trades.id).

      if (direction === 'SELL_BASE' && tradeRecord.baseAmountFilled != null) {
        const baseSold = tradeRecord.baseAmountFilled;
        const brlReceived = tradeRecord.brlAmountFilled ?? brlAmount;
        const ledger = this.costBasis.getLedger();
        const costBasisBrl = ledger.base.averageCostBrl * baseSold;
        const realizedGainBrl = this.costBasis.updateAfterSell(baseSold, brlReceived);
        tradeRecord.realizedGainBrl = realizedGainBrl;

        pendingTaxEvent = this.tax.buildTaxEvent({
          tradeId: tradeRecord.id,
          tradeDateBRT: todayBRT,
          direction,
          tradedVolumeBrl: brlReceived,
          grossProceedsBrl: brlReceived,
          costBasisBrl,
          realizedGainBrl,
          exchange: tradeRecord.exchange,
        });

      } else if (direction === 'BUY_BASE' && tradeRecord.baseAmountFilled != null) {
        const baseAcquired = tradeRecord.baseAmountFilled;
        const brlSpent = tradeRecord.brlAmountFilled ?? brlAmount;
        this.costBasis.updateAfterBuy(baseAcquired, brlSpent);
        tradeRecord.realizedGainBrl = 0;

        pendingTaxEvent = this.tax.buildTaxEvent({
          tradeId: tradeRecord.id,
          tradeDateBRT: todayBRT,
          direction,
          tradedVolumeBrl: 0,
          grossProceedsBrl: 0,
          costBasisBrl: 0,
          realizedGainBrl: 0,
          exchange: tradeRecord.exchange,
        });
      }
    }

    // Persist trade first so tax_events FK constraint is satisfied
    await this.history.appendTrade(tradeRecord);

    if (pendingTaxEvent) {
      this.tax.appendTaxEvent(pendingTaxEvent);
      if (tradeRecord.direction === 'SELL_BASE') {
        logger.info('Tax event recorded (SELL_BASE)', {
          tradedVolumeBrl: pendingTaxEvent.tradedVolumeBrl.toFixed(2),
          realizedGainBrl: pendingTaxEvent.realizedGainBrl.toFixed(2),
          cumMonthlySalesBrl: pendingTaxEvent.cumMonthlySalesBrl.toFixed(2),
          exempt: pendingTaxEvent.exempt,
          paymentDeadline: pendingTaxEvent.paymentDeadline ?? 'exempt',
        });
      } else {
        logger.info('Cost basis updated (BUY_BASE)', {
          baseAcquired: (tradeRecord.baseAmountFilled ?? 0).toFixed(6),
          brlSpent: (tradeRecord.brlAmountFilled ?? brlAmount).toFixed(2),
        });
      }
    }
    await this.pnl.logRebalance(tradeRecord);
    await this.persistSnapshot(portfolio, true, effectiveThresholdBps);
  }

  private async persistSnapshot(
    portfolio: Portfolio,
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
      baseBalance: portfolio.baseBalance,
      brlBalance: portfolio.brlBalance,
      basePrice: portfolio.basePrice,
      baseRatioBps: portfolio.baseRatioBps,
      effectiveThresholdBps,
      rebalancedToday,
      exchange: this.config.exchange,
    };
    this.history.appendSnapshot(snapshot);
  }

  shutdown(): void {
    logger.info('Shutting down rebalancer...');
    this.isRunning = false;
  }
}
