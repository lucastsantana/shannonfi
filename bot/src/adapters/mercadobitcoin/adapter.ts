import { v4 as uuidv4 } from 'uuid';
import { MbClient } from './client';
import { MbEndpoints } from './endpoints';
import { ExchangeAdapter, CandleResolution, Portfolio, TradeRecord } from '../types';
import { computeBaseRatioBps, computeDeviationBps, brlToBase, isSlippageAcceptable } from '../../math';
import { logger } from '../../core/tracker/logger';
import {
  MB_FILL_POLL_INTERVAL_MS,
  MB_FILL_POLL_MAX_ATTEMPTS,
} from '../../constants';
import { MercadoBitcoinConfig } from '../../config';
import { getMercadoBitcoinCredentials } from '../../core/keyring';

const MB_RESOLUTION_MAP: Record<CandleResolution, import('./raw-types').MbCandleResolution> = {
  '1m': '1m',
  '15m': '15m',
  '1h': '1h',
  '1d': '1d',
};

export class MercadoBitcoinAdapter implements ExchangeAdapter {
  private endpoints: MbEndpoints;
  private baseAsset: string;
  // Cached account ID — fetched once, stable for the lifetime of the process.
  private cachedAccountId: string | null = null;

  constructor(
    private mbConfig: MercadoBitcoinConfig,
    private dryRun: boolean,
    private maxSlippageBps: number,
    private symbol: string,
  ) {
    if (!symbol || !symbol.includes('-')) {
      throw new Error(`Invalid symbol format: ${symbol}. Expected BASE-QUOTE format (e.g. SOL-BRL)`);
    }
    this.baseAsset = symbol.split('-')[0]!;

    // Load credentials from environment variables (GitHub Actions) or GNOME Keyring (local PM2)
    let clientId = process.env.MB_CLIENT_ID;
    let clientSecret = process.env.MB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      // Fall back to GNOME Keyring for local PM2 instance
      const creds = getMercadoBitcoinCredentials();
      clientId = creds.clientId;
      clientSecret = creds.clientSecret;
    }

    const client = new MbClient(clientId, clientSecret, mbConfig.apiBaseUrl);
    this.endpoints = new MbEndpoints(client, symbol);
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
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid SOL/BRL price: ${latest}`);
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

    const [balances, basePrice] = await Promise.all([
      this.endpoints.getBalances(accountId),
      knownPrice !== undefined ? Promise.resolve(knownPrice) : this.getPrice(),
    ]);

    const baseBalanceStr = balances.find((b) => b.symbol === this.baseAsset)?.available ?? '0';
    const baseBalance = parseFloat(baseBalanceStr);
    if (!Number.isFinite(baseBalance) || baseBalance < 0) throw new Error(`Invalid ${this.baseAsset} balance: ${baseBalanceStr}`);

    const brlBalanceStr = balances.find((b) => b.symbol === 'BRL')?.available ?? '0';
    const brlBalance = parseFloat(brlBalanceStr);
    if (!Number.isFinite(brlBalance) || brlBalance < 0) throw new Error(`Invalid BRL balance: ${brlBalanceStr}`);

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
    const accountId = await this.getAccountId();

    const record: TradeRecord = {
      id: uuidv4(),
      clientOrderId,
      exchangeOrderId: null,
      exchange: 'mercadobitcoin',
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
      logger.info('[DRY RUN] Would execute Mercado Bitcoin trade', {
        direction,
        brlAmount: brlAmount.toFixed(2),
        symbol: this.symbol,
      });
      record.status = 'DRY_RUN';
      return record;
    }

    const orderRequest =
      direction === 'BUY_BASE'
        ? {
            type: 'market' as const,
            side: 'buy' as const,
            cost: brlAmount,
            externalId: clientOrderId,
          }
        : {
            type: 'market' as const,
            side: 'sell' as const,
            qty: brlToBase(brlAmount, portfolioBefore.basePrice, 6).toFixed(6),
            externalId: clientOrderId,
          };

    logger.info('Placing Mercado Bitcoin order', {
      direction,
      brlAmount: brlAmount.toFixed(2),
      clientOrderId,
    });

    const created = await this.endpoints.createOrder(accountId, orderRequest);
    record.exchangeOrderId = created.orderId;

    const filled = await this.pollOrderFill(accountId, created.orderId);
    const normalizedStatus =
      filled.status === 'filled' ? 'FILLED'
      : (filled.status.toUpperCase() as TradeRecord['status']);
    record.status = normalizedStatus;

    if (filled.status !== 'filled' && filled.status !== 'partially_filled') {
      logger.warn('Mercado Bitcoin order did not fill', {
        orderId: created.orderId,
        status: filled.status,
      });
      return record;
    }

    const filledQtyStr = filled.filledQty;
    const filledQty = parseFloat(filledQtyStr);
    if (!Number.isFinite(filledQty) || filledQty < 0) throw new Error(`Invalid filled quantity: ${filledQtyStr}`);

    const fillPriceBrl = filled.avgPrice;
    if (!Number.isFinite(fillPriceBrl) || fillPriceBrl <= 0) throw new Error(`Invalid fill price: ${fillPriceBrl}`);

    // cost is set for BUY (BRL spent); for SELL it is absent — derive from qty × price
    const brlFilled = filled.cost ?? filledQty * fillPriceBrl;

    const feeBrlStr = filled.fee;
    const feeBrl = parseFloat(feeBrlStr);
    if (!Number.isFinite(feeBrl) || feeBrl < 0) throw new Error(`Invalid fee: ${feeBrlStr}`);

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

    logger.info('Mercado Bitcoin order filled', {
      orderId: created.orderId,
      baseFilled: filledQty.toFixed(6),
      brlFilled: brlFilled.toFixed(2),
      fillPriceBrl: fillPriceBrl.toFixed(2),
      feeBrl: feeBrl.toFixed(2),
    });

    return record;
  }

  async getCandles(countback: number, resolution: CandleResolution): Promise<number[]> {
    const mbResolution = MB_RESOLUTION_MAP[resolution];
    const resp = await this.endpoints.getCandles(countback, mbResolution);
    const pairs = resp.t.map((ts, i) => {
      const closeStr = resp.c[i] ?? '0';
      const close = parseFloat(closeStr);
      if (!Number.isFinite(close) || close <= 0) {
        throw new Error(`Invalid candle close price: ${closeStr}`);
      }
      return { ts, close };
    });
    pairs.sort((a, b) => a.ts - b.ts);
    return pairs.map((p) => p.close);
  }

  /**
   * Fetch candles with volume data for a specific symbol (scanner use only).
   * NOT on the ExchangeAdapter interface — scanner-specific.
   * Returns close prices along with volume in base asset units.
   */
  async getCandlesWithVolume(
    symbol: string,
    countback: number,
  ): Promise<Array<{ close: number; volume: number; timestamp: number }>> {
    const resp = await this.endpoints.getCandles(countback, '1d', symbol);
    const data = resp.t.map((ts, i) => {
      const closeStr = resp.c[i] ?? '0';
      const volumeStr = resp.v[i] ?? '0';
      const close = parseFloat(closeStr);
      const volume = parseFloat(volumeStr);
      if (!Number.isFinite(close) || close <= 0) throw new Error(`Invalid candle close: ${closeStr}`);
      if (!Number.isFinite(volume) || volume < 0) throw new Error(`Invalid volume: ${volumeStr}`);
      return { timestamp: ts, close, volume };
    });
    data.sort((a, b) => a.timestamp - b.timestamp);
    return data;
  }

  /**
   * Get ticker data (24h stats) for specific symbols.
   * NOT on the ExchangeAdapter interface — scanner-specific.
   * Note: /tickers returns an array of tickers for the requested symbols.
   */
  async getTickersForSymbols(
    symbols: string[],
  ): Promise<Array<{ pair: string; vol: string; last: string }>> {
    const tickers = await this.endpoints.getTickersForSymbols(symbols);
    // Return only essential fields for scanner
    return tickers.map((ticker) => ({
      pair: ticker.pair,
      vol: ticker.vol,
      last: ticker.last,
    }));
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
