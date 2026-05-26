/**
 * Shannon's Demon backtest using real Coinbase historical candles.
 *
 * Usage:
 *   npm run backtest                              (defaults: 2025-05-01 to 2026-05-01, R$50k)
 *   npm run backtest -- 2024-01-01 2025-01-01
 *   npm run backtest -- 2024-01-01 2025-01-01 100000
 *
 * All values are in BRL. The script fetches SOL-USD candles and converts to BRL
 * via the USD/BRL rate at runtime (representative for the full period).
 * Coinbase candle limit: 300 candles per request (~10 months ONE_DAY).
 * For longer periods the script pages automatically through multiple windows.
 *
 * Requires exchange: coinbase in shannonfi.config.yaml.
 */

import { loadConfig } from '../config';
import { CoinbaseClient } from '../adapters/coinbase/client';
import { CoinbaseEndpoints } from '../adapters/coinbase/endpoints';
import { fetchUsdBrlRate } from '../adapters/coinbase/fx';
import { computeSolRatioBps, shouldRebalance, computeRebalanceTrade } from '../math';
import { COINBASE_BACKTEST_MAX_CANDLES } from '../constants';

interface BacktestCfg {
  startDate: string;
  endDate: string;
  initialCapitalBrl: number;
  thresholdBps: number;
  minDaysBetweenRebalances: number;
}

interface StrategyResult {
  finalValue: number;
  returnPct: number;
  gain: number;
  peakValue: number;
  troughValue: number;
}

interface RebalanceEvent {
  date: string;
  priceBrl: number;
  portfolioValueBrl: number;
  solRatioBpsBefore: number;
  direction: 'BUY_SOL' | 'SELL_SOL';
  brlAmount: number;
}

interface BacktestResult {
  config: BacktestCfg;
  usdBrlRate: number;
  totalCandles: number;
  strategies: {
    shannonDemon: StrategyResult;
    buyAndHold5050: StrategyResult;
    allSol: StrategyResult;
  };
  rebalances: RebalanceEvent[];
}

interface RawCandle {
  start: string;
  close: string;
}

async function fetchAllCandles(
  endpoints: CoinbaseEndpoints,
  startTs: number,
  endTs: number,
): Promise<RawCandle[]> {
  const windowSize = COINBASE_BACKTEST_MAX_CANDLES * 86_400;
  const allCandles: RawCandle[] = [];
  let cursor = startTs;

  while (cursor < endTs) {
    const windowEnd = Math.min(cursor + windowSize, endTs);
    const resp = await endpoints.getCandles(cursor, windowEnd, 'ONE_DAY');
    allCandles.push(...resp.candles);
    cursor = windowEnd;
  }

  allCandles.sort((a, b) => parseInt(a.start) - parseInt(b.start));
  return allCandles;
}

async function runBacktest(cfg: BacktestCfg): Promise<BacktestResult> {
  const config = loadConfig();
  if (config.exchange !== 'coinbase' || !config.coinbase) {
    throw new Error('Backtest requires exchange: coinbase in shannonfi.config.yaml');
  }

  const client = new CoinbaseClient(
    { apiKeyName: config.coinbase.apiKeyName, privateKey: config.coinbase.privateKey ?? '' },
    config.coinbase.apiBaseUrl,
  );
  const endpoints = new CoinbaseEndpoints(client);

  const usdBrlRate = await fetchUsdBrlRate(config.coinbase.fxApiUrl);
  if (!usdBrlRate) throw new Error('Cannot fetch USD/BRL rate');
  console.log(`USD/BRL rate: ${usdBrlRate.toFixed(4)} (applied to all candles)`);

  const startTs = Math.floor(new Date(cfg.startDate).getTime() / 1000);
  const endTs = Math.floor(new Date(cfg.endDate).getTime() / 1000);

  console.log(`Fetching candles from ${cfg.startDate} to ${cfg.endDate}...`);
  const candles = await fetchAllCandles(endpoints, startTs, endTs);
  if (candles.length === 0) throw new Error('No candles returned for the specified period');
  console.log(`Fetched ${candles.length} daily candles. Running simulation...`);

  const initPriceBrl = parseFloat(candles[0]!.close) * usdBrlRate;

  let shannonSol = cfg.initialCapitalBrl / 2 / initPriceBrl;
  let shannonBrl = cfg.initialCapitalBrl / 2;

  const bhSol = cfg.initialCapitalBrl / 2 / initPriceBrl;
  const bhBrl = cfg.initialCapitalBrl / 2;

  const allSolAmount = cfg.initialCapitalBrl / initPriceBrl;

  const shannonValues: number[] = [];
  const bhValues: number[] = [];
  const allSolValues: number[] = [];
  const rebalances: RebalanceEvent[] = [];

  let lastRebalanceTs = parseInt(candles[0]!.start);

  for (const candle of candles) {
    const priceBrl = parseFloat(candle.close) * usdBrlRate;
    const ts = parseInt(candle.start);
    const daysSinceRebalance = (ts - lastRebalanceTs) / 86_400;

    const solValueBrl = shannonSol * priceBrl;
    const portfolioValueBrl = solValueBrl + shannonBrl;
    const solRatioBps = computeSolRatioBps(solValueBrl, portfolioValueBrl);

    if (
      daysSinceRebalance >= cfg.minDaysBetweenRebalances &&
      shouldRebalance(solRatioBps, cfg.thresholdBps)
    ) {
      const { direction, brlAmount } = computeRebalanceTrade(solValueBrl, shannonBrl);

      rebalances.push({
        date: new Date(ts * 1000).toISOString().split('T')[0]!,
        priceBrl,
        portfolioValueBrl,
        solRatioBpsBefore: solRatioBps,
        direction,
        brlAmount,
      });

      if (direction === 'SELL_SOL') {
        shannonSol -= brlAmount / priceBrl;
        shannonBrl += brlAmount;
      } else {
        shannonSol += brlAmount / priceBrl;
        shannonBrl -= brlAmount;
      }

      lastRebalanceTs = ts;
    }

    shannonValues.push(shannonSol * priceBrl + shannonBrl);
    bhValues.push(bhSol * priceBrl + bhBrl);
    allSolValues.push(allSolAmount * priceBrl);
  }

  function stratResult(values: number[], final: number): StrategyResult {
    return {
      finalValue: final,
      returnPct: ((final - cfg.initialCapitalBrl) / cfg.initialCapitalBrl) * 100,
      gain: final - cfg.initialCapitalBrl,
      peakValue: Math.max(...values),
      troughValue: Math.min(...values),
    };
  }

  return {
    config: cfg,
    usdBrlRate,
    totalCandles: candles.length,
    strategies: {
      shannonDemon: stratResult(shannonValues, shannonValues[shannonValues.length - 1]!),
      buyAndHold5050: stratResult(bhValues, bhValues[bhValues.length - 1]!),
      allSol: stratResult(allSolValues, allSolValues[allSolValues.length - 1]!),
    },
    rebalances,
  };
}

function printResults(result: BacktestResult): void {
  const { strategies: s, config: c, rebalances } = result;
  const sign = (n: number) => (n >= 0 ? '+' : '');

  console.log(`\n${'='.repeat(60)}`);
  console.log("Shannon's Demon Backtest Results (BRL)");
  console.log(`Period:    ${c.startDate} → ${c.endDate}`);
  console.log(`Capital:   R$${c.initialCapitalBrl.toLocaleString()}`);
  console.log(`Threshold: ${c.thresholdBps} bps (${c.thresholdBps / 100}%)`);
  console.log(`Min Days:  ${c.minDaysBetweenRebalances}`);
  console.log(`Candles:   ${result.totalCandles}`);
  console.log('='.repeat(60));

  console.log('\nStrategy Comparison:');
  console.log(`  Shannon's Demon:   R$${s.shannonDemon.finalValue.toFixed(2)}  (${sign(s.shannonDemon.returnPct)}${s.shannonDemon.returnPct.toFixed(2)}%)  Peak: R$${s.shannonDemon.peakValue.toFixed(2)}  Trough: R$${s.shannonDemon.troughValue.toFixed(2)}`);
  console.log(`  Buy & Hold 50/50:  R$${s.buyAndHold5050.finalValue.toFixed(2)}  (${sign(s.buyAndHold5050.returnPct)}${s.buyAndHold5050.returnPct.toFixed(2)}%)  Peak: R$${s.buyAndHold5050.peakValue.toFixed(2)}  Trough: R$${s.buyAndHold5050.troughValue.toFixed(2)}`);
  console.log(`  100% SOL:          R$${s.allSol.finalValue.toFixed(2)}  (${sign(s.allSol.returnPct)}${s.allSol.returnPct.toFixed(2)}%)  Peak: R$${s.allSol.peakValue.toFixed(2)}  Trough: R$${s.allSol.troughValue.toFixed(2)}`);

  console.log(`\nRebalances (${rebalances.length} total):`);
  for (const r of rebalances) {
    const pct = (r.solRatioBpsBefore / 100).toFixed(1);
    console.log(`  ${r.date}  R$${r.priceBrl.toFixed(2)}/SOL  SOL ratio: ${pct}%  ${r.direction}  R$${r.brlAmount.toFixed(2)}`);
  }

  const alpha = s.shannonDemon.returnPct - s.buyAndHold5050.returnPct;
  console.log(`\nAlpha vs Buy & Hold 50/50: ${sign(alpha)}${alpha.toFixed(2)}%`);
  console.log('='.repeat(60));
}

const [, , startDate = '2025-05-01', endDate = '2026-05-01', capitalStr = '50000'] = process.argv;

const cfg: BacktestCfg = {
  startDate,
  endDate,
  initialCapitalBrl: parseFloat(capitalStr),
  thresholdBps: 100,
  minDaysBetweenRebalances: 1,
};

runBacktest(cfg)
  .then((result) => {
    printResults(result);
  })
  .catch((err) => {
    console.error('Backtest failed:', (err as Error).message);
    process.exit(1);
  });
