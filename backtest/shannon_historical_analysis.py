#!/usr/bin/env python3
"""
Shannon's Demon Historical Analysis 2020-2026
Comprehensive benchmark analysis with risk metrics
"""

import json
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Tuple
import math
import time

def fetch_yearly_prices(year: int, retry_delay: int = 3) -> List[Dict]:
    """Fetch historical SOL/USD prices for a given year from CoinGecko"""
    print(f"Fetching {year} SOL/USD prices...")

    try:
        # CoinGecko API endpoint
        url = "https://api.coingecko.com/api/v3/coins/solana/market_chart"

        # Calculate days from Jan 1 to Dec 31 of the year
        start_date = datetime(year, 1, 1)
        end_date = datetime(year, 12, 31)
        days = (end_date - start_date).days + 1

        # Special handling for 2020 (SOL launched in March 2020)
        if year == 2020:
            # SOL launched ~March 2020, fetch from that date
            start_date = datetime(2020, 3, 20)
            days = (end_date - start_date).days + 1

        params = {
            "vs_currency": "usd",
            "days": str(days),
            "interval": "daily"
        }

        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = requests.get(url, params=params, timeout=10)
                response.raise_for_status()
                data = response.json()
                prices = data.get("prices", [])
                break
            except requests.exceptions.HTTPError as e:
                if response.status_code == 429 and attempt < max_retries - 1:
                    wait_time = retry_delay * (attempt + 1)
                    print(f"  ⏳ Rate limited. Waiting {wait_time}s before retry...")
                    time.sleep(wait_time)
                    continue
                else:
                    raise

        if not prices:
            print(f"⚠️  No price data for {year}")
            return []

        # Convert to our format
        price_records = []
        for timestamp_ms, price in prices:
            date = datetime.fromtimestamp(timestamp_ms / 1000)
            # Only include prices from the target year
            if date.year == year:
                price_records.append({
                    "date": date.strftime("%Y-%m-%d"),
                    "close": round(price, 2)
                })

        if price_records:
            print(f"✓ Fetched {len(price_records)} days for {year} ({price_records[0]['date']} to {price_records[-1]['date']})")
            print(f"  Range: ${price_records[0]['close']} → ${price_records[-1]['close']}")

        return price_records

    except requests.exceptions.RequestException as e:
        print(f"✗ Error fetching {year}: {e}")
        return []

class ShannonDemonBacktest:
    def __init__(self, initial_capital: float = 10000.0):
        self.initial_capital = initial_capital
        self.rebalance_interval_days = 30

    def run_backtest(self, prices: List[Dict]) -> Dict:
        """Run Shannon's Demon with historical prices"""

        if not prices or len(prices) < 2:
            return None

        # Strategy tracking
        shannon_sol_amount = self.initial_capital / 2 / prices[0]["close"]
        shannon_usd = self.initial_capital / 2

        # Buy & Hold 50/50
        bh_sol_amount = self.initial_capital / 2 / prices[0]["close"]
        bh_usd = self.initial_capital / 2

        # 100% SOL
        all_sol_amount = self.initial_capital / prices[0]["close"]

        results = {
            "shannon_values": [],
            "bh_values": [],
            "all_sol_values": [],
            "daily_prices": [],
            "rebalances": 0
        }

        last_rebalance_date = datetime.strptime(prices[0]["date"], "%Y-%m-%d")

        for price_data in prices:
            date_str = price_data["date"]
            sol_price = price_data["close"]
            current_date = datetime.strptime(date_str, "%Y-%m-%d")
            days_since_rebalance = (current_date - last_rebalance_date).days

            # Shannon's Demon: Check rebalancing
            if days_since_rebalance >= self.rebalance_interval_days:
                shannon_portfolio_value = shannon_sol_amount * sol_price + shannon_usd
                shannon_sol_value = shannon_sol_amount * sol_price
                sol_ratio = shannon_sol_value / shannon_portfolio_value if shannon_portfolio_value > 0 else 0

                # Rebalance if drift > 5%
                if abs(sol_ratio - 0.5) > 0.05:
                    shannon_sol_value = shannon_portfolio_value * 0.5
                    shannon_usd = shannon_portfolio_value * 0.5
                    shannon_sol_amount = shannon_sol_value / sol_price
                    results["rebalances"] += 1
                    last_rebalance_date = current_date

            # Calculate values
            shannon_value = shannon_sol_amount * sol_price + shannon_usd
            bh_value = bh_sol_amount * sol_price + bh_usd
            all_sol_value = all_sol_amount * sol_price

            results["shannon_values"].append(shannon_value)
            results["bh_values"].append(bh_value)
            results["all_sol_values"].append(all_sol_value)
            results["daily_prices"].append(sol_price)

        return results

def calculate_metrics(values: List[float], initial_capital: float = 10000.0) -> Dict:
    """Calculate return, volatility, Sharpe, Sortino, and max drawdown"""

    if len(values) < 2:
        return None

    # Return
    total_return = (values[-1] - initial_capital) / initial_capital

    # Daily returns
    daily_returns = []
    for i in range(1, len(values)):
        ret = (values[i] - values[i-1]) / values[i-1]
        daily_returns.append(ret)

    # Volatility (annualized, 252 trading days)
    if daily_returns:
        variance = sum((r - sum(daily_returns)/len(daily_returns))**2 for r in daily_returns) / len(daily_returns)
        daily_volatility = math.sqrt(variance)
        annual_volatility = daily_volatility * math.sqrt(252)
    else:
        annual_volatility = 0

    # Sharpe ratio (assuming 0% risk-free rate)
    if annual_volatility > 0:
        sharpe_ratio = (total_return / len(values) * 252) / annual_volatility
    else:
        sharpe_ratio = 0

    # Sortino ratio (only downside volatility)
    downside_returns = [r for r in daily_returns if r < 0]
    if downside_returns:
        downside_variance = sum(r**2 for r in downside_returns) / len(downside_returns)
        downside_volatility = math.sqrt(downside_variance) * math.sqrt(252)
        if downside_volatility > 0:
            sortino_ratio = (total_return / len(values) * 252) / downside_volatility
        else:
            sortino_ratio = 0
    else:
        sortino_ratio = float('inf') if total_return > 0 else 0

    # Maximum drawdown
    peak = initial_capital
    max_drawdown = 0
    for value in values:
        if value > peak:
            peak = value
        drawdown = (value - peak) / peak
        if drawdown < max_drawdown:
            max_drawdown = drawdown

    return {
        "total_return": total_return * 100,
        "volatility": annual_volatility * 100,
        "sharpe_ratio": sharpe_ratio,
        "sortino_ratio": sortino_ratio,
        "max_drawdown": max_drawdown * 100,
        "final_value": values[-1]
    }

def main():
    print("="*80)
    print("SHANNON'S DEMON HISTORICAL ANALYSIS 2020-2026")
    print("="*80)

    benchmark_results = []

    # Years to analyze
    years = [2020, 2021, 2022, 2023, 2024, 2025, 2026]

    for i, year in enumerate(years):
        if i > 0:
            print(f"⏳ Waiting before next request...")
            time.sleep(5)  # 5 second delay between years
        print(f"\n📊 Analyzing {year}...")
        prices = fetch_yearly_prices(year)

        if not prices:
            print(f"⏭️  Skipping {year} (no data)")
            continue

        # Run backtest
        backtest = ShannonDemonBacktest(initial_capital=10000.0)
        results = backtest.run_backtest(prices)

        if not results:
            continue

        # Calculate metrics for all three strategies
        shannon_metrics = calculate_metrics(results["shannon_values"])
        bh_metrics = calculate_metrics(results["bh_values"])
        sol_metrics = calculate_metrics(results["all_sol_values"])

        benchmark_results.append({
            "year": year,
            "days": len(prices),
            "start_price": prices[0]["close"],
            "end_price": prices[-1]["close"],
            "shannon": shannon_metrics,
            "buy_hold_50_50": bh_metrics,
            "all_sol": sol_metrics,
            "rebalances": results["rebalances"]
        })

        # Print year summary
        print(f"\n  {year} Results (SOL: ${prices[0]['close']:.2f} → ${prices[-1]['close']:.2f}):")
        print(f"    Shannon's Demon:")
        print(f"      Return: {shannon_metrics['total_return']:+.2f}% | Volatility: {shannon_metrics['volatility']:.2f}% | Sharpe: {shannon_metrics['sharpe_ratio']:.3f} | Sortino: {shannon_metrics['sortino_ratio']:.3f} | Max DD: {shannon_metrics['max_drawdown']:.2f}%")
        print(f"    Buy & Hold 50/50:")
        print(f"      Return: {bh_metrics['total_return']:+.2f}% | Volatility: {bh_metrics['volatility']:.2f}% | Sharpe: {bh_metrics['sharpe_ratio']:.3f} | Sortino: {bh_metrics['sortino_ratio']:.3f} | Max DD: {bh_metrics['max_drawdown']:.2f}%")
        print(f"    All SOL:")
        print(f"      Return: {sol_metrics['total_return']:+.2f}% | Volatility: {sol_metrics['volatility']:.2f}% | Sharpe: {sol_metrics['sharpe_ratio']:.3f} | Sortino: {sol_metrics['sortino_ratio']:.3f} | Max DD: {sol_metrics['max_drawdown']:.2f}%")

    # Generate benchmark table
    print("\n" + "="*80)
    print("COMPREHENSIVE BENCHMARK TABLE 2020-2026")
    print("="*80)

    # Shannon's Demon table
    print("\n📊 SHANNON'S DEMON PERFORMANCE")
    print("-" * 110)
    print(f"{'Year':<6} {'Days':<6} {'Return':<10} {'Volatility':<12} {'Sharpe':<8} {'Sortino':<8} {'Max DD':<10} {'Rebalances':<12}")
    print("-" * 110)
    for result in benchmark_results:
        sm = result["shannon"]
        print(f"{result['year']:<6} {result['days']:<6} {sm['total_return']:+7.2f}%   {sm['volatility']:>8.2f}%    {sm['sharpe_ratio']:>6.3f}   {sm['sortino_ratio']:>6.3f}   {sm['max_drawdown']:>7.2f}%   {result['rebalances']:<12}")

    # Buy & Hold table
    print("\n📊 BUY & HOLD 50/50 PERFORMANCE")
    print("-" * 110)
    print(f"{'Year':<6} {'Days':<6} {'Return':<10} {'Volatility':<12} {'Sharpe':<8} {'Sortino':<8} {'Max DD':<10}")
    print("-" * 110)
    for result in benchmark_results:
        bm = result["buy_hold_50_50"]
        print(f"{result['year']:<6} {result['days']:<6} {bm['total_return']:+7.2f}%   {bm['volatility']:>8.2f}%    {bm['sharpe_ratio']:>6.3f}   {bm['sortino_ratio']:>6.3f}   {bm['max_drawdown']:>7.2f}%")

    # All SOL table
    print("\n📊 100% SOL PERFORMANCE")
    print("-" * 110)
    print(f"{'Year':<6} {'Days':<6} {'Return':<10} {'Volatility':<12} {'Sharpe':<8} {'Sortino':<8} {'Max DD':<10}")
    print("-" * 110)
    for result in benchmark_results:
        sm = result["all_sol"]
        print(f"{result['year']:<6} {result['days']:<6} {sm['total_return']:+7.2f}%   {sm['volatility']:>8.2f}%    {sm['sharpe_ratio']:>6.3f}   {sm['sortino_ratio']:>6.3f}   {sm['max_drawdown']:>7.2f}%")

    # Outperformance summary
    print("\n" + "="*80)
    print("SHANNON'S DEMON OUTPERFORMANCE vs BENCHMARKS")
    print("="*80)
    print(f"{'Year':<6} {'vs B&H 50/50':<15} {'vs All SOL':<15} {'Risk Adjusted':<20}")
    print("-" * 60)
    for result in benchmark_results:
        shannon_return = result["shannon"]["total_return"]
        bh_return = result["buy_hold_50_50"]["total_return"]
        sol_return = result["all_sol"]["total_return"]

        outperf_bh = shannon_return - bh_return
        outperf_sol = shannon_return - sol_return

        shannon_sharpe = result["shannon"]["sharpe_ratio"]
        bh_sharpe = result["buy_hold_50_50"]["sharpe_ratio"]

        print(f"{result['year']:<6} {outperf_bh:+6.2f}%         {outperf_sol:+6.2f}%        Sharpe: {shannon_sharpe:.3f} (B&H: {bh_sharpe:.3f})")

    # Save results to JSON
    output_file = "backtest/historical_results.json"
    with open(output_file, 'w') as f:
        json.dump(benchmark_results, f, indent=2)
    print(f"\n✓ Detailed results saved to {output_file}")

if __name__ == "__main__":
    main()
