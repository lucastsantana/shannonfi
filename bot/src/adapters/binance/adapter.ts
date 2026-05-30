/**
 * Binance spot exchange adapter.
 * Implements the ExchangeAdapter interface for Binance.com (not Binance US or other variants).
 *
 * Key differences from Mercado Bitcoin:
 * - HMAC-SHA256 signed requests (no OAuth2)
 * - Market orders fill synchronously (no polling needed)
 * - Symbol format: SOLBRL (no hyphen)
 * - Quantity precision per LOT_SIZE filter (fetched and cached)
 * - Binance uses BRL trading pairs: SOLBRL, HYPEUSDT, etc.
 */

import { v4 as uuidv4 } from 'uuid';
import { BinanceClient } from './client';
import { BinanceEndpoints } from './endpoints';
import { ExchangeAdapter, CandleResolution, Portfolio, TradeRecord } from '../types';
import { computeBaseRatioBps, computeDeviationBps, brlToBase, isSlippageAcceptable } from '../../math';
import { logger } from '../../core/tracker/logger';
import { BINANCE_FILL_POLL_INTERVAL_MS, BINANCE_FILL_POLL_MAX_ATTEMPTS } from '../../constants';
import { BinanceConfig } from '../../config';

const BINANCE_RESOLUTION_MAP: Record<CandleResolution, string> = {
  '1m': '1m',
  '15m': '15m',
  '1h': '1h',
  '1d': '1d',
};

export class BinanceAdapter implements ExchangeAdapter {
  private endpoints: BinanceEndpoints;
  private baseAsset: string;
  private quoteAsset: string;
  private binanceSymbol: string;  // e.g. SOLBRL
  private cachedLotStepSize: number | null = null;

  constructor(
    private binanceConfig: BinanceConfig,
    private dryRun: boolean,
    private maxSlippageBps: number,
    private symbol: string = 'SOL-BRL',  // human-readable format
  ) {
    this.baseAsset = symbol.split('-')[0]!;      // SOL
    this.quoteAsset = symbol.split('-')[1]!;     // BRL
    this.binanceSymbol = symbol.replace('-', ''); // SOLBRL
    const client = new BinanceClient(
      binanceConfig.apiKey,
      binanceConfig.apiSecret,
      binanceConfig.apiBaseUrl,
    );
    this.endpoints = new BinanceEndpoints(client);
  }

  /**
   * Fetches the current base/quote price (e.g. SOL/BRL) via the public ticker endpoint.
   * No authentication required — costs 1 API request.
   */
  async getPrice(): Promise<number> {
    const resp = await this.endpoints.getTickerPrice(this.binanceSymbol);
    const price = parseFloat(resp.price);
    if (price <= 0) throw new Error(`Invalid ${this.binanceSymbol} price: ${resp.price}`);
    return price;
  }

  /**
   * Fetches balances and builds a Portfolio.
   * If knownPrice is provided, skips the price fetch (saves 1 API request).
   * Costs 1 authenticated request (account) when knownPrice is supplied,
   * or 2 requests (account + ticker) when called standalone.
   */
  async getPortfolio(knownPrice?: number): Promise<Portfolio> {
    const [account, basePrice] = await Promise.all([
      this.endpoints.getAccount(),
      knownPrice !== undefined ? Promise.resolve(knownPrice) : this.getPrice(),
    ]);

    const baseBalance = parseFloat(
      account.balances.find((b) => b.asset === this.baseAsset)?.free ?? '0',
    );
    const brlBalance = parseFloat(
      account.balances.find((b) => b.asset === this.quoteAsset)?.free ?? '0',
    );

    const baseValueBrl = baseBalance * basePrice;
    const totalValueBrl = baseValueBrl + brlBalance;
    const baseRatioBps = computeBaseRatioBps(baseValueBrl, totalValueBrl);

    return {
      baseBalance,
      brlBalance,
      basePrice,
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

    const record: TradeRecord = {
      id: uuidv4(),
      clientOrderId,
      exchangeOrderId: null,
      exchange: 'binance',
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
    };

    if (this.dryRun) {
      logger.info('[DRY RUN] Would execute Binance trade', {
        direction,
        brlAmount: brlAmount.toFixed(2),
        symbol: this.symbol,
      });
      record.status = 'DRY_RUN';
      return record;
    }

    // Build order request based on direction
    let orderRequest: Parameters<typeof this.endpoints.createOrder>[0];
    if (direction === 'BUY_BASE') {
      // BUY: spend brlAmount to acquire base assets
      orderRequest = {
        symbol: this.binanceSymbol,
        side: 'BUY',
        type: 'MARKET',
        quoteOrderQty: brlAmount.toFixed(2),
        newClientOrderId: clientOrderId,
      };
    } else {
      // SELL: calculate quantity of base assets to sell
      // Use LOT_SIZE precision (fetch once, cache)
      let baseQuantity = brlToBase(brlAmount, portfolioBefore.basePrice, 8);
      if (this.cachedLotStepSize === null) {
        try {
          const info = await this.endpoints.getExchangeInfo(this.binanceSymbol);
          const symbolInfo = info.symbols.find((s) => s.symbol === this.binanceSymbol);
          if (!symbolInfo) throw new Error(`No symbol info for ${this.binanceSymbol}`);
          const lotSize = symbolInfo.filters.find((f) => (f as any).filterType === 'LOT_SIZE');
          if (!lotSize) throw new Error(`No LOT_SIZE filter for ${this.binanceSymbol}`);
          this.cachedLotStepSize = parseFloat((lotSize as any).stepSize);
          logger.debug('Cached LOT_SIZE', {
            symbol: this.binanceSymbol,
            stepSize: this.cachedLotStepSize,
          });
        } catch (err) {
          logger.warn('Failed to fetch LOT_SIZE, using 8 decimals', {
            error: (err as Error).message,
          });
          this.cachedLotStepSize = 1e-8;
        }
      }

      // Floor quantity to nearest step
      baseQuantity = Math.floor(baseQuantity / this.cachedLotStepSize) * this.cachedLotStepSize;

      orderRequest = {
        symbol: this.binanceSymbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: baseQuantity.toFixed(8),
        newClientOrderId: clientOrderId,
      };
    }

    logger.info('Placing Binance order', {
      direction,
      brlAmount: brlAmount.toFixed(2),
      clientOrderId,
    });

    const orderResp = await this.endpoints.createOrder(orderRequest);
    record.exchangeOrderId = String(orderResp.orderId);

    // Binance returns fills synchronously for market orders
    // Check if the order filled immediately
    if (orderResp.status === 'FILLED' || orderResp.status === 'PARTIALLY_FILLED') {
      this.extractFillData(record, orderResp, portfolioBefore);
      logger.info('Binance order filled', {
        orderId: orderResp.orderId,
        baseFilled: (record.baseAmountFilled ?? 0).toFixed(6),
        brlFilled: (record.brlAmountFilled ?? 0).toFixed(2),
        fillPriceBrl: (record.fillPrice ?? 0).toFixed(2),
        feeBrl: (record.feeBrl ?? 0).toFixed(2),
      });
      return record;
    }

    // If not filled synchronously, poll (rare but possible)
    logger.debug('Order not filled synchronously, polling', {
      orderId: orderResp.orderId,
      status: orderResp.status,
    });

    const filled = await this.pollOrderFill(orderResp.orderId);
    if (filled.status === 'FILLED' || filled.status === 'PARTIALLY_FILLED') {
      this.extractFillData(record, filled, portfolioBefore);
      logger.info('Binance order filled (after poll)', {
        orderId: filled.orderId,
        baseFilled: (record.baseAmountFilled ?? 0).toFixed(6),
        brlFilled: (record.brlAmountFilled ?? 0).toFixed(2),
      });
    } else {
      record.status = 'FAILED';
      logger.warn('Binance order did not fill', {
        orderId: filled.orderId,
        status: filled.status,
      });
    }

    return record;
  }

  async getCandles(countback: number, resolution: CandleResolution): Promise<number[]> {
    const interval = BINANCE_RESOLUTION_MAP[resolution];
    const klines = await this.endpoints.getKlines(this.binanceSymbol, interval as any, countback);

    // Klines are [openTime, open, high, low, close, ...] — extract close (index 4)
    const pairs = klines.map((k) => ({ ts: k[0], close: parseFloat(k[4]) }));
    pairs.sort((a, b) => a.ts - b.ts);
    return pairs.map((p) => p.close);
  }

  /**
   * Poll order status until terminal state is reached.
   * Binance market orders usually fill synchronously, so polling is a fallback.
   */
  private async pollOrderFill(orderId: number): Promise<any> {
    const terminal = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'PARTIALLY_FILLED'];

    for (let attempt = 0; attempt < BINANCE_FILL_POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, BINANCE_FILL_POLL_INTERVAL_MS));
      try {
        const order = await this.endpoints.getOrder(this.binanceSymbol, orderId);
        if (terminal.includes(order.status)) return order;
        logger.debug('Polling Binance order fill', {
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
        if (attempt === BINANCE_FILL_POLL_MAX_ATTEMPTS - 1) throw err;
      }
    }
    return this.endpoints.getOrder(this.binanceSymbol, orderId);
  }

  /**
   * Extract fill data from Binance order response and populate TradeRecord.
   */
  private extractFillData(
    record: TradeRecord,
    orderResp: any,
    portfolioBefore: Portfolio,
  ): void {
    const executedQty = parseFloat(orderResp.executedQty);
    const cummulativeQuoteQty = parseFloat(orderResp.cummulativeQuoteQty);

    if (executedQty <= 0 || cummulativeQuoteQty <= 0) {
      record.status = 'FAILED';
      return;
    }

    const fillPrice = cummulativeQuoteQty / executedQty;

    // Calculate fees in BRL
    // Binance fees come in the fills array with commissionAsset
    let feeBrl = 0;
    if (orderResp.fills && Array.isArray(orderResp.fills)) {
      for (const fill of orderResp.fills) {
        const commission = parseFloat(fill.commission);
        if (fill.commissionAsset === this.quoteAsset) {
          // Fee is already in BRL
          feeBrl += commission;
        } else if (fill.commissionAsset === this.baseAsset) {
          // Fee is in base asset — convert to BRL
          feeBrl += commission * fillPrice;
          logger.warn('Binance fee in base asset, converted to BRL', {
            asset: fill.commissionAsset,
            commission: commission.toFixed(6),
            feeBrl: (commission * fillPrice).toFixed(2),
          });
        } else {
          // Fee in BNB or other asset — ignore (zero out)
          logger.warn('Ignoring non-BRL fee', {
            asset: fill.commissionAsset,
            commission: commission.toFixed(8),
          });
        }
      }
    }

    // Check slippage
    if (!isSlippageAcceptable(portfolioBefore.basePrice, fillPrice, this.maxSlippageBps)) {
      logger.warn('Slippage exceeded threshold', {
        expectedBrl: portfolioBefore.basePrice,
        fillBrl: fillPrice,
        maxSlippageBps: this.maxSlippageBps,
      });
    }

    record.baseAmountFilled = executedQty;
    record.brlAmountFilled = cummulativeQuoteQty;
    record.fillPrice = fillPrice;
    record.feeBrl = feeBrl;
    record.status = 'FILLED';
  }
}
