/**
 * Coinbase Advanced Trade adapter.
 * Coinbase has no BRL-quoted trading pairs (verified against its live products API
 * — see docs/coinbase-adapter-plan.md) — every product this adapter trades is
 * USDC-quoted (e.g. BTC-USDC). USDC, not USD, is the supported quote currency:
 * live testing against a Brazilian-held Coinbase account found that holdings only
 * convert/trade cleanly via USDC pairs (see docs/coinbase-adapter-plan.md,
 * "Implementation Notes"). This adapter converts BRL<->USD at the boundary using
 * the daily BACEN PTAX rate (FxRateService), treating USDC as 1:1 with USD for
 * that conversion, so every other layer in the engine (math, cost basis, tax,
 * history, dashboard, reporting) sees plain "BRL" values exactly like the Mercado
 * Bitcoin and Binance adapters provide — it never knows this instance is actually
 * trading in USDC underneath.
 *
 * LIVE-TESTED against a real Coinbase account (auth, balances, market data, PTAX
 * conversion) — order placement/fill polling has not yet been exercised live.
 */

import { v4 as uuidv4 } from 'uuid';
import { CoinbaseClient } from './client';
import { CoinbaseEndpoints } from './endpoints';
import { ExchangeAdapter, CandleResolution, Portfolio, TradeRecord } from '../types';
import { computeBaseRatioBps, computeDeviationBps, brlToBase, isSlippageAcceptable } from '../../math';
import { logger } from '../../core/tracker/logger';
import { COINBASE_FILL_POLL_INTERVAL_MS, COINBASE_FILL_POLL_MAX_ATTEMPTS } from '../../constants';
import { CoinbaseConfig } from '../../config';
import { getCoinbaseCredentials } from '../../core/keyring';
import { FxRateService } from '../../core/tracker/fxrate';
import { CoinbaseGranularity } from './raw-types';

const COINBASE_RESOLUTION_MAP: Record<CandleResolution, CoinbaseGranularity> = {
  '1m': 'ONE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '1h': 'ONE_HOUR',
  '1d': 'ONE_DAY',
};

export class CoinbaseAdapter implements ExchangeAdapter {
  private endpoints: CoinbaseEndpoints;
  private fxRate: FxRateService;
  private baseAsset: string;
  private quoteCurrency: string; // 'USDC' (default/supported); 'USD' schema-allowed but unsupported
  private productId: string;    // e.g. "BTC-USDC"

  constructor(
    private coinbaseConfig: CoinbaseConfig,
    private dryRun: boolean,
    private maxSlippageBps: number,
    private symbol: string,
  ) {
    if (!symbol || !symbol.includes('-')) {
      throw new Error(`Invalid symbol format: ${symbol}. Expected BASE-QUOTE format (e.g. BTC-USDC)`);
    }
    const parts = symbol.split('-');
    this.baseAsset = parts[0]!;
    this.quoteCurrency = parts[1]!;
    this.productId = symbol;

    let keyName = process.env.COINBASE_API_KEY_NAME;
    let privateKeyPem = process.env.COINBASE_API_KEY_SECRET;

    if (!keyName || !privateKeyPem) {
      const creds = getCoinbaseCredentials();
      keyName = creds.keyName;
      privateKeyPem = creds.privateKeyPem;
    }

    const client = new CoinbaseClient(keyName, privateKeyPem, coinbaseConfig.apiBaseUrl);
    this.endpoints = new CoinbaseEndpoints(client, this.productId);
    this.fxRate = new FxRateService();
  }

  /** Fetches the current base-asset price in USD via the public candles endpoint, in BRL. */
  async getPrice(): Promise<number> {
    const [resp, ptax] = await Promise.all([
      this.endpoints.getCandles(2, 'ONE_DAY'),
      this.fxRate.getUsdBrlRate(),
    ]);
    const candles = resp.candles;
    if (candles.length === 0) throw new Error('No candle data returned from Coinbase');
    // Coinbase returns candles newest-first.
    const latestUsd = parseFloat(candles[0]!.close);
    if (!Number.isFinite(latestUsd) || latestUsd <= 0) {
      throw new Error(`Invalid ${this.productId} price: ${candles[0]!.close}`);
    }
    return latestUsd * ptax;
  }

  /**
   * Fetches balances and builds a Portfolio, in BRL throughout.
   * If knownPrice is supplied it's already BRL — skips the price fetch but still
   * needs a PTAX rate to convert the USD cash balance.
   */
  async getPortfolio(knownPrice?: number): Promise<Portfolio> {
    const [accounts, ptax] = await Promise.all([
      this.getAllAccounts(),
      this.fxRate.getUsdBrlRate(),
    ]);

    const basePriceBrl = knownPrice ?? (await this.getPrice());

    const baseBalanceStr = accounts.find((a) => a.currency === this.baseAsset)?.available_balance.value ?? '0';
    const baseBalance = parseFloat(baseBalanceStr);
    if (!Number.isFinite(baseBalance) || baseBalance < 0) {
      throw new Error(`Invalid ${this.baseAsset} balance: ${baseBalanceStr}`);
    }

    const quoteBalanceStr = accounts.find((a) => a.currency === this.quoteCurrency)?.available_balance.value ?? '0';
    const quoteBalance = parseFloat(quoteBalanceStr);
    if (!Number.isFinite(quoteBalance) || quoteBalance < 0) {
      throw new Error(`Invalid ${this.quoteCurrency} balance: ${quoteBalanceStr}`);
    }
    // The "BRL balance" the rest of the engine works with is the USD cash leg
    // converted at today's PTAX rate — there is no real BRL cash anywhere in this
    // account; it's a BRL-equivalent view of a USD position, by design (see file header).
    const brlBalance = quoteBalance * ptax;

    const baseValueBrl = baseBalance * basePriceBrl;
    const totalValueBrl = baseValueBrl + brlBalance;
    const baseRatioBps = computeBaseRatioBps(baseValueBrl, totalValueBrl);

    return {
      baseBalance,
      brlBalance,
      basePrice: basePriceBrl,
      baseValueBrl,
      totalValueBrl,
      baseRatioBps,
      deviationBps: computeDeviationBps(baseValueBrl, brlBalance),
      timestamp: new Date().toISOString(),
    };
  }

  async executeTrade(
    direction: 'BUY_BASE' | 'SELL_BASE',
    brlAmount: number,
    portfolioBefore: Portfolio,
  ): Promise<TradeRecord> {
    const clientOrderId = uuidv4();
    const ptax = await this.fxRate.getUsdBrlRate();

    const record: TradeRecord = {
      id: uuidv4(),
      clientOrderId,
      exchangeOrderId: null,
      exchange: 'coinbase',
      timestamp: new Date().toISOString(),
      direction,
      brlAmountTarget: brlAmount,
      baseAmountFilled: null,
      brlAmountFilled: null,
      fillPrice: null,
      feeBrl: null,
      status: 'PENDING',
      portfolioBefore,
      portfolioAfter: null,
      dryRun: this.dryRun,
      realizedGainBrl: null,
      tradeDateBRT: null,
      baseAsset: this.baseAsset,
    };

    if (this.dryRun) {
      logger.info('[DRY RUN] Would execute Coinbase trade', {
        direction,
        brlAmount: brlAmount.toFixed(2),
        productId: this.productId,
      });
      record.status = 'DRY_RUN';
      return record;
    }

    const usdAmount = brlAmount / ptax;
    const orderRequest =
      direction === 'BUY_BASE'
        ? {
            client_order_id: clientOrderId,
            product_id: this.productId,
            side: 'BUY' as const,
            order_configuration: { market_market_ioc: { quote_size: usdAmount.toFixed(2) } },
          }
        : {
            client_order_id: clientOrderId,
            product_id: this.productId,
            side: 'SELL' as const,
            order_configuration: {
              market_market_ioc: {
                base_size: brlToBase(brlAmount, portfolioBefore.basePrice, 8).toFixed(8),
              },
            },
          };

    logger.info('Placing Coinbase order', {
      direction,
      brlAmount: brlAmount.toFixed(2),
      usdAmount: usdAmount.toFixed(2),
      clientOrderId,
    });

    const created = await this.endpoints.createOrder(orderRequest);
    if (!created.success || !created.success_response) {
      logger.warn('Coinbase order creation failed', { error: created.error_response });
      record.status = 'FAILED';
      return record;
    }
    record.exchangeOrderId = created.success_response.order_id;

    const filled = await this.pollOrderFill(created.success_response.order_id);
    if (filled.status !== 'FILLED') {
      logger.warn('Coinbase order did not fill', { orderId: record.exchangeOrderId, status: filled.status });
      record.status = filled.status === 'OPEN' || filled.status === 'PENDING' ? 'PENDING' : 'CANCELLED';
      return record;
    }

    const filledQty = parseFloat(filled.filled_size);
    if (!Number.isFinite(filledQty) || filledQty < 0) {
      throw new Error(`Invalid filled quantity: ${filled.filled_size}`);
    }

    const avgPriceUsd = parseFloat(filled.average_filled_price);
    if (!Number.isFinite(avgPriceUsd) || avgPriceUsd <= 0) {
      throw new Error(`Invalid fill price: ${filled.average_filled_price}`);
    }
    const fillPriceBrl = avgPriceUsd * ptax;

    const filledValueUsd = parseFloat(filled.filled_value);
    const brlFilled = Number.isFinite(filledValueUsd) && filledValueUsd > 0
      ? filledValueUsd * ptax
      : filledQty * fillPriceBrl;

    const feeUsd = parseFloat(filled.total_fees);
    const feeBrl = Number.isFinite(feeUsd) && feeUsd >= 0 ? feeUsd * ptax : 0;

    if (!isSlippageAcceptable(portfolioBefore.basePrice, fillPriceBrl, this.maxSlippageBps)) {
      logger.warn('Slippage exceeded threshold', {
        expectedBrl: portfolioBefore.basePrice,
        fillBrl: fillPriceBrl,
        maxSlippageBps: this.maxSlippageBps,
      });
    }

    record.baseAmountFilled = filledQty;
    record.brlAmountFilled = brlFilled;
    record.fillPrice = fillPriceBrl;
    record.feeBrl = feeBrl;
    record.status = 'FILLED';

    logger.info('Coinbase order filled', {
      orderId: record.exchangeOrderId,
      baseFilled: filledQty.toFixed(6),
      brlFilled: brlFilled.toFixed(2),
      fillPriceBrl: fillPriceBrl.toFixed(2),
      feeBrl: feeBrl.toFixed(2),
      ptaxUsed: ptax,
    });

    return record;
  }

  /**
   * Returns close prices in BRL. Scaling a whole USD candle series by a single
   * current PTAX rate is mathematically exact for the day-over-day % returns
   * VolatilityService computes from this (scaling every value by the same constant
   * leaves (P2-P1)/P1 unchanged) — it's only the *current* price/portfolio snapshot
   * where using one daily rate instead of live FX is an approximation, not here.
   */
  async getCandles(countback: number, resolution: CandleResolution): Promise<number[]> {
    const granularity = COINBASE_RESOLUTION_MAP[resolution];
    const [resp, ptax] = await Promise.all([
      this.endpoints.getCandles(countback, granularity),
      this.fxRate.getUsdBrlRate(),
    ]);
    const closes = resp.candles
      .map((c) => ({ start: parseInt(c.start, 10), close: parseFloat(c.close) }))
      .filter((c) => Number.isFinite(c.close) && c.close > 0)
      .sort((a, b) => a.start - b.start)
      .map((c) => c.close * ptax);
    return closes;
  }

  /**
   * Fetch candles with volume data for a specific product (scanner use only).
   * NOT on the ExchangeAdapter interface — duck-typed against scanner.ts's
   * ScannerAdapter interface, same as the MB/Binance adapters' equivalent method.
   * Volume is base-asset-denominated (Coinbase's own units), not converted — same
   * convention as the other two adapters; only `close` is converted to BRL.
   */
  async getCandlesWithVolume(
    productId: string,
    countback: number,
  ): Promise<Array<{ close: number; volume: number; timestamp: number }>> {
    const [resp, ptax] = await Promise.all([
      this.endpoints.getCandles(countback, 'ONE_DAY', productId),
      this.fxRate.getUsdBrlRate(),
    ]);
    const data = resp.candles.map((c) => {
      const close = parseFloat(c.close);
      const volume = parseFloat(c.volume);
      if (!Number.isFinite(close) || close <= 0) throw new Error(`Invalid candle close: ${c.close}`);
      if (!Number.isFinite(volume) || volume < 0) throw new Error(`Invalid volume: ${c.volume}`);
      return { timestamp: parseInt(c.start, 10), close: close * ptax, volume };
    });
    data.sort((a, b) => a.timestamp - b.timestamp);
    return data;
  }

  private async getAllAccounts() {
    const accounts = [];
    let cursor: string | undefined;
    do {
      const resp = await this.endpoints.getAccounts(cursor);
      accounts.push(...resp.accounts);
      cursor = resp.has_next ? resp.cursor : undefined;
    } while (cursor);
    return accounts;
  }

  private async pollOrderFill(orderId: string) {
    for (let attempt = 0; attempt < COINBASE_FILL_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, COINBASE_FILL_POLL_INTERVAL_MS));
      try {
        const resp = await this.endpoints.getOrder(orderId);
        const terminal: string[] = ['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED'];
        if (terminal.includes(resp.order.status)) return resp.order;
        logger.debug('Polling Coinbase order fill', { orderId, status: resp.order.status, attempt: attempt + 1 });
      } catch (err) {
        logger.warn('Error polling Coinbase order status, will retry', {
          orderId,
          attempt: attempt + 1,
          error: (err as Error).message,
        });
        if (attempt === COINBASE_FILL_POLL_MAX_ATTEMPTS - 1) throw err;
      }
    }
    return (await this.endpoints.getOrder(orderId)).order;
  }
}
