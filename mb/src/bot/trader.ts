import { v4 as uuidv4 } from 'uuid';
import { MbEndpoints } from '../mb/endpoints';
import { MbOrderStatus, Portfolio, TradeRecord } from '../mb/types';
import { brlToSol, isSlippageAcceptable } from '../math';
import { logger } from '../tracker/logger';
import { FILL_POLL_INTERVAL_MS, FILL_POLL_MAX_ATTEMPTS } from '../constants';
import { Config } from '../config';

export class TraderService {
  private accountId: string | null = null;

  constructor(
    private endpoints: MbEndpoints,
    private config: Config,
  ) {}

  private async getAccountId(): Promise<string> {
    if (!this.accountId) {
      this.accountId = await this.endpoints.getAccountId();
    }
    return this.accountId;
  }

  /**
   * Executes a rebalancing trade on Mercado Bitcoin (SOL-BRL).
   *
   * BUY SOL:  cost = BRL to spend (MB calculates SOL quantity)
   * SELL SOL: qty  = SOL quantity (we compute from BRL ÷ price)
   */
  async executeTrade(
    direction: 'BUY_SOL' | 'SELL_SOL',
    brlAmount: number,
    portfolioBefore: Portfolio,
  ): Promise<TradeRecord> {
    const clientOrderId = uuidv4();
    const record: TradeRecord = {
      id: uuidv4(),
      clientOrderId,
      mbOrderId: null,
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
      dryRun: this.config.dryRun,
      realizedGainBrl: null,
      tradeDateBRT: null,
    };

    if (this.config.dryRun) {
      const estSol = brlToSol(brlAmount, portfolioBefore.solPrice);
      logger.info('[DRY RUN] Would execute trade', {
        direction,
        brlAmount: brlAmount.toFixed(2),
        estSolAmount: estSol.toFixed(6),
        solPriceBrl: portfolioBefore.solPrice.toFixed(2),
      });
      record.status = 'DRY_RUN';
      return record;
    }

    const accountId = await this.getAccountId();

    logger.info('Placing order on Mercado Bitcoin', {
      direction,
      brlAmount: brlAmount.toFixed(2),
      clientOrderId,
    });

    let orderId: string;

    if (direction === 'BUY_SOL') {
      const order = await this.endpoints.createOrder(accountId, {
        type: 'market',
        side: 'buy',
        cost: parseFloat(brlAmount.toFixed(2)),
        externalId: clientOrderId,
      });
      orderId = order.id;
    } else {
      const solQty = brlToSol(brlAmount, portfolioBefore.solPrice, 8);
      const order = await this.endpoints.createOrder(accountId, {
        type: 'market',
        side: 'sell',
        qty: solQty.toFixed(8),
        externalId: clientOrderId,
      });
      orderId = order.id;
    }

    record.mbOrderId = orderId;
    logger.info('Order placed, polling for fill', { orderId });

    const filledOrder = await this.pollOrderFill(accountId, orderId);
    record.status = filledOrder.status;

    if (filledOrder.status !== 'filled') {
      logger.warn('Order did not fill', { orderId, status: filledOrder.status });
      return record;
    }

    const fillPrice = filledOrder.avgPrice;
    if (!isSlippageAcceptable(portfolioBefore.solPrice, fillPrice, this.config.maxSlippageBps)) {
      logger.warn('Slippage exceeded threshold (order already filled)', {
        expectedPrice: portfolioBefore.solPrice,
        fillPrice,
        maxSlippageBps: this.config.maxSlippageBps,
      });
    }

    record.solAmountFilled = parseFloat(filledOrder.filledQty);
    record.brlAmountFilled = filledOrder.cost;
    record.fillPrice = fillPrice;
    record.feeBrl = parseFloat(filledOrder.fee);

    logger.info('Order filled', {
      orderId,
      solFilled: record.solAmountFilled.toFixed(6),
      brlFilled: record.brlAmountFilled.toFixed(2),
      fillPrice: record.fillPrice.toFixed(2),
      feeBrl: record.feeBrl.toFixed(2),
    });

    return record;
  }

  private async pollOrderFill(accountId: string, orderId: string): Promise<import('../mb/types').MbOrder> {
    const terminalStatuses: MbOrderStatus[] = ['filled', 'cancelled'];

    for (let attempt = 0; attempt < FILL_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
      const order = await this.endpoints.getOrder(accountId, orderId);

      if ((terminalStatuses as string[]).includes(order.status)) {
        return order;
      }

      logger.debug('Polling order fill', {
        orderId,
        status: order.status,
        attempt: attempt + 1,
      });
    }

    return this.endpoints.getOrder(accountId, orderId);
  }
}
