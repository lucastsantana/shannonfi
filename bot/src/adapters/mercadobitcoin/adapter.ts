import { v4 as uuidv4 } from 'uuid';
import { MbClient } from './client';
import { MbEndpoints } from './endpoints';
import { ExchangeAdapter, CandleResolution, Portfolio, TradeRecord } from '../types';
import { computeSolRatioBps, computeDeviationBps, brlToSol, isSlippageAcceptable } from '../../math';
import { logger } from '../../core/tracker/logger';
import {
  MB_SYMBOL,
  MB_FILL_POLL_INTERVAL_MS,
  MB_FILL_POLL_MAX_ATTEMPTS,
} from '../../constants';
import { MercadoBitcoinConfig } from '../../config';

const MB_RESOLUTION_MAP: Record<CandleResolution, import('./raw-types').MbCandleResolution> = {
  '1m': '1m',
  '15m': '15m',
  '1h': '1h',
  '1d': '1d',
};

export class MercadoBitcoinAdapter implements ExchangeAdapter {
  private endpoints: MbEndpoints;
  // Cached account ID — fetched once, stable for the lifetime of the process.
  private cachedAccountId: string | null = null;

  constructor(
    private mbConfig: MercadoBitcoinConfig,
    private dryRun: boolean,
    private maxSlippageBps: number,
  ) {
    const client = new MbClient(mbConfig.clientId, mbConfig.clientSecret, mbConfig.apiBaseUrl);
    this.endpoints = new MbEndpoints(client);
  }

  private async getAccountId(): Promise<string> {
    if (!this.cachedAccountId) {
      this.cachedAccountId = await this.endpoints.getAccountId();
      logger.debug('MB account ID cached', { accountId: this.cachedAccountId });
    }
    return this.cachedAccountId;
  }

  /**
   * Fetches the current SOL/BRL price via the public candles endpoint.
   * No authentication required — costs 1 API request.
   */
  async getPrice(): Promise<number> {
    const resp = await this.endpoints.getCandles(1, '1d');
    const latest = resp.c[resp.c.length - 1];
    if (!latest) throw new Error('No candle data returned from Mercado Bitcoin');
    const price = parseFloat(latest);
    if (price <= 0) throw new Error(`Invalid SOL/BRL price: ${latest}`);
    return price;
  }

  /**
   * Fetches balances and builds a Portfolio.
   * If knownPrice is provided, skips the candle fetch (saves 1 API request).
   * Costs 1 authenticated request (balances) when knownPrice is supplied,
   * or 2 requests (balances + candles) when called standalone.
   */
  async getPortfolio(knownPrice?: number): Promise<Portfolio> {
    const accountId = await this.getAccountId();

    const [balances, solPrice] = await Promise.all([
      this.endpoints.getBalances(accountId),
      knownPrice !== undefined ? Promise.resolve(knownPrice) : this.getPrice(),
    ]);

    const solBalance = parseFloat(balances.find((b) => b.symbol === 'SOL')?.available ?? '0');
    const brlBalance = parseFloat(balances.find((b) => b.symbol === 'BRL')?.available ?? '0');

    const solValueBrl = solBalance * solPrice;
    const totalValueBrl = solValueBrl + brlBalance;
    const solRatioBps = computeSolRatioBps(solValueBrl, totalValueBrl);

    return {
      solBalance,
      brlBalance,
      solPrice,
      solValueBrl,
      totalValueBrl,
      solRatioBps,
      deviationBps: computeDeviationBps(solRatioBps),
      timestamp: new Date().toISOString(),
    };
  }

  async executeTrade(
    direction: 'BUY_SOL' | 'SELL_SOL',
    brlAmount: number,
    portfolioBefore: Portfolio,
  ): Promise<TradeRecord> {
    const clientOrderId = uuidv4();
    const accountId = await this.getAccountId();

    const record: TradeRecord = {
      id: uuidv4(),
      clientOrderId,
      exchangeOrderId: null,
      exchange: 'mercadobitcoin',
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
    };

    if (this.dryRun) {
      logger.info('[DRY RUN] Would execute Mercado Bitcoin trade', {
        direction,
        brlAmount: brlAmount.toFixed(2),
        symbol: MB_SYMBOL,
      });
      record.status = 'DRY_RUN';
      return record;
    }

    const orderRequest =
      direction === 'BUY_SOL'
        ? {
            type: 'market' as const,
            side: 'buy' as const,
            cost: brlAmount,
            externalId: clientOrderId,
          }
        : {
            type: 'market' as const,
            side: 'sell' as const,
            qty: brlToSol(brlAmount, portfolioBefore.solPrice, 8).toFixed(8),
            externalId: clientOrderId,
          };

    logger.info('Placing Mercado Bitcoin order', {
      direction,
      brlAmount: brlAmount.toFixed(2),
      clientOrderId,
    });

    const created = await this.endpoints.createOrder(accountId, orderRequest);
    record.exchangeOrderId = created.id;

    const filled = await this.pollOrderFill(accountId, created.id);
    const normalizedStatus =
      filled.status === 'filled' ? 'FILLED'
      : (filled.status.toUpperCase() as TradeRecord['status']);
    record.status = normalizedStatus;

    if (filled.status !== 'filled' && filled.status !== 'partially_filled') {
      logger.warn('Mercado Bitcoin order did not fill', {
        orderId: created.id,
        status: filled.status,
      });
      return record;
    }

    const filledQty = parseFloat(filled.filledQty);
    const fillPriceBrl = filled.avgPrice;
    const brlFilled = filled.cost;
    const feeBrl = parseFloat(filled.fee);

    if (!isSlippageAcceptable(portfolioBefore.solPrice, fillPriceBrl, this.maxSlippageBps)) {
      logger.warn('Slippage exceeded threshold', {
        expectedBrl: portfolioBefore.solPrice,
        fillBrl: fillPriceBrl,
        maxSlippageBps: this.maxSlippageBps,
      });
    }

    record.solAmountFilled = filledQty;
    record.brlAmountFilled = brlFilled;
    record.fillPrice = fillPriceBrl;
    record.feeBrl = feeBrl;
    record.status = 'FILLED';

    logger.info('Mercado Bitcoin order filled', {
      orderId: created.id,
      solFilled: filledQty.toFixed(6),
      brlFilled: brlFilled.toFixed(2),
      fillPriceBrl: fillPriceBrl.toFixed(2),
      feeBrl: feeBrl.toFixed(2),
    });

    return record;
  }

  async getCandles(countback: number, resolution: CandleResolution): Promise<number[]> {
    const mbResolution = MB_RESOLUTION_MAP[resolution];
    const resp = await this.endpoints.getCandles(countback, mbResolution);
    const pairs = resp.t.map((ts, i) => ({ ts, close: parseFloat(resp.c[i] ?? '0') }));
    pairs.sort((a, b) => a.ts - b.ts);
    return pairs.map((p) => p.close);
  }

  private async pollOrderFill(accountId: string, orderId: string) {
    const terminal = ['filled', 'cancelled', 'partially_filled'];

    for (let attempt = 0; attempt < MB_FILL_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, MB_FILL_POLL_INTERVAL_MS));
      try {
        const order = await this.endpoints.getOrder(accountId, orderId);
        if (terminal.includes(order.status)) return order;
        logger.debug('Polling Mercado Bitcoin order fill', {
          orderId,
          status: order.status,
          attempt: attempt + 1,
        });
      } catch (err) {
        logger.warn('Error polling order status, will retry', {
          orderId,
          attempt: attempt + 1,
          error: (err as Error).message,
        });
        if (attempt === MB_FILL_POLL_MAX_ATTEMPTS - 1) throw err;
      }
    }
    return this.endpoints.getOrder(accountId, orderId);
  }
}
