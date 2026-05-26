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
import { Portfolio, TradeRecord } from '../src/mb/types';
import { Config } from '../src/config';

const testConfig: Config = {
  mbClientId: 'test-client-id',
  mbClientSecret: 'test-client-secret',
  mbApiBaseUrl: 'https://api.mercadobitcoin.net/api/v4',
  rebalanceThresholdBps: 100,
  maxSlippageBps: 100,
  minPortfolioValueBrl: 200,
  minTradeSizeBrl: 20,
  pollIntervalSeconds: 300,
  minRebalanceIntervalSeconds: 7200,
  dryRun: true,
  logLevel: 'error',
  tradeHistoryPath: '/tmp/mb-test-history.json',
  portfolioSnapshotsPath: '/tmp/mb-test-snapshots.json',
  costBasisPath: '/tmp/mb-test-costbasis.json',
  taxEventsPath: '/tmp/mb-test-tax.json',
  useAdaptiveThreshold: false,
  thresholdVolatilityMultiplier: 1.5,
  volatilityWindowDays: 30,
  neverExceedExemptionLimit: false,
};

function makePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    solBalance: 10,
    brlBalance: 2000,
    solPrice: 400,
    solValueBrl: 4000,
    totalValueBrl: 6000,
    solRatioBps: 6667, // ~67% SOL — needs rebalance
    deviationBps: 1667,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTradeRecord(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'test-id',
    clientOrderId: 'client-id',
    mbOrderId: null,
    timestamp: new Date().toISOString(),
    direction: 'SELL_SOL',
    brlAmountTarget: 1000,
    solAmountFilled: 2.5,
    brlAmountFilled: 1000,
    fillPrice: 400,
    feeBrl: 7,
    status: 'DRY_RUN',
    portfolioBefore: makePortfolio(),
    portfolioAfter: null,
    dryRun: true,
    realizedGainBrl: null,
    tradeDateBRT: null,
    ...overrides,
  };
}

function makeBot(
  historyOverrides: Partial<TradeHistoryService> = {},
  configOverrides: Partial<Config> = {},
) {
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
    getLedger: vi.fn().mockReturnValue({ sol: { averageCostBrl: 400, totalSol: 10 }, lastUpdated: '' }),
    updateAfterBuy: vi.fn(),
    updateAfterSell: vi.fn().mockReturnValue(200),
    computeRealizedGainBrl: vi.fn().mockReturnValue(200),
  } as unknown as CostBasisService;
  const tax = {
    getMonthlySalesBrl: vi.fn().mockReturnValue(0),
    buildTaxEvent: vi.fn().mockReturnValue({
      cumMonthlySalesBrl: 1000,
      cumMonthlyGainBrl: 200,
      tradedVolumeBrl: 1000,
      exempt: true,
      paymentDeadline: null,
    }),
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

describe('RebalancerBot (MB)', () => {
  it('skips when portfolio is below minimum BRL value', async () => {
    const { bot, portfolio, trader } = makeBot();
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({ totalValueBrl: 100, solRatioBps: 6667 }),
    );
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('skips when drift is below threshold', async () => {
    const { bot, portfolio, trader } = makeBot();
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueBrl: 3020,
        brlBalance: 2980,
        totalValueBrl: 6000,
        solRatioBps: 5033,
        deviationBps: 33,
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

  // ─── Day-trade guard ────────────────────────────────────────────────────────

  it('blocks opposite-direction trade on same BRT day', async () => {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const { bot, portfolio, trader } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: todayBRT, direction: 'SELL_SOL' }),
    });
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueBrl: 1500,
        brlBalance: 4500,
        totalValueBrl: 6000,
        solRatioBps: 2500,
        deviationBps: 2500,
      }),
    );
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('allows same-direction trade on same BRT day', async () => {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const { bot, portfolio, trader } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: todayBRT, direction: 'SELL_SOL' }),
    });
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalled();
  });

  it('allows opposite-direction trade on a different BRT day', async () => {
    const { bot, portfolio, trader } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: '2020-01-01', direction: 'SELL_SOL' }),
    });
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueBrl: 1500,
        brlBalance: 4500,
        totalValueBrl: 6000,
        solRatioBps: 2500,
        deviationBps: 2500,
      }),
    );
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord({ direction: 'BUY_SOL' }));
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalled();
  });

  // ─── Exemption cap (SELL only) ─────────────────────────────────────────────

  it('caps SELL trade when near exemption limit', async () => {
    const { bot, portfolio, trader, tax } = makeBot({}, { neverExceedExemptionLimit: true });
    // R$34,000 sales so far → R$650 remaining before R$34,650 cap
    vi.mocked(tax.getMonthlySalesBrl).mockReturnValue(34_000);
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    // Trade should be called with capped amount ≤ 650
    const call = vi.mocked(trader.executeTrade).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![1]).toBeLessThanOrEqual(650);
  });

  it('skips SELL trade when exemption limit is exhausted', async () => {
    const { bot, portfolio, trader, tax } = makeBot({}, { neverExceedExemptionLimit: true });
    // R$34,640 sales → only R$10 remaining, below minTradeSizeBrl=20
    vi.mocked(tax.getMonthlySalesBrl).mockReturnValue(34_640);
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('does NOT cap BUY trades for exemption limit', async () => {
    const { bot, portfolio, trader, tax } = makeBot({}, { neverExceedExemptionLimit: true });
    vi.mocked(tax.getMonthlySalesBrl).mockReturnValue(34_000);
    // Portfolio needs BUY (BRL overweight)
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(
      makePortfolio({
        solValueBrl: 1500,
        brlBalance: 4500,
        totalValueBrl: 6000,
        solRatioBps: 2500,
        deviationBps: 2500,
      }),
    );
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord({ direction: 'BUY_SOL' }));
    await bot.checkAndRebalance();
    // BUY should proceed uncapped
    expect(trader.executeTrade).toHaveBeenCalled();
    const call = vi.mocked(trader.executeTrade).mock.calls[0];
    expect(call![1]).toBeGreaterThan(650); // not capped to exemption remaining
  });

  // ─── Adaptive threshold ────────────────────────────────────────────────────

  it('uses adaptive threshold when useAdaptiveThreshold=true', async () => {
    const { bot, portfolio, trader } = makeBot({}, { useAdaptiveThreshold: true });
    (bot as any).volatility = { computeAdaptiveThresholdBps: vi.fn().mockResolvedValue(2000) };
    // deviationBps 1667 < threshold 2000 → should NOT trade
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).not.toHaveBeenCalled();
  });

  it('falls back to static threshold when adaptive fetch fails', async () => {
    const { bot, portfolio, trader } = makeBot({}, { useAdaptiveThreshold: true });
    (bot as any).volatility = {
      computeAdaptiveThresholdBps: vi.fn().mockRejectedValue(new Error('network error')),
    };
    vi.mocked(portfolio.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(trader.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(trader.executeTrade).toHaveBeenCalled();
  });
});
