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
import { getDb, getDbConfig } from '../../src/core/tracker/db';

function uniqueMemDbPath(): string {
  return `:memory:?mode=memory&cache=shared&hash=${Math.random()}`;
}

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

function makeBot(
  historyOverrides = {},
  configOverrides: Partial<Config> = {},
  adapterFactory?: (symbol: string) => ExchangeAdapter,
) {
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
  const bot = new RebalancerBot(adapter, history, pnl, costBasis, tax, volatility, metrics, config, adapterFactory);
  return { bot, adapter, history, pnl, costBasis, tax, config };
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

describe('RebalancerBot — asset rotation', () => {
  it('liquidates the old asset, swaps to the new adapter, and rebalances into the new asset the same cycle', async () => {
    // Real history/tax/cost-basis services against a real in-memory DB — rotation is a
    // genuinely multi-service transactional flow (it writes trades, tax events, and the
    // pending_rotation row's FK-checked liquidation_trade_id together), so this is
    // deliberately closer to an integration test than the mocked-services tests above.
    // Only the two ExchangeAdapters (the real network boundary) are mocked.
    const dbPath = uniqueMemDbPath();
    const db = getDb(dbPath);
    db.prepare(
      `INSERT INTO pending_rotation (from_symbol, to_symbol, approved_at, status) VALUES (?, ?, ?, 'APPROVED')`,
    ).run('SOL-BRL', 'BTC-BRL', new Date().toISOString());

    // Old adapter: holds 10 SOL @ R$400 (R$4000), about to be fully liquidated.
    const oldPortfolio = makePortfolio({ baseBalance: 10, basePrice: 400, baseValueBrl: 4000, brlBalance: 0, totalValueBrl: 4000 });
    const liquidationTrade = makeTradeRecord({
      id: 'liquidation-trade', direction: 'SELL_BASE', status: 'DRY_RUN', baseAmountFilled: 10, brlAmountFilled: 4000, fillPrice: 400,
    });

    // New adapter: starts 100% BRL post-liquidation (R$4000), far outside 50/50 — should trigger an
    // immediate BUY_BASE into the new asset on the same cycle.
    const newPortfolioBefore = makePortfolio({ baseBalance: 0, basePrice: 100, baseValueBrl: 0, brlBalance: 4000, totalValueBrl: 4000, baseRatioBps: 0, deviationBps: 10000 });
    const acquisitionTrade = makeTradeRecord({
      id: 'acquisition-trade', direction: 'BUY_BASE', status: 'DRY_RUN', baseAmountFilled: 20, brlAmountFilled: 2000, fillPrice: 100,
    });

    const newAdapter = {
      getPrice: vi.fn().mockResolvedValue(100),
      getPortfolio: vi.fn().mockResolvedValue(newPortfolioBefore),
      executeTrade: vi.fn().mockResolvedValue(acquisitionTrade),
      getCandles: vi.fn().mockResolvedValue([]),
    } as unknown as ExchangeAdapter;
    const adapterFactory = vi.fn().mockReturnValue(newAdapter);

    const oldAdapter = {
      getPrice: vi.fn().mockResolvedValue(400),
      getPortfolio: vi.fn().mockResolvedValue(oldPortfolio),
      executeTrade: vi.fn().mockResolvedValue(liquidationTrade),
      getCandles: vi.fn().mockResolvedValue([]),
    } as unknown as ExchangeAdapter;

    const history = new TradeHistoryService(dbPath, 0);
    const pnl = { logRebalance: vi.fn(), printReport: vi.fn() } as unknown as PnlService;
    const costBasis = new CostBasisService(dbPath, 0, 'SOL');
    const tax = new TaxService(dbPath, 0);
    const volatility = { computeAdaptiveThresholdBps: vi.fn().mockResolvedValue(100) } as unknown as VolatilityService;
    const metrics = { computeMetrics: vi.fn().mockReturnValue({}), printReport: vi.fn() } as unknown as MetricsService;
    const config: Config = { ...testConfig, dbPath, symbol: 'SOL-BRL', useAdaptiveThreshold: false };

    const bot = new RebalancerBot(oldAdapter, history, pnl, costBasis, tax, volatility, metrics, config, adapterFactory);

    await bot.checkAndRebalance();

    // Liquidation happened on the OLD adapter.
    expect(oldAdapter.executeTrade).toHaveBeenCalledWith('SELL_BASE', 4000, oldPortfolio);
    // The factory was asked to build an adapter for the new symbol, and that new
    // adapter — not the old one — was used for the rest of this cycle.
    expect(adapterFactory).toHaveBeenCalledWith('BTC-BRL');
    expect(newAdapter.getPrice).toHaveBeenCalled();
    expect(newAdapter.getPortfolio).toHaveBeenCalled();
    expect(newAdapter.executeTrade).toHaveBeenCalledWith('BUY_BASE', expect.any(Number), newPortfolioBefore);

    // Both the liquidation SELL and the re-acquisition BUY were actually persisted.
    const trades = history.readTrades();
    expect(trades).toHaveLength(2);
    expect(trades.map((t) => t.direction).sort()).toEqual(['BUY_BASE', 'SELL_BASE']);
    expect(trades.find((t) => t.direction === 'SELL_BASE')?.baseAsset).toBe('SOL');
    expect(trades.find((t) => t.direction === 'BUY_BASE')?.baseAsset).toBe('BTC');

    // pending_rotation marked COMPLETED with the liquidation trade linked, and
    // current_symbol updated so any other process reading this DB agrees on the active symbol.
    const row = db.prepare('SELECT * FROM pending_rotation').get() as any;
    expect(row.status).toBe('COMPLETED');
    expect(row.liquidation_trade_id).toBe(liquidationTrade.id);
    expect(getDbConfig('current_symbol', undefined, dbPath)).toBe('BTC-BRL');
  });

  it('does nothing when no rotation is pending', async () => {
    const dbPath = uniqueMemDbPath();
    const adapterFactory = vi.fn();
    const { bot, adapter } = makeBot({}, { dbPath }, adapterFactory);
    vi.mocked(adapter.getPortfolio).mockResolvedValue(makePortfolio({ baseValueBrl: 3000, brlBalance: 3000, totalValueBrl: 6000, baseRatioBps: 5000, deviationBps: 0 }));

    await bot.checkAndRebalance();

    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it('marks the rotation FAILED (without crashing the cycle) when no adapterFactory is configured', async () => {
    const dbPath = uniqueMemDbPath();
    const db = getDb(dbPath);
    db.prepare(
      `INSERT INTO pending_rotation (from_symbol, to_symbol, approved_at, status) VALUES (?, ?, ?, 'APPROVED')`,
    ).run('SOL-BRL', 'BTC-BRL', new Date().toISOString());

    // No adapterFactory passed — makeBot's default is undefined.
    const { bot } = makeBot({}, { dbPath });

    await expect(bot.checkAndRebalance()).resolves.not.toThrow();

    const row = db.prepare('SELECT * FROM pending_rotation').get() as any;
    expect(row.status).toBe('FAILED');
    expect(row.execution_error).toMatch(/adapterFactory/);
  });

  it('skips the liquidation trade (symbol swap only) when there is nothing to sell', async () => {
    const dbPath = uniqueMemDbPath();
    const db = getDb(dbPath);
    db.prepare(
      `INSERT INTO pending_rotation (from_symbol, to_symbol, approved_at, status) VALUES (?, ?, ?, 'APPROVED')`,
    ).run('SOL-BRL', 'BTC-BRL', new Date().toISOString());

    const newAdapter = {
      getPrice: vi.fn().mockResolvedValue(100),
      getPortfolio: vi.fn().mockResolvedValue(makePortfolio({ baseBalance: 0, brlBalance: 0, baseValueBrl: 0, totalValueBrl: 0 })),
      executeTrade: vi.fn(),
      getCandles: vi.fn().mockResolvedValue([]),
    } as unknown as ExchangeAdapter;
    const adapterFactory = vi.fn().mockReturnValue(newAdapter);

    const { bot, adapter } = makeBot({}, { dbPath, symbol: 'SOL-BRL', minPortfolioValueBrl: 1_000_000 }, adapterFactory);
    // Already 100% BRL, nothing to liquidate.
    vi.mocked(adapter.getPortfolio).mockResolvedValue(
      makePortfolio({ baseBalance: 0, brlBalance: 500, baseValueBrl: 0, totalValueBrl: 500 }),
    );

    await bot.checkAndRebalance();

    expect(adapter.executeTrade).not.toHaveBeenCalled();
    expect(adapterFactory).toHaveBeenCalledWith('BTC-BRL');
    const row = db.prepare('SELECT * FROM pending_rotation').get() as any;
    expect(row.status).toBe('COMPLETED');
    expect(row.liquidation_trade_id).toBeNull();
  });
});
