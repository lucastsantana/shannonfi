import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoinbaseAdapter } from '../../../src/adapters/coinbase/adapter';
import { Portfolio } from '../../../src/adapters/types';
import { CoinbaseConfig } from '../../../src/config';

// Exercise the BRL<->USD conversion logic at the adapter boundary — the actual
// risk area of this adapter — without making any real HTTP calls. `endpoints`
// and `fxRate` are swapped for mocks after construction, same pattern already
// used for RebalancerBot's services in rebalancer.test.ts.

const PTAX = 5.0; // 1 USD = R$5.00, chosen so BRL amounts are easy to eyeball

function makeAdapter() {
  process.env.COINBASE_API_KEY_NAME = 'test-key-name';
  process.env.COINBASE_API_KEY_SECRET = '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----';

  const config: CoinbaseConfig = { apiBaseUrl: 'https://api.coinbase.com' };
  const adapter = new CoinbaseAdapter(config, false, 100, 'BTC-USD');

  const mockEndpoints = {
    getCandles: vi.fn(),
    getAccounts: vi.fn(),
    getProduct: vi.fn(),
    createOrder: vi.fn(),
    getOrder: vi.fn(),
  };
  const mockFxRate = { getUsdBrlRate: vi.fn().mockResolvedValue(PTAX) };

  (adapter as any).endpoints = mockEndpoints;
  (adapter as any).fxRate = mockFxRate;

  delete process.env.COINBASE_API_KEY_NAME;
  delete process.env.COINBASE_API_KEY_SECRET;

  return { adapter, mockEndpoints, mockFxRate };
}

describe('CoinbaseAdapter — BRL<->USD conversion at the boundary', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('getPrice() converts the USD candle close to BRL using the PTAX rate', async () => {
    const { adapter, mockEndpoints } = makeAdapter();
    mockEndpoints.getCandles.mockResolvedValue({ candles: [{ close: '60000', start: '0' }] });

    const priceBrl = await adapter.getPrice();
    expect(priceBrl).toBe(60_000 * PTAX);
  });

  it('getPortfolio() converts both the base price and the USD cash leg to BRL', async () => {
    const { adapter, mockEndpoints } = makeAdapter();
    mockEndpoints.getAccounts.mockResolvedValue({
      accounts: [
        { currency: 'BTC', available_balance: { value: '0.5', currency: 'BTC' } },
        { currency: 'USD', available_balance: { value: '1000', currency: 'USD' } },
      ],
      has_next: false,
      cursor: '',
    });

    const portfolio: Portfolio = await adapter.getPortfolio(60_000 * PTAX); // knownPrice already in BRL

    expect(portfolio.baseBalance).toBe(0.5);
    expect(portfolio.brlBalance).toBe(1000 * PTAX); // USD cash leg converted to BRL
    expect(portfolio.baseValueBrl).toBe(0.5 * 60_000 * PTAX);
    expect(portfolio.totalValueBrl).toBe(portfolio.baseValueBrl + portfolio.brlBalance);
  });

  it('executeTrade() BUY converts the BRL amount to USD for quote_size', async () => {
    const { adapter, mockEndpoints } = makeAdapter();
    mockEndpoints.createOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'order-1', product_id: 'BTC-USD', side: 'BUY', client_order_id: 'c1' },
    });
    mockEndpoints.getOrder.mockResolvedValue({
      order: {
        order_id: 'order-1', product_id: 'BTC-USD', status: 'FILLED',
        filled_size: '0.01', average_filled_price: '60000', total_fees: '5', filled_value: '600',
      },
    });

    const portfolioBefore: Portfolio = {
      baseBalance: 0, brlBalance: 5000, basePrice: 60_000 * PTAX, baseValueBrl: 0,
      totalValueBrl: 5000, baseRatioBps: 0, deviationBps: 10_000, timestamp: new Date().toISOString(),
    };

    const trade = await adapter.executeTrade('BUY_BASE', 3000 /* BRL */, portfolioBefore);

    // 3000 BRL / PTAX(5.0) = 600 USD quote_size
    expect(mockEndpoints.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'BUY',
        order_configuration: { market_market_ioc: { quote_size: '600.00' } },
      }),
    );

    expect(trade.status).toBe('FILLED');
    expect(trade.baseAmountFilled).toBe(0.01);
    expect(trade.fillPrice).toBe(60_000 * PTAX);    // USD price converted to BRL
    expect(trade.brlAmountFilled).toBe(600 * PTAX);  // filled_value (USD) converted to BRL
    expect(trade.feeBrl).toBe(5 * PTAX);             // total_fees (USD) converted to BRL
    expect(trade.baseAsset).toBe('BTC');
  });

  it('executeTrade() SELL converts the BRL amount to a base-asset quantity via the BRL price', async () => {
    const { adapter, mockEndpoints } = makeAdapter();
    mockEndpoints.createOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'order-2', product_id: 'BTC-USD', side: 'SELL', client_order_id: 'c2' },
    });
    mockEndpoints.getOrder.mockResolvedValue({
      order: {
        order_id: 'order-2', product_id: 'BTC-USD', status: 'FILLED',
        filled_size: '0.01', average_filled_price: '60000', total_fees: '5', filled_value: '600',
      },
    });

    const basePriceBrl = 60_000 * PTAX; // R$300,000/BTC
    const portfolioBefore: Portfolio = {
      baseBalance: 0.01, brlBalance: 0, basePrice: basePriceBrl, baseValueBrl: 0.01 * basePriceBrl,
      totalValueBrl: 0.01 * basePriceBrl, baseRatioBps: 10_000, deviationBps: 10_000,
      timestamp: new Date().toISOString(),
    };

    // Sell R$3000-worth at a BRL price of R$300,000/BTC -> 0.01 BTC
    await adapter.executeTrade('SELL_BASE', 3000, portfolioBefore);

    expect(mockEndpoints.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'SELL',
        order_configuration: { market_market_ioc: { base_size: '0.01000000' } },
      }),
    );
  });

  it('dry run never calls createOrder and tags the record DRY_RUN', async () => {
    process.env.COINBASE_API_KEY_NAME = 'test-key-name';
    process.env.COINBASE_API_KEY_SECRET = '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----';
    const config: CoinbaseConfig = { apiBaseUrl: 'https://api.coinbase.com' };
    const adapter = new CoinbaseAdapter(config, /* dryRun */ true, 100, 'BTC-USD');
    delete process.env.COINBASE_API_KEY_NAME;
    delete process.env.COINBASE_API_KEY_SECRET;

    const mockFxRate = { getUsdBrlRate: vi.fn().mockResolvedValue(PTAX) };
    const mockEndpoints = { createOrder: vi.fn() };
    (adapter as any).fxRate = mockFxRate;
    (adapter as any).endpoints = mockEndpoints;

    const portfolioBefore: Portfolio = {
      baseBalance: 0, brlBalance: 5000, basePrice: 60_000 * PTAX, baseValueBrl: 0,
      totalValueBrl: 5000, baseRatioBps: 0, deviationBps: 10_000, timestamp: new Date().toISOString(),
    };
    const trade = await adapter.executeTrade('BUY_BASE', 3000, portfolioBefore);

    expect(mockEndpoints.createOrder).not.toHaveBeenCalled();
    expect(trade.status).toBe('DRY_RUN');
  });
});
