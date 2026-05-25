#!/usr/bin/env python3
"""
Shannon's Demon Full Historical Analysis
Using maximum available CoinGecko historical data
"""

import json
import requests
from datetime import datetime
from typing import List, Dict
import math
import time

def fetch_full_history() -> List[Dict]:
    """Fetch ALL available historical SOL/USD prices from CoinGecko"""
    print("Fetching complete SOL/USD historical data from CoinGecko...")

    try:
        url = "https://api.coingecko.com/api/v3/coins/solana/market_chart"
        params = {
            "vs_currency": "usd",
            "days": "max",
            "interval": "daily"
        }

        max_retries = 5
        for attempt in range(max_retries):
            try:
                response = requests.get(url, params=params, timeout=30)
                response.raise_for_status()
                data = response.json()
                prices = data.get("prices", [])
                break
            except requests.exceptions.HTTPError as e:
                if response.status_code == 429 and attempt < max_retries - 1:
                    wait_time = 10 * (attempt + 1)
                    print(f"  ⏳ Rate limited. Waiting {wait_time}s before retry...")
                    time.sleep(wait_time)
                    continue
                else:
                    raise

        if not prices:
            raise ValueError("No price data returned from CoinGecko")

        # Convert to our format
        price_records = []
        for timestamp_ms, price in prices:
            date = datetime.fromtimestamp(timestamp_ms / 1000)
            price_records.append({
                "date": date.strftime("%Y-%m-%d"),
                "datetime": date,
                "close": round(price, 2)
            })

        print(f"✓ Successfully fetched {len(price_records)} days of SOL price data")
        print(f"  Period: {price_records[0]['date']} to {price_records[-1]['date']}")
        print(f"  Start Price: ${price_records[0]['close']}")
        print(f"  End Price: ${price_records[-1]['close']}")

        return price_records

    except requests.exceptions.RequestException as e:
        print(f"✗ Error fetching from CoinGecko: {e}")
        return []

class ShannonDemonBacktest:
    def __init__(self, initial_capital: float = 10000.0):
        self.initial_capital = initial_capital
        self.rebalance_interval_days = 30

    def run_backtest_for_year(self, prices: List[Dict], year: int) -> Dict:
        """Run Shannon's Demon for a specific year"""

        # Filter prices for the year
        year_prices = [p for p in prices if p['datetime'].year == year]

        if len(year_prices) < 2:
            return None

        # Strategy tracking
        shannon_sol_amount = self.initial_capital / 2 / year_prices[0]["close"]
        shannon_usd = self.initial_capital / 2

        # Buy & Hold 50/50
        bh_sol_amount = self.initial_capital / 2 / year_prices[0]["close"]
        bh_usd = self.initial_capital / 2

        # 100% SOL
        all_sol_amount = self.initial_capital / year_prices[0]["close"]

        results = {
            "shannon_values": [],
            "bh_values": [],
            "all_sol_values": [],
            "daily_prices": [],
            "rebalances": 0
        }

        last_rebalance_date = year_prices[0]['datetime']

        for price_data in year_prices:
            sol_price = price_data["close"]
            current_date = price_data['datetime']
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
        mean_ret = sum(daily_returns) / len(daily_returns)
        variance = sum((r - mean_ret)**2 for r in daily_returns) / len(daily_returns)
        daily_volatility = math.sqrt(variance)
        annual_volatility = daily_volatility * math.sqrt(252)
    else:
        annual_volatility = 0

    # Sharpe ratio (assuming 0% risk-free rate, adjusted for year length)
    annual_return = total_return * (252 / len(values))
    if annual_volatility > 0:
        sharpe_ratio = annual_return / annual_volatility
    else:
        sharpe_ratio = 0

    # Sortino ratio (only downside volatility)
    downside_returns = [r for r in daily_returns if r < 0]
    if downside_returns:
        downside_variance = sum(r**2 for r in downside_returns) / len(downside_returns)
        downside_volatility = math.sqrt(downside_variance) * math.sqrt(252)
        if downside_volatility > 0:
            sortino_ratio = annual_return / downside_volatility
        else:
            sortino_ratio = float('inf') if annual_return > 0 else 0
    else:
        sortino_ratio = float('inf') if annual_return > 0 else 0

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
    print("="*100)
    print("SHANNON'S DEMON COMPREHENSIVE HISTORICAL ANALYSIS")
    print("="*100)

    # Fetch complete history
    all_prices = fetch_full_history()

    if not all_prices:
        print("Failed to fetch price data")
        return

    # Extract years available
    years_available = sorted(set(p['datetime'].year for p in all_prices))
    print(f"\nAvailable years: {years_available}")

    benchmark_results = []

    for year in years_available:
        print(f"\n📊 Analyzing {year}...")

        backtest = ShannonDemonBacktest(initial_capital=10000.0)
        results = backtest.run_backtest_for_year(all_prices, year)

        if not results:
            print(f"⏭️  Skipping {year} (insufficient data)")
            continue

        # Get year start/end prices
        year_prices = [p for p in all_prices if p['datetime'].year == year]
        start_price = year_prices[0]["close"]
        end_price = year_prices[-1]["close"]

        # Calculate metrics
        shannon_metrics = calculate_metrics(results["shannon_values"])
        bh_metrics = calculate_metrics(results["bh_values"])
        sol_metrics = calculate_metrics(results["all_sol_values"])

        benchmark_results.append({
            "year": year,
            "days": len(year_prices),
            "start_date": year_prices[0]["date"],
            "end_date": year_prices[-1]["date"],
            "start_price": start_price,
            "end_price": end_price,
            "price_change_pct": round((end_price - start_price) / start_price * 100, 2),
            "shannon": shannon_metrics,
            "buy_hold_50_50": bh_metrics,
            "all_sol": sol_metrics,
            "rebalances": results["rebalances"]
        })

        # Print year summary
        price_direction = "📈" if end_price > start_price else "📉"
        print(f"  {price_direction} {year}: SOL ${start_price:.2f} → ${end_price:.2f} ({(end_price-start_price)/start_price*100:+.2f}%)")
        print(f"\n  Shannon's Demon:   {shannon_metrics['total_return']:+7.2f}% | Vol: {shannon_metrics['volatility']:6.2f}% | Sharpe: {shannon_metrics['sharpe_ratio']:7.3f} | Sortino: {shannon_metrics['sortino_ratio']:7.3f} | Max DD: {shannon_metrics['max_drawdown']:7.2f}% ({results['rebalances']} rebalances)")
        print(f"  Buy & Hold 50/50:  {bh_metrics['total_return']:+7.2f}% | Vol: {bh_metrics['volatility']:6.2f}% | Sharpe: {bh_metrics['sharpe_ratio']:7.3f} | Sortino: {bh_metrics['sortino_ratio']:7.3f} | Max DD: {bh_metrics['max_drawdown']:7.2f}%")
        print(f"  All SOL (100%):    {sol_metrics['total_return']:+7.2f}% | Vol: {sol_metrics['volatility']:6.2f}% | Sharpe: {sol_metrics['sharpe_ratio']:7.3f} | Sortino: {sol_metrics['sortino_ratio']:7.3f} | Max DD: {sol_metrics['max_drawdown']:7.2f}%")

    # Generate comprehensive benchmark table
    if not benchmark_results:
        print("No data to analyze")
        return

    print("\n" + "="*130)
    print("COMPREHENSIVE BENCHMARK TABLE - ALL YEARS")
    print("="*130)

    # Shannon's Demon table
    print("\n📊 SHANNON'S DEMON STRATEGY")
    print("-" * 130)
    print(f"{'Year':<6} {'Days':<6} {'SOL Trend':<12} {'Return':<10} {'Vol':<8} {'Sharpe':<8} {'Sortino':<8} {'Max DD':<10} {'Rebal':<6}")
    print("-" * 130)
    for result in benchmark_results:
        sol_trend = f"{result['price_change_pct']:+.2f}%"
        sm = result["shannon"]
        print(f"{result['year']:<6} {result['days']:<6} {sol_trend:<12} {sm['total_return']:+7.2f}%   {sm['volatility']:6.2f}%  {sm['sharpe_ratio']:7.3f}  {sm['sortino_ratio']:7.3f}  {sm['max_drawdown']:7.2f}%   {result['rebalances']:<6}")

    # Buy & Hold table
    print("\n📊 BUY & HOLD 50/50 BENCHMARK")
    print("-" * 130)
    print(f"{'Year':<6} {'Days':<6} {'SOL Trend':<12} {'Return':<10} {'Vol':<8} {'Sharpe':<8} {'Sortino':<8} {'Max DD':<10}")
    print("-" * 130)
    for result in benchmark_results:
        sol_trend = f"{result['price_change_pct']:+.2f}%"
        bm = result["buy_hold_50_50"]
        print(f"{result['year']:<6} {result['days']:<6} {sol_trend:<12} {bm['total_return']:+7.2f}%   {bm['volatility']:6.2f}%  {bm['sharpe_ratio']:7.3f}  {bm['sortino_ratio']:7.3f}  {bm['max_drawdown']:7.2f}%")

    # All SOL table
    print("\n📊 100% SOL (HIGH RISK BENCHMARK)")
    print("-" * 130)
    print(f"{'Year':<6} {'Days':<6} {'SOL Trend':<12} {'Return':<10} {'Vol':<8} {'Sharpe':<8} {'Sortino':<8} {'Max DD':<10}")
    print("-" * 130)
    for result in benchmark_results:
        sol_trend = f"{result['price_change_pct']:+.2f}%"
        am = result["all_sol"]
        print(f"{result['year']:<6} {result['days']:<6} {sol_trend:<12} {am['total_return']:+7.2f}%   {am['volatility']:6.2f}%  {am['sharpe_ratio']:7.3f}  {am['sortino_ratio']:7.3f}  {am['max_drawdown']:7.2f}%")

    # Outperformance analysis
    print("\n" + "="*130)
    print("SHANNON'S DEMON OUTPERFORMANCE ANALYSIS")
    print("="*130)
    print(f"{'Year':<6} {'vs B&H 50/50':<15} {'vs All SOL':<15} {'Risk-Adj Advantage':<25} {'Market Type':<15}")
    print("-" * 130)
    for result in benchmark_results:
        shannon_return = result["shannon"]["total_return"]
        bh_return = result["buy_hold_50_50"]["total_return"]
        sol_return = result["all_sol"]["total_return"]

        shannon_dd = abs(result["shannon"]["max_drawdown"])
        sol_dd = abs(result["all_sol"]["max_drawdown"])

        outperf_bh = shannon_return - bh_return
        outperf_sol = shannon_return - sol_return

        risk_adj = (shannon_return / shannon_dd) - (bh_return / abs(result["buy_hold_50_50"]["max_drawdown"]))

        if result['price_change_pct'] > 0:
            market_type = "BULL"
        else:
            market_type = "BEAR"

        print(f"{result['year']:<6} {outperf_bh:+6.2f}%        {outperf_sol:+6.2f}%       {risk_adj:+6.3f} (return/DD)   {market_type:<15}")

    # Summary statistics
    print("\n" + "="*130)
    print("SUMMARY STATISTICS")
    print("="*130)

    shannon_returns = [r["shannon"]["total_return"] for r in benchmark_results]
    bh_returns = [r["buy_hold_50_50"]["total_return"] for r in benchmark_results]
    sol_returns = [r["all_sol"]["total_return"] for r in benchmark_results]

    shannon_volatilities = [r["shannon"]["volatility"] for r in benchmark_results]
    bh_volatilities = [r["buy_hold_50_50"]["volatility"] for r in benchmark_results]
    sol_volatilities = [r["all_sol"]["volatility"] for r in benchmark_results]

    print("\nAVERAGE ANNUAL RETURNS:")
    print(f"  Shannon's Demon:  {sum(shannon_returns)/len(shannon_returns):+7.2f}%")
    print(f"  Buy & Hold 50/50: {sum(bh_returns)/len(bh_returns):+7.2f}%")
    print(f"  100% SOL:         {sum(sol_returns)/len(sol_returns):+7.2f}%")

    print("\nAVERAGE VOLATILITY:")
    print(f"  Shannon's Demon:  {sum(shannon_volatilities)/len(shannon_volatilities):6.2f}%")
    print(f"  Buy & Hold 50/50: {sum(bh_volatilities)/len(bh_volatilities):6.2f}%")
    print(f"  100% SOL:         {sum(sol_volatilities)/len(sol_volatilities):6.2f}%")

    print("\nRISK-ADJUSTED PERFORMANCE (Return/Volatility):")
    shannon_ratio = (sum(shannon_returns)/len(shannon_returns)) / (sum(shannon_volatilities)/len(shannon_volatilities))
    bh_ratio = (sum(bh_returns)/len(bh_returns)) / (sum(bh_volatilities)/len(bh_volatilities))
    sol_ratio = (sum(sol_returns)/len(sol_returns)) / (sum(sol_volatilities)/len(sol_volatilities))
    print(f"  Shannon's Demon:  {shannon_ratio:+.4f}")
    print(f"  Buy & Hold 50/50: {bh_ratio:+.4f}")
    print(f"  100% SOL:         {sol_ratio:+.4f}")

    # Save results
    output_file = "backtest/historical_benchmark.json"
    with open(output_file, 'w') as f:
        json.dump({
            "results": benchmark_results,
            "summary": {
                "avg_shannon_return": sum(shannon_returns)/len(shannon_returns),
                "avg_bh_return": sum(bh_returns)/len(bh_returns),
                "avg_sol_return": sum(sol_returns)/len(sol_returns),
                "avg_shannon_volatility": sum(shannon_volatilities)/len(shannon_volatilities),
                "avg_bh_volatility": sum(bh_volatilities)/len(bh_volatilities),
                "avg_sol_volatility": sum(sol_volatilities)/len(sol_volatilities)
            }
        }, f, indent=2)
    print(f"\n✓ Detailed results saved to {output_file}")

if __name__ == "__main__":
    main()
