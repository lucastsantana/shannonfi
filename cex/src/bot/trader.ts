import { v4 as uuidv4 } from 'uuid';
import { CoinbaseEndpoints } from '../coinbase/endpoints';
import {
  CreateOrderRequest,
  HistoricalOrder,
  OrderStatus,
  Portfolio,
  TradeRecord,
} from '../coinbase/types';
import { usdToSol, isSlippageAcceptable } from '../math';
import { logger } from '../tracker/logger';
import { PRODUCT_ID, FILL_POLL_INTERVAL_MS, FILL_POLL_MAX_ATTEMPTS } from '../constants';
import { Config } from '../config';

export class TraderService {
  constructor(
    private endpoints: CoinbaseEndpoints,
    private config: Config,
  ) {}

  /**
   * Executes a rebalancing trade.
   *
   * BUY SOL:  quote_size = USD to spend (Coinbase calculates SOL quantity)
   * SELL SOL: base_size  = SOL quantity (we compute from USD ÷ price)
   *
   * In dry-run mode, logs intent but makes no API calls.
   */
  async executeTrade(
    direction: 'BUY_SOL' | 'SELL_SOL',
    usdAmount: number,
    portfolioBefore: Portfolio,
  ): Promise<TradeRecord> {
    const clientOrderId = uuidv4();
    const record: TradeRecord = {
      id: uuidv4(),
      clientOrderId,
      coinbaseOrderId: null,
      timestamp: new Date().toISOString(),
      direction,
      usdAmountTarget: usdAmount,
      solAmountFilled: null,
      usdAmountFilled: null,
      fillPrice: null,
      feeUsd: null,
      status: 'PENDING',
      portfolioBefore,
      portfolioAfter: null,
      dryRun: this.config.dryRun,
      brlSnapshot: null,
      realizedGainBrl: null,
      tradeDateBRT: null,
    };

    if (this.config.dryRun) {
      const estSol = usdToSol(usdAmount, portfolioBefore.solPrice);
      logger.info('[DRY RUN] Would execute trade', {
        direction,
        usdAmount: usdAmount.toFixed(2),
        estSolAmount: estSol.toFixed(6),
        price: portfolioBefore.solPrice.toFixed(4),
      });
      record.status = 'DRY_RUN';
      return record;
    }

    const orderRequest = this.buildOrderRequest(
      clientOrderId,
      direction,
      usdAmount,
      portfolioBefore.solPrice,
    );

    logger.info('Placing order', {
      direction,
      usdAmount: usdAmount.toFixed(2),
      clientOrderId,
    });

    const createResp = await this.endpoints.createOrder(orderRequest);

    if (!createResp.success || !createResp.success_response) {
      const reason =
        createResp.error_response?.message ??
        createResp.failure_reason ??
        'Unknown';
      throw new Error(`Order placement failed: ${reason}`);
    }

    const coinbaseOrderId = createResp.success_response.order_id;
    record.coinbaseOrderId = coinbaseOrderId;

    logger.info('Order placed, polling for fill', { coinbaseOrderId });

    const filledOrder = await this.pollOrderFill(coinbaseOrderId);
    record.status = filledOrder.status;

    if (filledOrder.status !== 'FILLED') {
      logger.warn('Order did not fill', {
        coinbaseOrderId,
        status: filledOrder.status,
      });
      return record;
    }

    const fillPrice = parseFloat(filledOrder.average_filled_price);
    if (
      !isSlippageAcceptable(portfolioBefore.solPrice, fillPrice, this.config.maxSlippageBps)
    ) {
      logger.warn('Slippage exceeded threshold (order already filled)', {
        expectedPrice: portfolioBefore.solPrice,
        fillPrice,
        maxSlippageBps: this.config.maxSlippageBps,
      });
    }

    record.solAmountFilled = parseFloat(filledOrder.filled_size);
    record.usdAmountFilled = parseFloat(filledOrder.filled_value);
    record.fillPrice = fillPrice;
    record.feeUsd = parseFloat(filledOrder.total_fees);

    logger.info('Order filled', {
      coinbaseOrderId,
      solFilled: record.solAmountFilled.toFixed(6),
      usdFilled: record.usdAmountFilled.toFixed(2),
      fillPrice: record.fillPrice.toFixed(4),
      feeUsd: record.feeUsd.toFixed(4),
    });

    return record;
  }

  private buildOrderRequest(
    clientOrderId: string,
    direction: 'BUY_SOL' | 'SELL_SOL',
    usdAmount: number,
    solPrice: number,
  ): CreateOrderRequest {
    if (direction === 'BUY_SOL') {
      return {
        client_order_id: clientOrderId,
        product_id: PRODUCT_ID,
        side: 'BUY',
        order_configuration: {
          market_market_ioc: {
            quote_size: usdAmount.toFixed(2),
          },
        },
      };
    } else {
      // Sell SOL — compute SOL quantity; Coinbase accepts up to 8 decimal places
      const solAmount = usdToSol(usdAmount, solPrice, 8);
      return {
        client_order_id: clientOrderId,
        product_id: PRODUCT_ID,
        side: 'SELL',
        order_configuration: {
          market_market_ioc: {
            base_size: solAmount.toFixed(8),
          },
        },
      };
    }
  }

  private async pollOrderFill(orderId: string): Promise<HistoricalOrder> {
    const terminalStatuses: OrderStatus[] = ['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED'];

    for (let attempt = 0; attempt < FILL_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
      const resp = await this.endpoints.getOrder(orderId);
      const { status } = resp.order;

      if ((terminalStatuses as string[]).includes(status)) {
        return resp.order;
      }

      logger.debug('Polling order fill', {
        orderId,
        status,
        attempt: attempt + 1,
      });
    }

    // Return whatever we have after timeout
    const resp = await this.endpoints.getOrder(orderId);
    return resp.order;
  }
}
