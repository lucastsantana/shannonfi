# Shannon's Demon Backtest Suite

This directory contains historical backtests and analysis of the Shannon's Demon volatility-harvesting strategy on SOL/BRL.

## Overview

**Shannon's Demon** is a market-neutral 50/50 rebalancing strategy: hold SOL and BRL in equal proportion by value, rebalance whenever the allocation drifts, and profit from volatility via systematic mean reversion. This suite runs the strategy against historical price data to measure past performance and validate the approach.

## Files

### Python Scripts

- **`shannon_backtest.py`** — Core backtest engine: accepts price history and config, outputs trade history and performance metrics
- **`shannon_backtest_real.py`** — Backtests using real Mercado Bitcoin candle data (public endpoint, 5+ minute bars)
- **`shannon_backtest_coingecko.py`** — Backtests using CoinGecko historical price API as a secondary data source
- **`shannon_full_history.py`** — Fetches and stores long-term price history for offline backtesting
- **`shannon_historical_analysis.py`** — Generates summary statistics and comparative analysis across test runs

### Output Data

- **`RESULTS.md`** — Performance summary and lessons from 2025-2026 backtest
- **`RESULTS_REAL_PRICES.md`** — Real Mercado Bitcoin price backtest with deployment implications
- **`COINGECKO_ANALYSIS.md`** — CoinGecko-sourced backtest with alternative data validation
- **`HISTORICAL_BENCHMARK_REPORT.md`** — Comprehensive analysis of strategy performance across market regimes (bull/bear)
- **`coingecko_results.json`** — Raw performance data from CoinGecko backtest
- **`historical_results.json`** — Raw trade and performance log from real-price backtest

## Running the Backtest

### Prerequisites

```bash
pip install requests pandas numpy
```

### Basic Run

```bash
cd backtest
python shannon_backtest_real.py
```

This fetches real SOL/BRL candle data from Mercado Bitcoin, runs the strategy with default config (50/50 target, 1% rebalance threshold, 30-day minimum interval), and outputs a trade log and performance report.

### Custom Configuration

Edit the script directly or pass parameters:

```python
# In shannon_backtest.py
config = {
    'target_ratio': 0.5,           # 50/50
    'rebalance_threshold_pct': 0.01,  # 1% drift
    'min_rebalance_days': 30,      # 30-day cooldown
    'taker_fee_pct': 0.003,        # 0.3% Mercado Bitcoin fee
}
```

### Long-Term History

```bash
python shannon_full_history.py
```

This fetches and caches price history to `historical_results.json` for offline analysis.

## Key Results

From the 2026 backtest (Jan-May, bear market):

- **Returns:** +1.2% (buy-hold SOL: -22%)
- **Rebalances:** 5 trades total
- **Cost:** ~0.3% per trade (Mercado Bitcoin taker fee)
- **Sharpe Ratio:** Positive; strong downside protection

See `HISTORICAL_BENCHMARK_REPORT.md` for full analysis.

## Integration with the Bot

The live bot (`bot/src/index.ts`) uses the same 50/50 rebalancing logic as these scripts, but:
- Executes in real-time on Mercado Bitcoin API
- Tracks cost basis and Brazilian tax compliance (Lei 9.250/1995)
- Persists trade history and tax events locally
- Adapts rebalance threshold based on 30-day volatility (MAD)

The backtest can validate new strategy parameters before deploying them to the live bot.
