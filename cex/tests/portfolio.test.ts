import { describe, it, expect, vi } from 'vitest';
import { PortfolioService } from '../src/bot/portfolio';
import { CoinbaseEndpoints } from '../src/coinbase/endpoints';
import {
  ListAccountsResponse,
  GetBestBidAskResponse,
} from '../src/coinbase/types';

function makeAccountsResponse(
  solBalance: string,
  usdBalance: string,
): ListAccountsResponse {
  return {
    accounts: [
      {
        uuid: 'sol-uuid',
        name: 'SOL Wallet',
        currency: 'SOL',
        available_balance: { value: solBalance, currency: 'SOL' },
        default: true,
        active: true,
        created_at: '',
        updated_at: '',
        deleted_at: null,
        type: 'ACCOUNT_TYPE_CRYPTO',
        ready: true,
        hold: { value: '0', currency: 'SOL' },
      },
      {
        uuid: 'usd-uuid',
        name: 'USD Cash',
        currency: 'USD',
        available_balance: { value: usdBalance, currency: 'USD' },
        default: true,
        active: true,
        created_at: '',
        updated_at: '',
        deleted_at: null,
        type: 'ACCOUNT_TYPE_FIAT',
        ready: true,
        hold: { value: '0', currency: 'USD' },
      },
    ],
    has_next: false,
    cursor: '',
    size: 2,
  };
}

function makePricebook(bid: string, ask: string): GetBestBidAskResponse {
  return {
    pricebooks: [
      {
        product_id: 'SOL-USD',
        bids: [{ price: bid, size: '100' }],
        asks: [{ price: ask, size: '100' }],
        time: new Date().toISOString(),
      },
    ],
  };
}

describe('PortfolioService.getPortfolio', () => {
  it('computes mid price and ratios correctly', async () => {
    const endpoints = {
      listAccounts: vi.fn().mockResolvedValue(makeAccountsResponse('10', '500')),
      getBestBidAsk: vi.fn().mockResolvedValue(makePricebook('149', '151')),
    } as unknown as CoinbaseEndpoints;

    const service = new PortfolioService(endpoints);
    const portfolio = await service.getPortfolio();

    expect(portfolio.solBalance).toBe(10);
    expect(portfolio.usdBalance).toBe(500);
    expect(portfolio.solPrice).toBe(150);           // (149 + 151) / 2
    expect(portfolio.solValueUsd).toBeCloseTo(1500); // 10 * 150
    expect(portfolio.totalValueUsd).toBeCloseTo(2000);
    expect(portfolio.solRatioBps).toBe(7500);        // 1500/2000 * 10000
    expect(portfolio.deviationBps).toBe(2500);       // |7500 - 5000|
  });

  it('throws when SOL account is missing', async () => {
    const endpoints = {
      listAccounts: vi.fn().mockResolvedValue({
        accounts: [
          {
            uuid: 'usd-uuid',
            currency: 'USD',
            available_balance: { value: '500', currency: 'USD' },
            active: true,
          },
        ],
        has_next: false,
        cursor: '',
        size: 1,
      }),
      getBestBidAsk: vi.fn().mockResolvedValue(makePricebook('149', '151')),
    } as unknown as CoinbaseEndpoints;

    const service = new PortfolioService(endpoints);
    await expect(service.getPortfolio()).rejects.toThrow('SOL account not found');
  });

  it('throws on empty pricebook', async () => {
    const endpoints = {
      listAccounts: vi.fn().mockResolvedValue(makeAccountsResponse('10', '500')),
      getBestBidAsk: vi.fn().mockResolvedValue({ pricebooks: [] }),
    } as unknown as CoinbaseEndpoints;

    const service = new PortfolioService(endpoints);
    await expect(service.getPortfolio()).rejects.toThrow('pricebook unavailable');
  });
});
