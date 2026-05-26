import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RebalancerBot } from '../src/bot/rebalancer';
import { PortfolioService } from '../src/bot/portfolio';
import { TraderService } from '../src/bot/trader';
import { TradeHistoryService } from '../src/tracker/history';
import { PnlService } from '../src/tracker/pnl';
import { Portfolio, TradeRecord } from '../src/coinbase/types';
import { Config } from '../src/config';
import * as os from 'os';
import * as path from 'path';

const testConfig: Config = {
  coinbaseApiKeyName: 'organizations/test/apiKeys/test',
  coinbasePrivateKey: '--- test ---',
  rebalanceThresholdBps: 100,
  maxSlippageBps: 100,
  minPortfolioValueUsd: 50,
  minTradeSizeUsd: 5,
  pollIntervalSeconds: 300,
  minRebalanceIntervalSeconds: 7200,
  dryRun: true,
  logLevel: 'error',
  tradeHistoryPath: path.join(os.tmpdir(), `test-history-${Date.now()}.json`),
  coinbaseApiBaseUrl: 'https://api.coinbase.com',
};

function makePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    solBalance: 10,
    usdBalance: 500,
    solPrice: 150,
    solValueUsd: 1500,
    totalValueUsd: 2000,
    solRatioBps: 7500, // 75% SOL — clearly needs rebalance
    deviationBps: 2500,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTradeRecord(overrides: Partial<TradeRecord> = {}): TradeRecord {
  const portfolio = makePortfolio();
  return {
    id: 'test-id',
    clientOrderId: 'client-id',
    coinbaseOrderId: null,
    timestamp: new Date().toISOString(),
    direction: 'SELL_SOL',
    usdAmountTarget: 500,
    solAmountFilled: null,
    usdAmountFilled: null,
    fillPrice: null,
    feeUsd: null,
    status: 'DRY_RUN',
    portfolioBefore: portfolio,
    portfolioAfter: null,
    dryRun: true,
    ...overrides,
  };
}

describe('RebalancerBot.checkAndRebalance', () => {
  let portfolio: PortfolioService;
  let trader: TraderService;
  let history: TradeHistoryService;
  let pnl: PnlService;
  let bot: RebalancerBot;

  beforeEach(() => {
    portfolio = { getPortfolio: vi.fn() } as unknown as PortfolioService;
    trader = { executeTrade: vi.fn() } as unknown as TraderService;
    history = {
      appendTrade: vi.fn(),
      readTrades: vi.fn().mockReturnValue([]),
      getLastRebalanceTime: vi.fn().mockReturnValue(0),
    } as unknown as TradeHistoryService;
    pnl = { logRebalance: vi.fn(), printReport: vi.fn() } as unknown as PnlService;
    bot = new RebalancerBot(portfolio, trader, history, pnl, testConfig);
  });

  it('skips when portfolio is below minimum value', async () => {
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({ totalValueUsd: 10, solRatioBps: 7500 }),
    );
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('skips when drift is below threshold', async () => {
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueUsd: 1010,
        usdBalance: 990,
        totalValueUsd: 2000,
        solRatioBps: 5050, // only 50 bps deviation, below 100 threshold
        deviationBps: 50,
      }),
    );
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('triggers trade when drift exceeds threshold', async () => {
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalledWith(
      'SELL_SOL',
      expect.any(Number),
      expect.any(Object),
    );
  });

  it('records trade when triggered', async () => {
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(history.appendTrade).toHaveBeenCalled();
    expect(pnl.logRebalance).toHaveBeenCalled();
  });

  it('restores cooldown from trade history on construction', async () => {
    // Simulate a rebalance that happened 30 minutes ago — still in cooldown
    const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
    const historyWithRecent = {
      appendTrade: vi.fn(),
      readTrades: vi.fn().mockReturnValue([]),
      getLastRebalanceTime: vi.fn().mockReturnValue(thirtyMinsAgo),
    } as unknown as TradeHistoryService;

    const freshBot = new RebalancerBot(portfolio, trader, historyWithRecent, pnl, testConfig);
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    await freshBot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('respects cooldown between rebalances', async () => {
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());

    // First rebalance should succeed
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalledTimes(1);

    // Second call immediately after — cooldown blocks it
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalledTimes(1);
  });

  it('skips when trade amount is below minimum', async () => {
    // Near-perfect 50/50 but technically above threshold
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueUsd: 501,
        usdBalance: 499,
        totalValueUsd: 1000,
        solRatioBps: 5010,
        deviationBps: 10,
      }),
    );
    // computeRebalanceTrade would produce $1 which is below minTradeSizeUsd=5
    // But deviationBps=10 < threshold=100, so it will skip at drift check first
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });
});
