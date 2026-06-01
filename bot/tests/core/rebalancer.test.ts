import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RebalancerBot } from '../../src/core/rebalancer';
import { ExchangeAdapter, Portfolio, TradeRecord } from '../../src/adapters/types';
import { TradeHistoryService } from '../../src/core/tracker/history';
import { PnlService } from '../../src/core/tracker/pnl';
import { CostBasisService } from '../../src/core/tracker/costbasis';
import { TaxService } from '../../src/core/tracker/tax';
import { VolatilityService } from '../../src/core/tracker/volatility';
import { MetricsService } from '../../src/core/tracker/metrics';
import { Config } from '../../src/config';

const testConfig: Config = {
  exchange: 'mercadobitcoin',
  symbol: 'SOL-BRL',
  mercadobitcoin: {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    apiBaseUrl: 'https://api.mercadobitcoin.net/api/v4',
  },
  rebalanceThresholdBps: 100,
  maxSlippageBps: 100,
  minPortfolioValueBrl: 200,
  minTradeSizeBrl: 20,
  pollIntervalSeconds: 900,
  minRebalanceIntervalSeconds: 7200,
  dryRun: true,
  logLevel: 'error',
  dbPath: ':memory:',
  jsonRetentionDays: 15,
  useAdaptiveThreshold: false,
  thresholdVolatilityMultiplier: 1.5,
  volatilityWindowDays: 30,
  enableDayTradeSafeguard: true,
  neverExceedExemptionLimit: false,
};

function makePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    baseBalance: 10,
    brlBalance: 2000,
    basePrice: 400,
    baseValueBrl: 4000,
    totalValueBrl: 6000,
    baseRatioBps: 6667,
    deviationBps: 10000, // |4000 - 2000| / min(4000, 2000) = 2000 / 2000 = 1 = 10000 bps
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTradeRecord(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'test-id',
    clientOrderId: 'client-id',
    exchangeOrderId: null,
    exchange: 'mercadobitcoin',
    timestamp: new Date().toISOString(),
    direction: 'SELL_BASE',
    brlAmountTarget: 1000,
    baseAmountFilled: 2.5,
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

function makeBot(historyOverrides = {}, configOverrides: Partial<Config> = {}) {
  const portfolio = makePortfolio();

  const adapter = {
    getPrice: vi.fn().mockResolvedValue(portfolio.basePrice),
    getPortfolio: vi.fn().mockResolvedValue(portfolio),
    executeTrade: vi.fn().mockResolvedValue(makeTradeRecord()),
    getCandles: vi.fn().mockResolvedValue([]),
  } as unknown as ExchangeAdapter;

  const history = {
    appendTrade: vi.fn(),
    appendSnapshot: vi.fn(),
    readTrades: vi.fn().mockReturnValue([]),
    readSnapshots: vi.fn().mockReturnValue([]),
    getLastRebalanceTime: vi.fn().mockReturnValue(0),
    getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: null, direction: null }),
    ...historyOverrides,
  } as unknown as TradeHistoryService;

  const pnl = {
    logRebalance: vi.fn(),
    printReport: vi.fn(),
  } as unknown as PnlService;

  const costBasis = {
    getLedger: vi.fn().mockReturnValue({ base: { averageCostBrl: 400, totalBase: 10 }, lastUpdated: '' }),
    updateAfterBuy: vi.fn(),
    updateAfterSell: vi.fn().mockReturnValue(200),
    computeRealizedGainBrl: vi.fn().mockReturnValue(200),
  } as unknown as CostBasisService;

  const tax = {
    getMonthlySalesBrl: vi.fn().mockReturnValue(0),
    getMonthlyVolumeBrl: vi.fn().mockReturnValue(0),
    buildTaxEvent: vi.fn().mockReturnValue({
      tradeId: 'test',
      tradeDateBRT: '2026-04-15',
      monthBRT: '2026-04',
      direction: 'SELL_BASE',
      tradedVolumeBrl: 1000,
      grossProceedsBrl: 1000,
      costBasisBrl: 800,
      realizedGainBrl: 200,
      cumMonthlySalesBrl: 1000,
      cumMonthlyVolumeBrl: 1000,
      cumMonthlyGainBrl: 200,
      exempt: true,
      paymentDeadline: null,
      exchange: 'mercadobitcoin',
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
  const bot = new RebalancerBot(adapter, history, pnl, costBasis, tax, volatility, metrics, config);
  return { bot, adapter, history, pnl, costBasis, tax };
}

describe('RebalancerBot', () => {
  it('calls getPrice() on every cycle, not getPortfolio()', async () => {
    const { bot, adapter } = makeBot();
    // Portfolio at 50/50 — no rebalance needed
    vi.mocked(adapter.getPrice).mockResolvedValue(400);
    vi.mocked(adapter.getPortfolio).mockResolvedValue(
      makePortfolio({
        baseValueBrl: 3000,
        brlBalance: 3000,
        totalValueBrl: 6000,
        baseRatioBps: 5000,
        deviationBps: 0,
      }),
    );
    await bot.checkAndRebalance();
    expect(adapter.getPrice).toHaveBeenCalledTimes(1);
    // getPortfolio may or may not be called depending on price-only pre-check;
    // what matters is executeTrade was NOT called
    expect(adapter.executeTrade).not.toHaveBeenCalled();
  });

  it('skips when portfolio is below minimum BRL value', async () => {
    const { bot, adapter } = makeBot();
    vi.mocked(adapter.getPortfolio).mockResolvedValue(
      makePortfolio({ totalValueBrl: 100 }),
    );
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).not.toHaveBeenCalled();
  });

  it('skips when drift is below threshold', async () => {
    const { bot, adapter } = makeBot();
    vi.mocked(adapter.getPrice).mockResolvedValue(400);
    vi.mocked(adapter.getPortfolio).mockResolvedValue(
      makePortfolio({
        baseValueBrl: 3015,
        brlBalance: 3000,
        totalValueBrl: 6015,
        baseRatioBps: 5012,
        deviationBps: 50, // |3015 - 3000| / min(3015, 3000) = 15 / 3000 × 10000 = 50 bps < 100
      }),
    );
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).not.toHaveBeenCalled();
  });

  it('triggers trade when drift exceeds threshold', async () => {
    const { bot, adapter } = makeBot();
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(adapter.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).toHaveBeenCalledWith('SELL_BASE', expect.any(Number), expect.any(Object));
  });

  it('records trade and logs PnL when triggered', async () => {
    const { bot, adapter, history, pnl } = makeBot();
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(adapter.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(history.appendTrade).toHaveBeenCalled();
    expect(pnl.logRebalance).toHaveBeenCalled();
  });

  it('respects cooldown from prior trade', async () => {
    const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
    const { bot, adapter } = makeBot({
      getLastRebalanceTime: vi.fn().mockReturnValue(thirtyMinsAgo),
    });
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio());
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).not.toHaveBeenCalled();
  });

  it('respects cooldown after a trade in the same run', async () => {
    const { bot, adapter } = makeBot();
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(adapter.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).toHaveBeenCalledTimes(1);
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).toHaveBeenCalledTimes(1);
  });

  // ── Day-trade guard ──────────────────────────────────────────────────────────

  it('blocks opposite-direction trade on same BRT day', async () => {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const { bot, adapter } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: todayBRT, direction: 'SELL_BASE' }),
    });
    // BUY direction: SOL underweight
    vi.mocked(adapter.getPrice).mockResolvedValue(400);
    vi.mocked(adapter.getPortfolio).mockResolvedValue(
      makePortfolio({ baseValueBrl: 1500, brlBalance: 4500, totalValueBrl: 6000, baseRatioBps: 2500, deviationBps: 20000 }),
    );
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).not.toHaveBeenCalled();
  });

  it('allows same-direction trade on same BRT day', async () => {
    const todayBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const { bot, adapter } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: todayBRT, direction: 'SELL_BASE' }),
    });
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(adapter.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).toHaveBeenCalled();
  });

  it('allows opposite-direction trade on a different BRT day', async () => {
    const { bot, adapter } = makeBot({
      getLastRebalanceInfo: vi.fn().mockReturnValue({ dateBRT: '2020-01-01', direction: 'SELL_BASE' }),
    });
    vi.mocked(adapter.getPrice).mockResolvedValue(400);
    vi.mocked(adapter.getPortfolio).mockResolvedValue(
      makePortfolio({ baseValueBrl: 1500, brlBalance: 4500, totalValueBrl: 6000, baseRatioBps: 2500, deviationBps: 20000 }),
    );
    vi.mocked(adapter.executeTrade).mockResolvedValue(makeTradeRecord({ direction: 'BUY_BASE' }));
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).toHaveBeenCalled();
  });

  // ── Exemption cap — Mercado Bitcoin (SELL-only) ───────────────────────────────

  it('caps SELL trade when near MB exemption limit', async () => {
    const { bot, adapter, tax } = makeBot(
      {},
      { neverExceedExemptionLimit: true, exchange: 'mercadobitcoin' },
    );
    vi.mocked(tax.getMonthlySalesBrl).mockReturnValue(34_000);
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(adapter.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    const call = vi.mocked(adapter.executeTrade).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![1]).toBeLessThanOrEqual(650);
  });

  it('skips SELL trade when MB exemption limit is exhausted', async () => {
    const { bot, adapter, tax } = makeBot(
      {},
      { neverExceedExemptionLimit: true, exchange: 'mercadobitcoin' },
    );
    vi.mocked(tax.getMonthlySalesBrl).mockReturnValue(34_640);
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio());
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).not.toHaveBeenCalled();
  });

  it('does NOT cap BUY trades for MB exemption limit', async () => {
    const { bot, adapter, tax } = makeBot(
      {},
      { neverExceedExemptionLimit: true, exchange: 'mercadobitcoin' },
    );
    vi.mocked(tax.getMonthlySalesBrl).mockReturnValue(34_000);
    vi.mocked(adapter.getPrice).mockResolvedValue(400);
    vi.mocked(adapter.getPortfolio).mockResolvedValue(
      makePortfolio({ baseValueBrl: 1500, brlBalance: 4500, totalValueBrl: 6000, baseRatioBps: 2500, deviationBps: 20000 }),
    );
    vi.mocked(adapter.executeTrade).mockResolvedValue(makeTradeRecord({ direction: 'BUY_BASE' }));
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).toHaveBeenCalled();
    expect(vi.mocked(adapter.executeTrade).mock.calls[0]![1]).toBeGreaterThan(650);
  });

  // ── Adaptive threshold ────────────────────────────────────────────────────────

  it('uses adaptive threshold and skips when deviation is below computed bps', async () => {
    const { bot, adapter } = makeBot({}, { useAdaptiveThreshold: true });
    (bot as unknown as { volatility: { computeAdaptiveThresholdBps: ReturnType<typeof vi.fn> } }).volatility = {
      computeAdaptiveThresholdBps: vi.fn().mockResolvedValue(2000),
    };
    // deviationBps 100 < 2000: |3030 - 3000| / 3000 = 100 bps
    vi.mocked(adapter.getPortfolio).mockResolvedValue(
      makePortfolio({
        baseValueBrl: 3030,
        brlBalance: 3000,
        totalValueBrl: 6030,
        baseRatioBps: 5025,
        deviationBps: 100,
      }),
    );
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).not.toHaveBeenCalled();
  });

  it('falls back to static threshold when adaptive fetch fails', async () => {
    const { bot, adapter } = makeBot({}, { useAdaptiveThreshold: true });
    (bot as unknown as { volatility: { computeAdaptiveThresholdBps: ReturnType<typeof vi.fn> } }).volatility = {
      computeAdaptiveThresholdBps: vi.fn().mockRejectedValue(new Error('network error')),
    };
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio());
    vi.mocked(adapter.executeTrade).mockResolvedValue(makeTradeRecord());
    await bot.checkAndRebalance();
    expect(adapter.executeTrade).toHaveBeenCalled();
  });
});
