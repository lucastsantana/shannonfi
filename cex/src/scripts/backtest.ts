/**
 * Shannon's Demon backtest using real Coinbase historical candles.
 *
 * Usage:
 *   npm run backtest                          (defaults: 2025-05-01 to 2026-05-01, $10k)
 *   npm run backtest -- 2024-01-01 2025-01-01
 *   npm run backtest -- 2024-01-01 2025-01-01 25000
 *
 * Coinbase candle limit: 300 candles per request (~10 months ONE_DAY).
 * For longer periods the script pages through multiple windows.
 *
 * Strategy logic mirrors backtest/*.py and rebalance.rs:
 *   - Check drift daily
 *   - Rebalance when drift > thresholdBps AND minDaysBetweenRebalances elapsed
 *   - Compare to buy-and-hold 50/50 and 100% SOL benchmarks
 */

import { loadConfig } from '../config';
import { CoinbaseClient } from '../coinbase/client';
import { CoinbaseEndpoints } from '../coinbase/endpoints';
import { Candle } from '../coinbase/types';
import {
  computeSolRatioBps,
  shouldRebalance,
  computeRebalanceTrade,
} from '../math';
import { BACKTEST_MAX_CANDLES_PER_REQUEST } from '../constants';

interface BacktestConfig {
  startDate: string;
  endDate: string;
  initialCapital: number;
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
  price: number;
  portfolioValueUsd: number;
  solRatioBpsBefore: number;
  direction: 'BUY_SOL' | 'SELL_SOL';
  usdAmount: number;
}

interface BacktestResult {
  config: BacktestConfig;
  totalCandles: number;
  strategies: {
    shannonDemon: StrategyResult;
    buyAndHold5050: StrategyResult;
    allSol: StrategyResult;
  };
  rebalances: RebalanceEvent[];
}

async function fetchAllCandles(
  endpoints: CoinbaseEndpoints,
  startTs: number,
  endTs: number,
): Promise<Candle[]> {
  const daySeconds = 86_400;
  const windowSize = BACKTEST_MAX_CANDLES_PER_REQUEST * daySeconds;
  const allCandles: Candle[] = [];
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

async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  const config = loadConfig();
  const client = new CoinbaseClient(
    { apiKeyName: config.coinbaseApiKeyName, privateKey: config.coinbasePrivateKey },
    config.coinbaseApiBaseUrl,
  );
  const endpoints = new CoinbaseEndpoints(client);

  const startTs = Math.floor(new Date(cfg.startDate).getTime() / 1000);
  const endTs = Math.floor(new Date(cfg.endDate).getTime() / 1000);

  console.log(`Fetching candles from ${cfg.startDate} to ${cfg.endDate}...`);
  const candles = await fetchAllCandles(endpoints, startTs, endTs);

  if (candles.length === 0) {
    throw new Error('No candles returned for the specified period');
  }

  console.log(`Fetched ${candles.length} daily candles. Running simulation...`);

  const initPrice = parseFloat(candles[0]!.close);
  const daySeconds = 86_400;

  // Shannon's Demon portfolio
  let shannonSol = cfg.initialCapital / 2 / initPrice;
  let shannonUsd = cfg.initialCapital / 2;

  // Buy and hold 50/50 (never rebalances)
  const bhSol = cfg.initialCapital / 2 / initPrice;
  const bhUsd = cfg.initialCapital / 2;

  // 100% SOL (never rebalances)
  const allSolAmount = cfg.initialCapital / initPrice;

  const shannonValues: number[] = [];
  const bhValues: number[] = [];
  const allSolValues: number[] = [];
  const rebalances: RebalanceEvent[] = [];

  let lastRebalanceTs = parseInt(candles[0]!.start);

  for (const candle of candles) {
    const price = parseFloat(candle.close);
    const ts = parseInt(candle.start);
    const daysSinceRebalance = (ts - lastRebalanceTs) / daySeconds;

    const solValueUsd = shannonSol * price;
    const shannonPortValue = solValueUsd + shannonUsd;
    const solRatioBps = computeSolRatioBps(solValueUsd, shannonPortValue);

    if (
      daysSinceRebalance >= cfg.minDaysBetweenRebalances &&
      shouldRebalance(solRatioBps, cfg.thresholdBps)
    ) {
      const { direction, usdAmount } = computeRebalanceTrade(solValueUsd, shannonUsd);

      rebalances.push({
        date: new Date(ts * 1000).toISOString().split('T')[0]!,
        price,
        portfolioValueUsd: shannonPortValue,
        solRatioBpsBefore: solRatioBps,
        direction,
        usdAmount,
      });

      if (direction === 'SELL_SOL') {
        const solToSell = usdAmount / price;
        shannonSol -= solToSell;
        shannonUsd += usdAmount;
      } else {
        const solToBuy = usdAmount / price;
        shannonSol += solToBuy;
        shannonUsd -= usdAmount;
      }

      lastRebalanceTs = ts;
    }

    shannonValues.push(shannonSol * price + shannonUsd);
    bhValues.push(bhSol * price + bhUsd);
    allSolValues.push(allSolAmount * price);
  }

  const finalShannon = shannonValues[shannonValues.length - 1]!;
  const finalBh = bhValues[bhValues.length - 1]!;
  const finalAllSol = allSolValues[allSolValues.length - 1]!;

  function stratResult(values: number[], final: number): StrategyResult {
    return {
      finalValue: final,
      returnPct: ((final - cfg.initialCapital) / cfg.initialCapital) * 100,
      gain: final - cfg.initialCapital,
      peakValue: Math.max(...values),
      troughValue: Math.min(...values),
    };
  }

  return {
    config: cfg,
    totalCandles: candles.length,
    strategies: {
      shannonDemon: stratResult(shannonValues, finalShannon),
      buyAndHold5050: stratResult(bhValues, finalBh),
      allSol: stratResult(allSolValues, finalAllSol),
    },
    rebalances,
  };
}

function printResults(result: BacktestResult): void {
  const { strategies: s, config: c, rebalances } = result;

  console.log(`\n${'='.repeat(60)}`);
  console.log("Shannon's Demon CEX Backtest Results");
  console.log(`Period:    ${c.startDate} → ${c.endDate}`);
  console.log(`Capital:   $${c.initialCapital.toLocaleString()}`);
  console.log(`Threshold: ${c.thresholdBps} bps (${c.thresholdBps / 100}%)`);
  console.log(`Min Days Between Rebalances: ${c.minDaysBetweenRebalances}`);
  console.log(`Candles:   ${result.totalCandles}`);
  console.log('='.repeat(60));

  const sign = (n: number) => (n >= 0 ? '+' : '');

  console.log('\nStrategy Comparison:');
  console.log(
    `  Shannon's Demon:   $${s.shannonDemon.finalValue.toFixed(2)}  (${sign(s.shannonDemon.returnPct)}${s.shannonDemon.returnPct.toFixed(2)}%)  Peak: $${s.shannonDemon.peakValue.toFixed(2)}  Trough: $${s.shannonDemon.troughValue.toFixed(2)}`,
  );
  console.log(
    `  Buy & Hold 50/50:  $${s.buyAndHold5050.finalValue.toFixed(2)}  (${sign(s.buyAndHold5050.returnPct)}${s.buyAndHold5050.returnPct.toFixed(2)}%)  Peak: $${s.buyAndHold5050.peakValue.toFixed(2)}  Trough: $${s.buyAndHold5050.troughValue.toFixed(2)}`,
  );
  console.log(
    `  100% SOL:          $${s.allSol.finalValue.toFixed(2)}  (${sign(s.allSol.returnPct)}${s.allSol.returnPct.toFixed(2)}%)  Peak: $${s.allSol.peakValue.toFixed(2)}  Trough: $${s.allSol.troughValue.toFixed(2)}`,
  );

  console.log(`\nRebalances (${rebalances.length} total):`);
  for (const r of rebalances) {
    const pct = (r.solRatioBpsBefore / 100).toFixed(1);
    console.log(
      `  ${r.date}  $${r.price.toFixed(2)}/SOL  SOL ratio: ${pct}%  ${r.direction}  $${r.usdAmount.toFixed(2)}`,
    );
  }

  const alpha =
    s.shannonDemon.returnPct - s.buyAndHold5050.returnPct;
  console.log(`\nAlpha vs Buy & Hold 50/50: ${sign(alpha)}${alpha.toFixed(2)}%`);
  console.log('='.repeat(60));
}

// CLI entry
const [, , startDate = '2025-05-01', endDate = '2026-05-01', capitalStr = '10000'] =
  process.argv;

const cfg: BacktestConfig = {
  startDate,
  endDate,
  initialCapital: parseFloat(capitalStr),
  thresholdBps: 100,         // 1% — matches DEFAULT_REBALANCE_THRESHOLD_BPS
  minDaysBetweenRebalances: 1, // daily check; on-chain is ~2 days via slot interval
};

runBacktest(cfg)
  .then((result) => {
    printResults(result);
    console.log('\nFull JSON output:');
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error('Backtest failed:', (err as Error).message);
    process.exit(1);
  });
