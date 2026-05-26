import { v4 as uuidv4 } from 'uuid';
import { MbClient } from './client';
import { MbEndpoints } from './endpoints';
import { ExchangeAdapter, CandleResolution, Portfolio, TradeRecord } from '../types';
import { computeSolRatioBps, computeDeviationBps, brlToSol, isSlippageAcceptable } from '../../math';
import { logger } from '../../core/tracker/logger';
import { MB_SYMBOL, FILL_POLL_INTERVAL_MS, FILL_POLL_MAX_ATTEMPTS } from '../../constants';
import { MercadoBitcoinConfig } from '../../config';

const MB_RESOLUTION_MAP: Record<CandleResolution, import('./raw-types').MbCandleResolution> = {
  '1m': '1m',
  '15m': '15m',
  '1h': '1h',
  '1d': '1d',
};

export class MercadoBitcoinAdapter implements ExchangeAdapter {
  private endpoints: MbEndpoints;

  constructor(
    private mbConfig: MercadoBitcoinConfig,
    private dryRun: boolean,
    private maxSlippageBps: number,
  ) {
    const client = new MbClient(mbConfig.clientId, mbConfig.clientSecret, mbConfig.apiBaseUrl);
    this.endpoints = new MbEndpoints(client);
  }

  async getPortfolio(): Promise<Portfolio> {
    const accountId = await this.endpoints.getAccountId();
    const [balances, candles] = await Promise.all([
      this.endpoints.getBalances(accountId),
      this.endpoints.getCandles(2, '1d'),
    ]);

    const solBalance = parseFloat(
      balances.find((b) => b.symbol === 'SOL')?.available ?? '0',
    );
    const brlBalance = parseFloat(
      balances.find((b) => b.symbol === 'BRL')?.available ?? '0',
    );

    // Use the most recent close as current price; fall back to second-to-last if needed
    const closes = candles.c;
    const latestClose = closes[closes.length - 1];
    if (!latestClose) throw new Error('No candle data returned from Mercado Bitcoin');
    const solPrice = parseFloat(latestClose);
    if (solPrice <= 0) throw new Error(`Invalid SOL/BRL price: ${latestClose}`);

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
    const accountId = await this.endpoints.getAccountId();

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
    const normalizedStatus = filled.status === 'filled' ? 'FILLED' : filled.status.toUpperCase() as TradeRecord['status'];
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
    // Columnar format: resp.c[] are close prices in BRL, resp.t[] are timestamps
    // Sort by timestamp ascending and return close prices
    const pairs = resp.t.map((ts, i) => ({ ts, close: parseFloat(resp.c[i] ?? '0') }));
    pairs.sort((a, b) => a.ts - b.ts);
    return pairs.map((p) => p.close);
  }

  private async pollOrderFill(accountId: string, orderId: string) {
    const terminal = ['filled', 'cancelled', 'partially_filled'];

    for (let attempt = 0; attempt < FILL_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
      const order = await this.endpoints.getOrder(accountId, orderId);
      if (terminal.includes(order.status)) return order;
      logger.debug('Polling Mercado Bitcoin order fill', {
        orderId,
        status: order.status,
        attempt: attempt + 1,
      });
    }
    return this.endpoints.getOrder(accountId, orderId);
  }
}
