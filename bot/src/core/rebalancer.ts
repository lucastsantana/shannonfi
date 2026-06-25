import { ExchangeAdapter, Portfolio, PortfolioSnapshot } from '../adapters/types';
import { TradeHistoryService } from './tracker/history';
import { PnlService } from './tracker/pnl';
import { CostBasisService } from './tracker/costbasis';
import { TaxService } from './tracker/tax';
import { VolatilityService } from './tracker/volatility';
import { MetricsService } from './tracker/metrics';
import { logger } from './tracker/logger';
import { shouldRebalance, computeRebalanceTrade, computeBaseRatioBps, computeDeviationBps, computePortfolioAfterFill } from '../math';
import { Config } from '../config';
import { BR_EFFECTIVE_LIMIT_BRL } from '../constants';
import { TelegramService } from '../publishers/telegram';
import { DailyDigestService } from '../publishers/daily-digest';
import { getDb, getDbConfig, setDbConfig } from './tracker/db';
import { runAssetScan } from '../scanner/run-scan';
import { AssetScanner, ScannerAdapter } from '../scanner/scanner';
import { AssetCandidate, ScanResult } from '../scanner/types';

// Small delay between sequential API calls during a rebalance execution,
// to avoid hitting MB's 60 req/60s limit when multiple calls fire back-to-back.
const INTER_REQUEST_DELAY_MS = 500;

interface PendingRotationRow {
  id: number;
  from_symbol: string;
  to_symbol: string;
  approved_at: string;
  status: string;
  scan_id: number | null;
}

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
  private telegram: TelegramService | null = null;
  private dailyDigest: DailyDigestService | null = null;

  constructor(
    private adapter: ExchangeAdapter,
    private history: TradeHistoryService,
    private pnl: PnlService,
    private costBasis: CostBasisService,
    private tax: TaxService,
    private volatility: VolatilityService,
    private metrics: MetricsService,
    private config: Config,
    // Builds a fresh ExchangeAdapter for a given symbol on this same exchange. Only needed
    // to support live asset rotation (swapping to a new symbol mid-process, without a
    // restart) — kept as a factory rather than importing adapter classes directly here,
    // so RebalancerBot stays exchange-agnostic. Optional for callers that don't use rotation.
    private adapterFactory?: (symbol: string) => ExchangeAdapter,
  ) {
    this.lastRebalanceTime = history.getLastRebalanceTime();
    const { dateBRT, direction } = history.getLastRebalanceInfo();
    this.lastRebalanceDateBRT = dateBRT;
    this.lastRebalanceDirection = direction;

    if (this.config.telegram) {
      try {
        this.telegram = new TelegramService(this.config.telegram);
        logger.info('Telegram notifications enabled');

        const baseAsset = this.config.symbol.split('-')[0]!;
        this.dailyDigest = new DailyDigestService(this.history, this.telegram, baseAsset);
        logger.info('Daily digest enabled');
      } catch (err) {
        logger.warn('Telegram notifications disabled', {
          error: (err as Error).message,
        });
      }
    }

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
    // Lei 9.250/1995 Art. 21's R$35k/month exemption applies to a Brazilian tax
    // resident's aggregate crypto sales "no Brasil ou no exterior" (regardless of
    // exchange) — not domestic-only, despite this guard historically only existing
    // on the mercadobitcoin branch. Extended to coinbase (defaulted true there,
    // since it's a brand-new instance with no existing behavior to preserve).
    // Binance is deliberately left as `false` here unchanged — that's a real-money
    // instance already running; revisiting it is a separate decision, not bundled
    // into this change. See docs/coinbase-adapter-plan.md, open question 5.
    const neverExceed = this.config.exchange === 'mercadobitcoin' || this.config.exchange === 'coinbase'
      ? this.config.neverExceedExemptionLimit
      : false;
    const baseAsset = this.config.symbol.split('-')[0]!;
    const bootstrapPending = this.config.bootstrapViaScan === true && this.history.readTrades().length === 0;

    logger.info("Shannon's Demon bot starting", {
      exchange: this.config.exchange,
      symbol: bootstrapPending ? 'pending (bootstrapViaScan — no asset selected yet)' : this.config.symbol,
      dryRun: this.config.dryRun,
      useAdaptiveThreshold: this.config.useAdaptiveThreshold,
      neverExceedExemptionLimit: neverExceed,
      enableDayTradeSafeguard: this.config.enableDayTradeSafeguard,
      pollIntervalSeconds: this.config.pollIntervalSeconds,
    });

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    // Align polling to system clock boundaries (e.g., 9:30, 9:35, 9:40 for 5-min interval)
    const pollIntervalMs = this.config.pollIntervalSeconds * 1_000;
    const now = Date.now();
    const msIntoBoundary = now % pollIntervalMs;
    const msUntilNextBoundary = msIntoBoundary === 0 ? 0 : pollIntervalMs - msIntoBoundary;

    if (msUntilNextBoundary > 0) {
      logger.info('Waiting for next clock-aligned poll boundary', {
        waitMs: msUntilNextBoundary,
        nextPollInSeconds: Math.ceil(msUntilNextBoundary / 1_000),
      });
      await new Promise((r) => setTimeout(r, msUntilNextBoundary));
    }

    while (this.isRunning) {
      try {
        await this.checkAndRebalance();
      } catch (err) {
        logger.error('Error in rebalance cycle', { error: (err as Error).message });
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  async checkAndRebalance(): Promise<void> {
    const todayBRT = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Sao_Paulo',
    });

    // ── Autonomous instances decide for themselves first (may insert a freshly
    // APPROVED pending_rotation row) — then the existing execution check immediately
    // below picks it up and runs it the same cycle, no extra poll-interval delay. ──
    await this.checkAndRunAutonomousRotationDecision();

    // ── Check for an approved asset rotation before anything else ────────────────
    // Cheap (one indexed SELECT) on the common case where nothing is pending. If a
    // rotation executes, this.adapter/this.config.symbol/etc. are swapped in place and
    // every check below naturally proceeds against the new asset for the rest of this cycle.
    await this.checkAndExecuteRotation();

    // ── Bootstrap gate: brand-new instances configured to pick their first asset
    // via the scanner, rather than trading the YAML's default `symbol` immediately ──
    if (await this.checkBootstrapGate()) {
      return;
    }

    // ── Check if it's time to send daily digest ──────────────────────────────────
    if (this.dailyDigest) {
      await this.dailyDigest.sendDailyDigestIfScheduled();
    }

    // ── Step 1: fetch price only — cheapest possible request ───────────────────
    const basePrice = await this.adapter.getPrice();

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

    // Estimate current portfolio state for logging
    let logMetadata: any = {
      exchange: this.config.exchange,
      basePriceBrl: basePrice.toFixed(2),
    };

    const lastTrade = this.history.readTrades().filter(
      (t) => t.status === 'FILLED' || t.status === 'DRY_RUN',
    ).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()).pop();

    if (lastTrade?.portfolioAfter) {
      const prev = lastTrade.portfolioAfter;
      const prevPrice = prev.basePrice;
      if (prevPrice > 0) {
        const priceRatio = basePrice / prevPrice;
        const estBaseValueBrl = prev.baseValueBrl * priceRatio;
        const estTotalBrl = estBaseValueBrl + prev.brlBalance;
        const estBaseRatioBps = computeBaseRatioBps(estBaseValueBrl, estTotalBrl);
        // Same relative-ratio formula as the actual trigger (shares its zero-guard,
        // so a fully one-sided portfolio reports 0 BPS rather than Infinity).
        const estDeviationBps = computeDeviationBps(estBaseValueBrl, prev.brlBalance);

        // Get acquisition price for reference (cost basis)
        const costBasisLedger = this.costBasis.getLedger();
        const acquisitionPrice = costBasisLedger.base.averageCostBrl > 0 ? costBasisLedger.base.averageCostBrl : prevPrice;

        logMetadata.baseAsset = this.config.symbol.split('-')[0];
        logMetadata.baseBalance = prev.baseBalance.toFixed(6);
        logMetadata.baseAllocationPct = (estBaseRatioBps / 100).toFixed(2);
        logMetadata.brlBalance = prev.brlBalance.toFixed(2);
        logMetadata.brlAllocationPct = ((10000 - estBaseRatioBps) / 100).toFixed(2);
        logMetadata.deviationBps = estDeviationBps;
        logMetadata.portfolioValueBrl = estTotalBrl.toFixed(2);
        logMetadata.thresholdBps = effectiveThresholdBps;
        logMetadata.acquisitionPrice = acquisitionPrice.toFixed(2);

        // Trigger prices using the same relative-difference formula as shouldRebalance:
        // SELL fires when estBaseValue / brlBalance = 1 + T  →  price = prevPrice * brlBalance*(1+T) / prevBaseValue
        // BUY  fires when brlBalance / estBaseValue  = 1 + T  →  price = prevPrice * brlBalance / (prevBaseValue*(1+T))
        // Undefined (no base held yet, e.g. right after a rotation liquidation) — skip rather than divide by zero.
        if (prev.baseValueBrl > 0) {
          const thresholdRatio = effectiveThresholdBps / 10000;
          const triggerPriceUp = (prevPrice * prev.brlBalance * (1 + thresholdRatio)) / prev.baseValueBrl;
          const triggerPriceDown = (prevPrice * prev.brlBalance) / (prev.baseValueBrl * (1 + thresholdRatio));
          logMetadata.triggerPriceUpBrl = triggerPriceUp.toFixed(2);
          logMetadata.triggerPriceDownBrl = triggerPriceDown.toFixed(2);
        }
      }
    }

    logger.info('Price check', logMetadata);

    // ── Step 3: cooldown check — in-memory, zero cost ─────────────────────────
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
      baseAsset: this.config.symbol.split('-')[0],
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
    if (this.config.enableDayTradeSafeguard) {
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
    }

    // ── Guard: exemption / volume cap ─────────────────────────────────────────
    // Lei 9.250/1995 Art. 21: only SELL proceeds count toward the R$35k exemption limit
    // This guard only applies to Mercado Bitcoin (domestic exchange); Binance trades are always taxable
    // Lei 9.250/1995 Art. 21's R$35k/month exemption applies to a Brazilian tax
    // resident's aggregate crypto sales "no Brasil ou no exterior" (regardless of
    // exchange) — not domestic-only, despite this guard historically only existing
    // on the mercadobitcoin branch. Extended to coinbase (defaulted true there,
    // since it's a brand-new instance with no existing behavior to preserve).
    // Binance is deliberately left as `false` here unchanged — that's a real-money
    // instance already running; revisiting it is a separate decision, not bundled
    // into this change. See docs/coinbase-adapter-plan.md, open question 5.
    const neverExceed = this.config.exchange === 'mercadobitcoin' || this.config.exchange === 'coinbase'
      ? this.config.neverExceedExemptionLimit
      : false;
    if (neverExceed && direction === 'SELL_BASE') {
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
      baseAsset: this.config.symbol.split('-')[0],
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

      if (!this.config.dryRun && tradeRecord.baseAmountFilled != null && tradeRecord.fillPrice != null) {
        tradeRecord.portfolioAfter = computePortfolioAfterFill(
          portfolio,
          direction,
          tradeRecord.baseAmountFilled,
          tradeRecord.brlAmountFilled ?? brlAmount,
          tradeRecord.feeBrl ?? 0,
          tradeRecord.fillPrice,
        );
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

    // Wrap all three DB writes (cost_basis, trades, tax_events) in a single transaction
    // to ensure atomicity. Telegram notification is sent after the transaction commits.
    const db = getDb(this.config.dbPath);
    const txn = db.transaction(() => {
      this.history.appendTrade(tradeRecord);
      if (pendingTaxEvent) {
        this.tax.appendTaxEvent(pendingTaxEvent);
      }
    });

    try {
      txn();
    } catch (err) {
      logger.error('Failed to persist trade to database (transaction rolled back)', {
        tradeId: tradeRecord.id,
        error: (err as Error).message,
      });
      throw err;
    }

    // Send Telegram notification if configured (outside transaction since it's async and external)
    if (this.telegram && (tradeRecord.status === 'FILLED' || tradeRecord.status === 'DRY_RUN')) {
      const baseAsset = this.config.symbol.split('-')[0]!;
      const before: { baseBalance: number; brlBalance: number; basePrice: number; baseValueBrl: number; baseRatioBps: number; deviationBps: number } = {
        baseBalance: portfolio.baseBalance,
        brlBalance: portfolio.brlBalance,
        basePrice: portfolio.basePrice,
        baseValueBrl: portfolio.baseValueBrl,
        baseRatioBps: portfolio.baseRatioBps,
        deviationBps: portfolio.deviationBps,
      };

      const after: { baseBalance: number; brlBalance: number; basePrice: number; baseValueBrl: number; baseRatioBps: number; deviationBps: number } = {
        baseBalance: tradeRecord.portfolioAfter?.baseBalance ?? portfolio.baseBalance,
        brlBalance: tradeRecord.portfolioAfter?.brlBalance ?? portfolio.brlBalance,
        basePrice: tradeRecord.portfolioAfter?.basePrice ?? portfolio.basePrice,
        baseValueBrl: tradeRecord.portfolioAfter?.baseValueBrl ?? portfolio.baseValueBrl,
        baseRatioBps: tradeRecord.portfolioAfter?.baseRatioBps ?? portfolio.baseRatioBps,
        deviationBps: tradeRecord.portfolioAfter?.deviationBps ?? portfolio.deviationBps,
      };

      await this.telegram.sendTradeNotification(tradeRecord, baseAsset, before, after);
    }

    if (pendingTaxEvent) {
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
          baseAsset: this.config.symbol.split('-')[0],
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
      baseAsset: this.config.symbol.split('-')[0]!,
    };
    this.history.appendSnapshot(snapshot);
  }

  /**
   * For instances with `bootstrapViaScan: true` (see config.ts) and zero trade
   * history: never place a trade on the YAML's default `symbol` — instead trigger
   * the same scanner+Telegram flow used for ongoing rotation, and wait for a human
   * to approve a candidate via the existing pending_rotation mechanism (handled by
   * checkAndExecuteRotation() above, which runs every cycle regardless of this
   * gate). Once that rotation executes, readTrades() becomes non-empty and this
   * gate stops firing — there's no separate "bootstrap complete" flag to manage.
   * Returns true if the gate is active and the rest of this cycle should be skipped.
   *
   * Instances with `autonomousWeeklyRotation: true` never reach the Telegram-wait
   * logic below at all — checkAndRunAutonomousRotationDecision() (called earlier in
   * checkAndRebalance()) owns their entire bootstrap decision, including picking
   * and approving their first asset immediately with no human step. By the time
   * this method runs, that decision has already produced a trade (so the
   * zero-trade-history check below is naturally false) — this early return just
   * makes the "no Telegram for autonomous instances" guarantee explicit rather than
   * incidental, for the case where no candidate qualified yet and history is still empty.
   */
  private async checkBootstrapGate(): Promise<boolean> {
    if (!this.config.bootstrapViaScan) return false;
    if (this.config.autonomousWeeklyRotation) return false;
    if (this.history.readTrades().length > 0) return false;

    const db = getDb(this.config.dbPath);
    const { c: scanCount } = db.prepare('SELECT COUNT(*) as c FROM scans').get() as { c: number };

    if (scanCount === 0) {
      logger.info('Bootstrap: no trade history yet — running initial scan before any trade', {
        yamlPlaceholderSymbol: this.config.symbol,
      });
      try {
        await runAssetScan({
          adapter: this.adapter as unknown as ScannerAdapter,
          db,
          dbPath: this.config.dbPath,
          exchange: this.config.exchange,
          activeSymbol: this.config.symbol,
          telegram: this.telegram,
          dryRun: this.config.dryRun,
        });
      } catch (err) {
        logger.error('Bootstrap scan failed', { error: (err as Error).message });
      }
    } else {
      logger.info('Bootstrap: awaiting scan approval via Telegram before placing any trade', {
        yamlPlaceholderSymbol: this.config.symbol,
      });
    }
    return true;
  }

  /** Calendar date (YYYY-MM-DD, BRT) of the most recent Monday at or before now. */
  private mostRecentMondayBRT(): string {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    // todayBRT is a plain calendar date (no time component) — parsing it as UTC
    // midnight and using getUTCDay()/setUTCDate() below treats it as a date-only
    // value throughout, so this never gets re-interpreted in a different timezone.
    const dow = new Date(`${todayBRT}T00:00:00Z`).getUTCDay(); // 0=Sun .. 6=Sat
    const daysSinceMonday = (dow + 6) % 7; // Monday=0, Sunday=6
    const monday = new Date(`${todayBRT}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
    return monday.toISOString().slice(0, 10);
  }

  /**
   * For instances with `autonomousWeeklyRotation: true` (see config.ts): decides
   * and approves asset switches with no human in the loop, replacing the Telegram
   * approve/reject flow entirely for this instance. Two cases:
   *
   *   - Bootstrap (zero trade history): picks the first asset immediately — no
   *     reason to make a freshly-deployed, all-cash instance wait up to a week.
   *   - Ongoing: re-evaluates once per week, right after midnight Sunday→Monday
   *     BRT (tracked via the `autonomous_rotation_last_week_brt` DB config key —
   *     see mostRecentMondayBRT() — so it fires exactly once per week regardless
   *     of poll interval, not on a separate timer of its own).
   *
   * Either way, if a switch is warranted this inserts an already-APPROVED
   * pending_rotation row; checkAndExecuteRotation() (called immediately after this
   * in checkAndRebalance()) is what actually executes it — this method only ever
   * decides, never touches the adapter or places a trade itself.
   */
  private async checkAndRunAutonomousRotationDecision(): Promise<void> {
    if (!this.config.autonomousWeeklyRotation) return;

    const isBootstrap = this.history.readTrades().length === 0;
    const mostRecentMonday = this.mostRecentMondayBRT();

    if (!isBootstrap) {
      const lastWeek = getDbConfig('autonomous_rotation_last_week_brt', undefined, this.config.dbPath);
      if (lastWeek === mostRecentMonday) return; // already decided this week
    }

    logger.info(
      isBootstrap
        ? 'Autonomous bootstrap: selecting first asset via scan (no Telegram wait)'
        : 'Autonomous weekly rotation: running scheduled review',
      isBootstrap ? { yamlPlaceholderSymbol: this.config.symbol } : { symbol: this.config.symbol },
    );

    let scanResult: ScanResult;
    try {
      const db = getDb(this.config.dbPath);
      const scanner = new AssetScanner(this.adapter as unknown as ScannerAdapter, db, this.config.dbPath);
      scanResult = await scanner.scan({
        windowDays: 30,
        minVolumeBrl: 5_000,
        minDataPoints: 10,
        returnFloor: -0.20,
        topN: 15,
        minTrendSlope: -0.0005,
        liquidityFullWeightBrl: 50_000,
        quoteCurrency: this.config.symbol.split('-')[1]!,
      });
    } catch (err) {
      logger.error('Autonomous rotation scan failed — will retry next cycle', {
        error: (err as Error).message,
      });
      return;
    }

    // Mark this week as decided regardless of outcome, so a "no qualifying
    // candidate" or "keep current asset" result doesn't re-scan every cycle until
    // the next Monday boundary.
    if (!isBootstrap) {
      setDbConfig('autonomous_rotation_last_week_brt', mostRecentMonday, this.config.dbPath);
    }

    const top = scanResult.candidates[0];
    if (!top) {
      logger.info('Autonomous rotation: no qualifying candidate this run', {
        totalScanned: scanResult.totalScanned,
      });
      await this.notifyAutonomousDecision(isBootstrap, null, null, null);
      return;
    }

    const currentBaseAsset = this.config.symbol.split('-')[0]!;

    if (!isBootstrap) {
      const currentCandidate = scanResult.candidates.find((c) => c.baseAsset === currentBaseAsset);
      const baselineScore = currentCandidate?.score ?? 0;
      const isSameAsset = top.baseAsset === currentBaseAsset;
      // baselineScore is 0 when the current asset didn't even qualify this week
      // (filtered by volume/trend/return floor) — any positive score beats that
      // trivially, so the margin check only applies once there's a real baseline.
      const marginOk =
        baselineScore <= 0 ? top.score > 0 : top.score >= baselineScore * (1 + this.config.autonomousRotationMinMarginPct);

      if (isSameAsset || !marginOk) {
        logger.info('Autonomous rotation: keeping current asset', {
          currentBaseAsset,
          topBaseAsset: top.baseAsset,
          topScore: top.score.toFixed(4),
          baselineScore: baselineScore.toFixed(4),
        });
        await this.notifyAutonomousDecision(false, top, baselineScore, null);
        return;
      }
    }

    const quoteCurrency = this.config.symbol.split('-')[1]!;
    const toSymbol = `${top.baseAsset}-${quoteCurrency}`;
    const db = getDb(this.config.dbPath);
    db.prepare(
      `INSERT INTO pending_rotation (from_symbol, to_symbol, approved_at, status, scan_id, requested_by)
       VALUES (?, ?, ?, 'APPROVED', ?, 'autonomous-weekly')`,
    ).run(this.config.symbol, toSymbol, new Date().toISOString(), scanResult.id ?? null);

    logger.info('Autonomous rotation approved — will execute this same cycle', {
      from: this.config.symbol,
      to: toSymbol,
      score: top.score.toFixed(4),
    });
    await this.notifyAutonomousDecision(isBootstrap, top, null, toSymbol);
  }

  private async notifyAutonomousDecision(
    isBootstrap: boolean,
    top: AssetCandidate | null,
    baselineScore: number | null,
    toSymbol: string | null,
  ): Promise<void> {
    if (!this.telegram) return;

    const lines: string[] = [];
    lines.push(isBootstrap ? '🤖 <b>AUTONOMOUS BOOTSTRAP</b>' : '🤖 <b>AUTONOMOUS WEEKLY REVIEW</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    if (!top) {
      lines.push('No qualifying candidate this run (failed volume/trend/return filters) — staying as-is.');
    } else if (toSymbol) {
      lines.push(`Switching to <b>${toSymbol}</b> (score ${top.score.toFixed(4)}).`);
      lines.push(`├─ MAD: ${(top.mad * 100).toFixed(1)}% | Trend: ${(top.trendSlope * 100).toFixed(3)}%/day`);
      lines.push(`└─ Liquidity weight: ${top.liquidityWeight.toFixed(2)}`);
    } else {
      lines.push(`Keeping <b>${this.config.symbol}</b>.`);
      lines.push(`├─ Top candidate this week: ${top.symbol} (score ${top.score.toFixed(4)})`);
      lines.push(`└─ Current asset score: ${(baselineScore ?? 0).toFixed(4)} — not enough margin to switch`);
    }

    try {
      await this.telegram.sendMessage(lines.join('\n'));
    } catch (err) {
      logger.warn('Failed to send autonomous rotation notification', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Checks for an APPROVED row in pending_rotation (populated by the Telegram
   * approve flow in scan-reporter.ts) and executes it: liquidate the entire current
   * position to BRL, then swap every per-symbol service to the new asset. Returns
   * true if a rotation was executed this cycle.
   */
  private async checkAndExecuteRotation(): Promise<boolean> {
    const db = getDb(this.config.dbPath);
    const pending = db
      .prepare("SELECT * FROM pending_rotation WHERE status = 'APPROVED' LIMIT 1")
      .get() as PendingRotationRow | undefined;

    if (!pending) return false;

    if (!this.adapterFactory) {
      logger.error('Rotation approved but no adapterFactory configured — cannot execute', {
        from: pending.from_symbol,
        to: pending.to_symbol,
      });
      db.prepare('UPDATE pending_rotation SET status = ?, execution_error = ? WHERE id = ?')
        .run('FAILED', 'adapterFactory not configured', pending.id);
      return false;
    }

    logger.info('Pending rotation found — executing liquidation', {
      from: pending.from_symbol,
      to: pending.to_symbol,
      rotationId: pending.id,
    });

    try {
      await this.executeLiquidationAndSwap(pending);
      return true;
    } catch (err) {
      const error = (err as Error).message;
      logger.error('Rotation execution failed', { error, rotationId: pending.id });
      db.prepare('UPDATE pending_rotation SET status = ?, execution_error = ? WHERE id = ?')
        .run('FAILED', error, pending.id);
      return false;
    }
  }

  private async executeLiquidationAndSwap(pending: PendingRotationRow): Promise<void> {
    const { from_symbol: fromSymbol, to_symbol: toSymbol, id: rotationId } = pending;
    const oldBaseAsset = fromSymbol.split('-')[0]!;
    const newBaseAsset = toSymbol.split('-')[0]!;
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const db = getDb(this.config.dbPath);

    const portfolio = await this.adapter.getPortfolio();
    let liquidationTradeId: string | null = null;

    if (portfolio.baseBalance > 0.0001) {
      const brlAmount = portfolio.baseBalance * portfolio.basePrice;

      await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
      const tradeRecord = await this.adapter.executeTrade('SELL_BASE', brlAmount, portfolio);
      tradeRecord.tradeDateBRT = todayBRT;
      tradeRecord.baseAsset = oldBaseAsset;
      liquidationTradeId = tradeRecord.id;

      let pendingTaxEvent: ReturnType<TaxService['buildTaxEvent']> | null = null;

      if (tradeRecord.status === 'FILLED' || tradeRecord.status === 'DRY_RUN') {
        if (!this.config.dryRun && tradeRecord.baseAmountFilled != null && tradeRecord.fillPrice != null) {
          tradeRecord.portfolioAfter = computePortfolioAfterFill(
            portfolio,
            'SELL_BASE',
            tradeRecord.baseAmountFilled,
            tradeRecord.brlAmountFilled ?? brlAmount,
            tradeRecord.feeBrl ?? 0,
            tradeRecord.fillPrice,
          );
        }

        const baseSold = tradeRecord.baseAmountFilled ?? portfolio.baseBalance;
        const brlReceived = tradeRecord.brlAmountFilled ?? brlAmount;
        const ledger = this.costBasis.getLedger();
        const costBasisBrl = ledger.base.averageCostBrl * baseSold;
        const realizedGainBrl = this.costBasis.updateAfterSell(baseSold, brlReceived);
        tradeRecord.realizedGainBrl = realizedGainBrl;

        // A rotation liquidation always sells the full position, regardless of the
        // monthly Lei 9.250 exemption cap (neverExceedExemptionLimit) — unlike a normal
        // partial rebalance SELL, capping a forced full-position exit would just leave
        // the rotation stuck indefinitely on any position larger than the remaining
        // monthly allowance. The resulting tax event (exempt or not) is recorded and
        // surfaced normally. See docs/dynamic-asset-rotation-plan.md, "Tax policy".
        pendingTaxEvent = this.tax.buildTaxEvent({
          tradeId: tradeRecord.id,
          tradeDateBRT: todayBRT,
          direction: 'SELL_BASE',
          tradedVolumeBrl: brlReceived,
          grossProceedsBrl: brlReceived,
          costBasisBrl,
          realizedGainBrl,
          exchange: tradeRecord.exchange,
        });
      }

      const txn = db.transaction(() => {
        this.history.appendTrade(tradeRecord);
        if (pendingTaxEvent) this.tax.appendTaxEvent(pendingTaxEvent);
        db.prepare(
          'UPDATE pending_rotation SET status = ?, executed_at = ?, liquidation_trade_id = ? WHERE id = ?',
        ).run('COMPLETED', new Date().toISOString(), liquidationTradeId, rotationId);
      });
      txn();
    } else {
      logger.info('No base asset to liquidate for rotation, swapping symbol only', {
        from: fromSymbol,
        to: toSymbol,
      });
      db.prepare('UPDATE pending_rotation SET status = ?, executed_at = ? WHERE id = ?')
        .run('COMPLETED', new Date().toISOString(), rotationId);
    }

    // ── Swap every per-symbol service to the new asset ──────────────────────────
    this.adapter = this.adapterFactory!(toSymbol);
    this.volatility = new VolatilityService(this.adapter, this.config.volatilityWindowDays);
    this.costBasis = new CostBasisService(this.config.dbPath, this.config.jsonRetentionDays ?? 15, newBaseAsset);
    this.config.symbol = toSymbol;
    setDbConfig('current_symbol', toSymbol, this.config.dbPath);

    // A rotation liquidation is not a normal rebalance — it must not leave the cooldown
    // or day-trade guard blocking the immediate re-acquisition leg below.
    this.lastRebalanceTime = 0;
    this.lastRebalanceDateBRT = null;
    this.lastRebalanceDirection = null;

    logger.info('Rotation completed — now trading new symbol', { from: fromSymbol, to: toSymbol });

    // ── Immediately re-acquire 50% of the new asset using the freed BRL ─────────
    // Handled explicitly here rather than left to the normal checkAndRebalance() flow
    // below: computeDeviationBps() treats one side being exactly zero as "no drift" (a
    // sane default for a brand-new, never-yet-funded instance), which would otherwise
    // make a rotation land at 100% BRL and silently never trigger a BUY — the original
    // recovered rotation-executor.ts had this exact same latent gap, never caught
    // because it was never actually wired up or tested end-to-end.
    let acquisitionTradeId: string | null = null;
    let acquisitionBrl = 0;
    const newPortfolio = await this.adapter.getPortfolio();
    const targetAcquisitionBrl = newPortfolio.brlBalance / 2;

    if (targetAcquisitionBrl >= this.config.minTradeSizeBrl) {
      acquisitionBrl = targetAcquisitionBrl;
      await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
      const acquisitionTrade = await this.adapter.executeTrade('BUY_BASE', acquisitionBrl, newPortfolio);
      acquisitionTrade.tradeDateBRT = todayBRT;
      acquisitionTrade.baseAsset = newBaseAsset;
      acquisitionTradeId = acquisitionTrade.id;

      if (acquisitionTrade.status === 'FILLED' || acquisitionTrade.status === 'DRY_RUN') {
        if (!this.config.dryRun && acquisitionTrade.baseAmountFilled != null && acquisitionTrade.fillPrice != null) {
          acquisitionTrade.portfolioAfter = computePortfolioAfterFill(
            newPortfolio,
            'BUY_BASE',
            acquisitionTrade.baseAmountFilled,
            acquisitionTrade.brlAmountFilled ?? acquisitionBrl,
            acquisitionTrade.feeBrl ?? 0,
            acquisitionTrade.fillPrice,
          );
        }

        const baseAcquired = acquisitionTrade.baseAmountFilled ?? 0;
        const brlSpent = acquisitionTrade.brlAmountFilled ?? acquisitionBrl;
        this.costBasis.updateAfterBuy(baseAcquired, brlSpent);
        acquisitionTrade.realizedGainBrl = 0;

        const acquisitionTaxEvent = this.tax.buildTaxEvent({
          tradeId: acquisitionTrade.id,
          tradeDateBRT: todayBRT,
          direction: 'BUY_BASE',
          tradedVolumeBrl: 0,
          grossProceedsBrl: 0,
          costBasisBrl: 0,
          realizedGainBrl: 0,
          exchange: acquisitionTrade.exchange,
        });

        const txn2 = db.transaction(() => {
          this.history.appendTrade(acquisitionTrade);
          this.tax.appendTaxEvent(acquisitionTaxEvent);
          db.prepare('UPDATE pending_rotation SET reacquisition_trade_id = ? WHERE id = ?')
            .run(acquisitionTradeId, rotationId);
        });
        txn2();

        this.lastRebalanceTime = Date.now();
        this.lastRebalanceDateBRT = todayBRT;
        this.lastRebalanceDirection = 'BUY_BASE';
      }
    } else {
      logger.info('Skipping immediate re-acquisition — available BRL below minTradeSizeBrl', {
        targetAcquisitionBrl: targetAcquisitionBrl.toFixed(2),
        minTradeSizeBrl: this.config.minTradeSizeBrl,
      });
    }

    await this.notifyRotationComplete(
      fromSymbol, toSymbol,
      liquidationTradeId ? portfolio : null,
      acquisitionTradeId ? acquisitionBrl : null,
    );
  }

  private async notifyRotationComplete(
    fromSymbol: string,
    toSymbol: string,
    liquidatedPortfolio: Portfolio | null,
    acquisitionBrl: number | null,
  ): Promise<void> {
    if (!this.telegram) return;

    const fromAsset = fromSymbol.split('-')[0];
    const lines: string[] = [];
    lines.push('🔄 <b>ROTATION COMPLETED</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`From: <b>${fromSymbol}</b> → To: <b>${toSymbol}</b>`);
    lines.push('');

    if (liquidatedPortfolio) {
      lines.push('<b>Liquidated</b>');
      lines.push(`├─ Sold: ${liquidatedPortfolio.baseBalance.toFixed(6)} ${fromAsset}`);
      lines.push(`└─ @: R$ ${liquidatedPortfolio.basePrice.toFixed(2)}/${fromAsset}`);
      lines.push('');
    }

    const toAsset = toSymbol.split('-')[0];
    if (acquisitionBrl != null) {
      lines.push('<b>Re-acquired</b>');
      lines.push(`└─ Bought: R$ ${acquisitionBrl.toFixed(2)} of ${toAsset}`);
      lines.push('');
      lines.push(`✅ Now trading <b>${toSymbol}</b> at ~50/50.`);
    } else {
      lines.push('<b>Portfolio Status</b>');
      lines.push('└─ Base Asset: None (100% BRL — available balance was below the minimum trade size)');
      lines.push('');
      lines.push(`⏭️ Will rebalance into <b>${toSymbol}</b> once funded above the minimum trade size.`);
    }

    try {
      await this.telegram.sendMessage(lines.join('\n'));
    } catch (err) {
      logger.warn('Failed to send rotation completion notification', {
        error: (err as Error).message,
      });
    }
  }

  shutdown(): void {
    logger.info('Shutting down rebalancer...');
    this.isRunning = false;
  }
}
