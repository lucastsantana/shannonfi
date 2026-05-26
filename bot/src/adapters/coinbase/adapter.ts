import { v4 as uuidv4 } from 'uuid';
import { CoinbaseClient } from './client';
import { CoinbaseEndpoints } from './endpoints';
import { fetchUsdBrlRate } from './fx';
import { CoinbaseOrderStatus } from './raw-types';
import { ExchangeAdapter, CandleResolution, Portfolio, TradeRecord } from '../types';
import { computeSolRatioBps, computeDeviationBps, usdToSol, isSlippageAcceptable } from '../../math';
import { logger } from '../../core/tracker/logger';
import {
  COINBASE_PRODUCT_ID,
  FILL_POLL_INTERVAL_MS,
  FILL_POLL_MAX_ATTEMPTS,
} from '../../constants';
import { CoinbaseConfig } from '../../config';

// Map Coinbase ONE_DAY etc. resolution strings from ExchangeAdapter canonical form
const RESOLUTION_MAP: Record<CandleResolution, string> = {
  '1m': 'ONE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '1h': 'ONE_HOUR',
  '1d': 'ONE_DAY',
};

/**
 * Coinbase Advanced Trade adapter.
 *
 * Responsibility boundary: this adapter owns all USD↔BRL conversion.
 * The RebalancerBot and tracker services only ever see BRL values.
 */
export class CoinbaseAdapter implements ExchangeAdapter {
  private endpoints: CoinbaseEndpoints;

  constructor(
    private cbConfig: CoinbaseConfig,
    private dryRun: boolean,
    private maxSlippageBps: number,
  ) {
    const client = new CoinbaseClient(
      { apiKeyName: cbConfig.apiKeyName, privateKey: cbConfig.privateKey ?? '' },
      cbConfig.apiBaseUrl,
    );
    this.endpoints = new CoinbaseEndpoints(client);
  }

  async getPortfolio(): Promise<Portfolio> {
    const [accountsResp, bidAskResp] = await Promise.all([
      this.endpoints.listAccounts(),
      this.endpoints.getBestBidAsk(),
    ]);

    const accounts = accountsResp.accounts;
    const solAccount = accounts.find((a) => a.currency === 'SOL');
    const usdAccount = accounts.find((a) => a.currency === 'USD');

    const solBalance = solAccount ? parseFloat(solAccount.available_balance.value) : 0;
    const usdBalance = usdAccount ? parseFloat(usdAccount.available_balance.value) : 0;

    const pricebook = bidAskResp.pricebooks[0];
    if (!pricebook) throw new Error('No pricebook returned for SOL-USD');
    const bestBid = parseFloat(pricebook.bids[0]?.price ?? '0');
    const bestAsk = parseFloat(pricebook.asks[0]?.price ?? '0');
    const solPriceUsd = (bestBid + bestAsk) / 2;

    const usdBrlRate = await fetchUsdBrlRate(this.cbConfig.fxApiUrl);
    if (!usdBrlRate) {
      throw new Error('Cannot fetch USD/BRL rate — portfolio valuation in BRL unavailable');
    }

    const solPriceBrl = solPriceUsd * usdBrlRate;
    const solValueBrl = solBalance * solPriceBrl;
    const brlBalance = usdBalance * usdBrlRate;
    const totalValueBrl = solValueBrl + brlBalance;
    const solRatioBps = computeSolRatioBps(solValueBrl, totalValueBrl);

    return {
      solBalance,
      brlBalance,
      solPrice: solPriceBrl,
      solValueBrl,
      totalValueBrl,
      solRatioBps,
      deviationBps: computeDeviationBps(solRatioBps),
      timestamp: new Date().toISOString(),
      usdBrlRate,
    };
  }

  async executeTrade(
    direction: 'BUY_SOL' | 'SELL_SOL',
    brlAmount: number,
    portfolioBefore: Portfolio,
  ): Promise<TradeRecord> {
    const clientOrderId = uuidv4();

    // portfolioBefore.usdBrlRate was set when getPortfolio() ran this cycle
    const usdBrlRate = portfolioBefore.usdBrlRate;
    if (!usdBrlRate) {
      throw new Error('portfolioBefore.usdBrlRate is missing — cannot convert BRL to USD');
    }

    const solPriceBrl = portfolioBefore.solPrice;
    const solPriceUsd = solPriceBrl / usdBrlRate;
    const usdAmount = brlAmount / usdBrlRate;

    const record: TradeRecord = {
      id: uuidv4(),
      clientOrderId,
      exchangeOrderId: null,
      exchange: 'coinbase',
      timestamp: new Date().toISOString(),
      direction,
      brlAmountTarget: brlAmount,
      solAmountFilled: null,
      brlAmountFilled: null,
      fillPrice: null,
      feeBrl: null,
      status: 'PENDING',
      portfolioBefore,
      portfolioAfter: null,
      dryRun: this.dryRun,
      realizedGainBrl: null,
      tradeDateBRT: null,
      usdBrlRate,
    };

    if (this.dryRun) {
      logger.info('[DRY RUN] Would execute Coinbase trade', {
        direction,
        brlAmount: brlAmount.toFixed(2),
        usdAmount: usdAmount.toFixed(2),
        solPriceUsd: solPriceUsd.toFixed(4),
        usdBrlRate: usdBrlRate.toFixed(4),
      });
      record.status = 'DRY_RUN';
      return record;
    }

    const orderRequest =
      direction === 'BUY_SOL'
        ? {
            client_order_id: clientOrderId,
            product_id: COINBASE_PRODUCT_ID,
            side: 'BUY' as const,
            order_configuration: { market_market_ioc: { quote_size: usdAmount.toFixed(2) } },
          }
        : {
            client_order_id: clientOrderId,
            product_id: COINBASE_PRODUCT_ID,
            side: 'SELL' as const,
            order_configuration: {
              market_market_ioc: { base_size: usdToSol(usdAmount, solPriceUsd, 8).toFixed(8) },
            },
          };

    logger.info('Placing Coinbase order', { direction, usdAmount: usdAmount.toFixed(2), clientOrderId });
    const createResp = await this.endpoints.createOrder(orderRequest);

    if (!createResp.success || !createResp.success_response) {
      const reason =
        createResp.error_response?.message ?? createResp.failure_reason ?? 'Unknown';
      throw new Error(`Coinbase order placement failed: ${reason}`);
    }

    const coinbaseOrderId = createResp.success_response.order_id;
    record.exchangeOrderId = coinbaseOrderId;

    const filledOrder = await this.pollOrderFill(coinbaseOrderId);
    record.status = filledOrder.status === 'FILLED' ? 'FILLED'
      : filledOrder.status === 'CANCELLED' ? 'CANCELLED'
      : filledOrder.status === 'EXPIRED' ? 'EXPIRED'
      : filledOrder.status === 'FAILED' ? 'FAILED'
      : 'PENDING';

    if (filledOrder.status !== 'FILLED') {
      logger.warn('Coinbase order did not fill', { coinbaseOrderId, status: filledOrder.status });
      return record;
    }

    const fillPriceUsd = parseFloat(filledOrder.average_filled_price);
    const fillPriceBrl = fillPriceUsd * usdBrlRate;
    if (!isSlippageAcceptable(solPriceBrl, fillPriceBrl, this.maxSlippageBps)) {
      logger.warn('Slippage exceeded threshold', {
        expectedBrl: solPriceBrl,
        fillBrl: fillPriceBrl,
        maxSlippageBps: this.maxSlippageBps,
      });
    }

    const solFilled = parseFloat(filledOrder.filled_size);
    const usdFilled = parseFloat(filledOrder.filled_value);
    const feeUsd = parseFloat(filledOrder.total_fees);

    record.solAmountFilled = solFilled;
    record.brlAmountFilled = usdFilled * usdBrlRate;
    record.fillPrice = fillPriceBrl;
    record.feeBrl = feeUsd * usdBrlRate;

    logger.info('Coinbase order filled', {
      coinbaseOrderId,
      solFilled: solFilled.toFixed(6),
      brlFilled: record.brlAmountFilled.toFixed(2),
      fillPriceBrl: fillPriceBrl.toFixed(2),
      feeBrl: record.feeBrl.toFixed(2),
    });

    return record;
  }

  async getCandles(countback: number, resolution: CandleResolution): Promise<number[]> {
    const granularity = RESOLUTION_MAP[resolution] as
      | 'ONE_MINUTE' | 'FIFTEEN_MINUTE' | 'ONE_HOUR' | 'ONE_DAY';

    const usdBrlRate = await fetchUsdBrlRate(this.cbConfig.fxApiUrl);
    if (!usdBrlRate) {
      throw new Error('Cannot fetch USD/BRL rate for candle conversion');
    }

    const now = Math.floor(Date.now() / 1000);
    const secondsPerCandle = resolution === '1d' ? 86400 : resolution === '1h' ? 3600 : 900;
    const start = now - countback * secondsPerCandle;
    const resp = await this.endpoints.getCandles(start, now, granularity);

    return resp.candles
      .sort((a, b) => parseInt(a.start) - parseInt(b.start))
      .map((c) => parseFloat(c.close) * usdBrlRate);
  }

  private async pollOrderFill(orderId: string): Promise<{ status: CoinbaseOrderStatus; average_filled_price: string; filled_size: string; filled_value: string; total_fees: string }> {
    const terminal: CoinbaseOrderStatus[] = ['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED'];

    for (let attempt = 0; attempt < FILL_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
      const resp = await this.endpoints.getOrder(orderId);
      if ((terminal as string[]).includes(resp.order.status)) return resp.order;
      logger.debug('Polling Coinbase order fill', { orderId, status: resp.order.status, attempt: attempt + 1 });
    }
    return (await this.endpoints.getOrder(orderId)).order;
  }
}
