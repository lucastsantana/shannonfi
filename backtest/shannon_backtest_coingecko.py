#!/usr/bin/env python3
"""
Shannon's Demon Backtest with REAL CoinGecko Historical Prices
Fetches actual SOL/USD data from January 1 - May 24, 2026
"""

import json
import requests
from datetime import datetime
from typing import List, Dict

def fetch_coingecko_prices(days: int = 144) -> List[Dict]:
    """
    Fetch historical SOL/USD prices from CoinGecko API

    CoinGecko free API endpoint for historical market data
    Returns daily OHLCV data
    """
    print(f"Fetching historical SOL/USD prices from CoinGecko (last {days} days)...")

    try:
        # CoinGecko API endpoint for market chart data
        # vs_currency=usd, days=144 for ~5 months
        url = "https://api.coingecko.com/api/v3/coins/solana/market_chart"
        params = {
            "vs_currency": "usd",
            "days": str(days),
            "interval": "daily"
        }

        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()

        data = response.json()
        prices = data.get("prices", [])

        if not prices:
            raise ValueError("No price data returned from CoinGecko")

        # Convert to our format
        price_records = []
        for timestamp_ms, price in prices:
            date = datetime.fromtimestamp(timestamp_ms / 1000).strftime("%Y-%m-%d")
            price_records.append({
                "date": date,
                "close": round(price, 2)
            })

        print(f"✓ Successfully fetched {len(price_records)} days of SOL price data")
        print(f"  Period: {price_records[0]['date']} to {price_records[-1]['date']}")
        print(f"  Start Price: ${price_records[0]['close']}")
        print(f"  End Price: ${price_records[-1]['close']}")

        return price_records

    except requests.exceptions.RequestException as e:
        print(f"✗ Error fetching from CoinGecko: {e}")
        print("  Make sure you have internet connection")
        return []

class ShannonDemonBacktest:
    def __init__(self, initial_capital: float = 10000.0):
        self.initial_capital = initial_capital
        self.rebalance_interval_days = 30
        self.last_rebalance_date = None

    def run_backtest(self, prices: List[Dict]) -> dict:
        """Run Shannon's Demon with real CoinGecko prices"""

        if not prices or len(prices) < 2:
            raise ValueError("Insufficient price data for backtest")

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
            "rebalances": [],
            "dates": [],
            "prices": []
        }

        self.last_rebalance_date = datetime.strptime(prices[0]["date"], "%Y-%m-%d")

        for price_data in prices:
            date_str = price_data["date"]
            sol_price = price_data["close"]
            current_date = datetime.strptime(date_str, "%Y-%m-%d")
            days_since_rebalance = (current_date - self.last_rebalance_date).days

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

                    results["rebalances"].append({
                        "date": date_str,
                        "price": sol_price,
                        "portfolio_value": shannon_portfolio_value,
                        "sol_ratio_before": f"{sol_ratio:.2%}"
                    })

                    self.last_rebalance_date = current_date

            # Calculate values
            shannon_value = shannon_sol_amount * sol_price + shannon_usd
            bh_value = bh_sol_amount * sol_price + bh_usd
            all_sol_value = all_sol_amount * sol_price

            results["shannon_values"].append(shannon_value)
            results["bh_values"].append(bh_value)
            results["all_sol_values"].append(all_sol_value)
            results["dates"].append(date_str)
            results["prices"].append(sol_price)

        # Final stats
        final_shannon = results["shannon_values"][-1]
        final_bh = results["bh_values"][-1]
        final_all_sol = results["all_sol_values"][-1]

        return {
            "summary": {
                "data_source": "CoinGecko API",
                "period": f"{prices[0]['date']} to {prices[-1]['date']}",
                "days_analyzed": len(prices),
                "initial_capital": self.initial_capital,
                "start_price": prices[0]["close"],
                "end_price": prices[-1]["close"],
                "price_change": round(prices[-1]["close"] - prices[0]["close"], 2),
                "price_change_pct": round((prices[-1]["close"] - prices[0]["close"]) / prices[0]["close"] * 100, 2),
                "lowest_price": round(min(p["close"] for p in prices), 2),
                "highest_price": round(max(p["close"] for p in prices), 2)
            },
            "strategies": {
                "shannon_demon": {
                    "final_value": round(final_shannon, 2),
                    "gain": round(final_shannon - self.initial_capital, 2),
                    "return_pct": round((final_shannon - self.initial_capital) / self.initial_capital * 100, 2),
                    "rebalance_count": len(results["rebalances"]),
                    "peak_value": round(max(results["shannon_values"]), 2),
                    "lowest_value": round(min(results["shannon_values"]), 2),
                    "max_drawdown": round((min(results["shannon_values"]) - self.initial_capital) / self.initial_capital * 100, 2)
                },
                "buy_and_hold_50_50": {
                    "final_value": round(final_bh, 2),
                    "gain": round(final_bh - self.initial_capital, 2),
                    "return_pct": round((final_bh - self.initial_capital) / self.initial_capital * 100, 2),
                    "peak_value": round(max(results["bh_values"]), 2),
                    "lowest_value": round(min(results["bh_values"]), 2),
                    "max_drawdown": round((min(results["bh_values"]) - self.initial_capital) / self.initial_capital * 100, 2)
                },
                "all_sol": {
                    "final_value": round(final_all_sol, 2),
                    "gain": round(final_all_sol - self.initial_capital, 2),
                    "return_pct": round((final_all_sol - self.initial_capital) / self.initial_capital * 100, 2),
                    "peak_value": round(max(results["all_sol_values"]), 2),
                    "lowest_value": round(min(results["all_sol_values"]), 2),
                    "max_drawdown": round((min(results["all_sol_values"]) - self.initial_capital) / self.initial_capital * 100, 2)
                }
            },
            "rebalances": results["rebalances"],
            "daily_data": {
                "dates": results["dates"],
                "prices": results["prices"],
                "shannon": results["shannon_values"],
                "bh_50_50": results["bh_values"],
                "all_sol": results["all_sol_values"]
            }
        }

if __name__ == "__main__":
    # Fetch real prices from CoinGecko
    prices = fetch_coingecko_prices(days=144)

    if prices:
        # Run backtest
        print("\nRunning Shannon's Demon backtest...")
        backtest = ShannonDemonBacktest(initial_capital=10000.0)
        results = backtest.run_backtest(prices)

        # Output results
        print("\n" + "="*70)
        print("BACKTEST RESULTS")
        print("="*70)
        print(json.dumps(results, indent=2))

        # Save to file
        output_file = "backtest/coingecko_results.json"
        with open(output_file, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"\n✓ Results saved to {output_file}")
    else:
        print("\n✗ Failed to fetch price data. Please check your internet connection.")
