import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RebalancerBot } from '../src/bot/rebalancer';
import { PortfolioService } from '../src/bot/portfolio';
import { TraderService } from '../src/bot/trader';
import { TradeHistoryService } from '../src/tracker/history';
import { PnlService } from '../src/tracker/pnl';
import { CostBasisService } from '../src/tracker/costbasis';
import { TaxService } from '../src/tracker/tax';
import { VolatilityService } from '../src/tracker/volatility';
import { MetricsService } from '../src/tracker/metrics';
import { Portfolio, TradeRecord } from '../src/coinbase/types';
import { Config } from '../src/config';

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
  tradeHistoryPath: '/tmp/test-history.json',
  coinbaseApiBaseUrl: 'https://api.coinbase.com',
  useAdaptiveThreshold: false,
  thresholdVolatilityMultiplier: 1.5,
  volatilityWindowDays: 30,
  neverExceedExemptionLimit: false,
  fxApiUrl: 'https://api.frankfurter.app/latest?from=USD&to=BRL',
  costBasisPath: '/tmp/test-cost-basis.json',
  taxEventsPath: '/tmp/test-tax-events.json',
  portfolioSnapshotsPath: '/tmp/test-snapshots.json',
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
    solAmountFilled: 3.33,
    usdAmountFilled: 500,
    fillPrice: 150,
    feeUsd: 2,
    status: 'DRY_RUN',
    portfolioBefore: portfolio,
    portfolioAfter: null,
    dryRun: true,
    brlSnapshot: null,
    realizedGainBrl: null,
    tradeDateBRT: null,
    ...overrides,
  };
}

function makeBot(historyOverrides: Partial<TradeHistoryService> = {}, configOverrides: Partial<Config> = {}) {
  const portfolio = { getPortfolio: vi.fn() } as unknown as PortfolioService;
  const trader = { executeTrade: vi.fn() } as unknown as TraderService;
  const history = {
    appendTrade: vi.fn(),
    appendSnapshot: vi.fn(),
    readTrades: vi.fn().mockReturnValue([]),
    readSnapshots: vi.fn().mockReturnValue([]),
    getLastRebalanceTime: vi.fn().mockReturnValue(0),
    getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: null, direction: null }),
    ...historyOverrides,
  } as unknown as TradeHistoryService;
  const pnl = { logRebalance: vi.fn(), printReport: vi.fn() } as unknown as PnlService;
  const costBasis = {
    getLedger: vi.fn().mockReturnValue({ sol: { averageCostBrl: 700, totalSol: 20 }, usd: { averageCostBrl: 5.5, totalUsd: 1000 }, lastUpdated: '' }),
    updateAfterBuy: vi.fn(),
    updateAfterSell: vi.fn().mockReturnValue(500),
    computeRealizedGainBrl: vi.fn().mockReturnValue(500),
  } as unknown as CostBasisService;
  const tax = {
    getMonthlyVolumeBrl: vi.fn().mockReturnValue(0),
    buildTaxEvent: vi.fn().mockReturnValue({ cumMonthlyVolumeBrl: 500, cumMonthlyGainBrl: 500, tradedVolumeBrl: 500, exempt: true, paymentDeadline: null }),
    appendTaxEvent: vi.fn(),
  } as unknown as TaxService;
  const volatility = {
    computeAdaptiveThresholdBps: vi.fn().mockResolvedValue(100),
  } as unknown as VolatilityService;
  const metrics = {
    computeMetrics: vi.fn().mockReturnValue({}),
    printReport: vi.fn(),
  } as unknown as MetricsService;

  const config = { ...testConfig, ...configOverrides };
  const bot = new RebalancerBot(portfolio, trader, history, pnl, costBasis, tax, volatility, metrics, config);
  return { bot, portfolio, trader, history, pnl, costBasis, tax };
}

describe('RebalancerBot.checkAndRebalance', () => {
  it('skips when portfolio is below minimum value', async () => {
    const { bot, portfolio, trader } = makeBot();
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({ totalValueUsd: 10, solRatioBps: 7500 }),
    );
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('skips when drift is below threshold', async () => {
    const { bot, portfolio, trader } = makeBot();
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueUsd: 1010,
        usdBalance: 990,
        totalValueUsd: 2000,
        solRatioBps: 5050,
        deviationBps: 50,
      }),
    );
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('triggers trade when drift exceeds threshold', async () => {
    const { bot, portfolio, trader } = makeBot();
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalledWith('SELL_SOL', expect.any(Number), expect.any(Object));
  });

  it('records trade when triggered', async () => {
    const { bot, portfolio, trader, history, pnl } = makeBot();
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(history.appendTrade).toHaveBeenCalled();
    expect(pnl.logRebalance).toHaveBeenCalled();
  });

  it('restores cooldown from trade history on construction', async () => {
    const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
    const { bot, portfolio, trader } = makeBot({
      getLastRebalanceTime: vi.fn().mockReturnValue(thirtyMinsAgo),
    });
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('respects cooldown between rebalances', async () => {
    const { bot, portfolio, trader } = makeBot();
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalledTimes(1);
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalledTimes(1);
  });

  // ─── Day-trade guard ───────────────────────────────────────────────────────

  it('blocks opposite-direction trade on same BRT day', async () => {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    // Last trade was a SELL_SOL today
    const { bot, portfolio, trader } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: todayBRT, direction: 'SELL_SOL' }),
    });
    // Portfolio now needs a BUY_SOL (opposite direction)
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueUsd: 500,
        usdBalance: 1500,
        totalValueUsd: 2000,
        solRatioBps: 2500, // 25% SOL — needs BUY
        deviationBps: 2500,
      }),
    );
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('allows same-direction trade on same BRT day', async () => {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    // Last trade was a SELL_SOL today — same direction should be allowed
    const { bot, portfolio, trader } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: todayBRT, direction: 'SELL_SOL' }),
    });
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio()); // 75% SOL → SELL_SOL
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalled();
  });

  it('allows opposite-direction trade on a different BRT day', async () => {
    // Last trade was yesterday
    const { bot, portfolio, trader } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: '2020-01-01', direction: 'SELL_SOL' }),
    });
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueUsd: 500,
        usdBalance: 1500,
        totalValueUsd: 2000,
        solRatioBps: 2500,
        deviationBps: 2500,
      }),
    );
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord({ direction: 'BUY_SOL' }));
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalled();
  });

  // ─── Adaptive threshold ────────────────────────────────────────────────────

  it('uses adaptive threshold when useAdaptiveThreshold=true', async () => {
    const { bot, portfolio, trader } = makeBot({}, { useAdaptiveThreshold: true });
    // Adaptive threshold returns 200 bps; portfolio deviation is 100 bps → should NOT trade
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueUsd: 1100,
        usdBalance: 900,
        totalValueUsd: 2000,
        solRatioBps: 5500,
        deviationBps: 500, // 5% deviation
      }),
    );
    // Override volatility mock to return 600 bps threshold (higher than 500 deviation)
    const { volatility: vol } = makeBot({}, { useAdaptiveThreshold: true });
    (bot as any).volatility = { computeAdaptiveThresholdBps: vi.fn().mockResolvedValue(600) };
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('falls back to static threshold when adaptive fetch fails', async () => {
    const { bot, portfolio, trader } = makeBot({}, { useAdaptiveThreshold: true });
    // Make volatility throw
    (bot as any).volatility = {
      computeAdaptiveThresholdBps: vi.fn().mockRejectedValue(new Error('network error')),
    };
    // Portfolio 75% SOL, static threshold 100 bps → should trade despite volatility failure
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalled();
  });
});
