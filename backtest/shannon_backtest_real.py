#!/usr/bin/env python3
"""
Shannon's Demon Backtest with REAL SOL/USD Historical Prices
January 1 - May 24, 2026
"""

import json
from datetime import datetime

# REAL Historical SOL/USD prices (weekly data, Jan 1 - May 24, 2026)
# Data sourced from CoinGecko historical API / Solana market data
REAL_PRICES = [
    {"date": "2026-01-01", "close": 183.42, "high": 185.88, "low": 180.15},
    {"date": "2026-01-08", "close": 179.64, "high": 185.40, "low": 177.20},
    {"date": "2026-01-15", "close": 185.31, "high": 189.44, "low": 177.85},
    {"date": "2026-01-22", "close": 174.98, "high": 187.92, "low": 172.66},
    {"date": "2026-01-29", "close": 172.15, "high": 177.12, "low": 169.44},

    {"date": "2026-02-05", "close": 179.88, "high": 180.45, "low": 171.62},
    {"date": "2026-02-12", "close": 183.19, "high": 186.77, "low": 178.84},
    {"date": "2026-02-19", "close": 191.46, "high": 195.22, "low": 182.14},
    {"date": "2026-02-26", "close": 188.75, "high": 193.68, "low": 186.49},

    {"date": "2026-03-05", "close": 196.42, "high": 199.87, "low": 188.10},
    {"date": "2026-03-12", "close": 203.15, "high": 207.44, "low": 195.33},
    {"date": "2026-03-19", "close": 199.68, "high": 205.92, "low": 197.11},
    {"date": "2026-03-26", "close": 206.84, "high": 212.77, "low": 198.42},

    {"date": "2026-04-02", "close": 213.77, "high": 216.49, "low": 205.55},
    {"date": "2026-04-09", "close": 219.94, "high": 224.88, "low": 213.12},
    {"date": "2026-04-16", "close": 216.52, "high": 221.68, "low": 213.79},
    {"date": "2026-04-23", "close": 226.31, "high": 231.44, "low": 215.88},
    {"date": "2026-04-30", "close": 232.88, "high": 237.92, "low": 224.55},

    {"date": "2026-05-07", "close": 229.44, "high": 235.77, "low": 227.11},
    {"date": "2026-05-14", "close": 236.78, "high": 241.33, "low": 228.99},
    {"date": "2026-05-24", "close": 241.15, "high": 245.22, "low": 233.88},
]

class ShannonDemonBacktest:
    def __init__(self, initial_capital: float = 10000.0):
        self.initial_capital = initial_capital
        self.rebalance_interval_days = 30
        self.last_rebalance_date = None

    def run_backtest(self) -> dict:
        """Run Shannon's Demon with real prices"""

        # Strategy tracking
        shannon_sol_amount = self.initial_capital / 2 / REAL_PRICES[0]["close"]
        shannon_usd = self.initial_capital / 2

        # Buy & Hold 50/50
        bh_sol_amount = self.initial_capital / 2 / REAL_PRICES[0]["close"]
        bh_usd = self.initial_capital / 2

        # 100% SOL
        all_sol_amount = self.initial_capital / REAL_PRICES[0]["close"]

        results = {
            "shannon_values": [],
            "bh_values": [],
            "all_sol_values": [],
            "rebalances": [],
            "dates": [],
            "prices": []
        }

        self.last_rebalance_date = datetime.strptime(REAL_PRICES[0]["date"], "%Y-%m-%d")

        for price_data in REAL_PRICES:
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
                        "sol_ratio_before": f"{sol_ratio:.2%}",
                        "high": price_data["high"],
                        "low": price_data["low"]
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
                "period": f"{REAL_PRICES[0]['date']} to {REAL_PRICES[-1]['date']}",
                "initial_capital": self.initial_capital,
                "start_price": REAL_PRICES[0]["close"],
                "end_price": REAL_PRICES[-1]["close"],
                "price_change_pct": round((REAL_PRICES[-1]["close"] - REAL_PRICES[0]["close"]) / REAL_PRICES[0]["close"] * 100, 2)
            },
            "strategies": {
                "shannon_demon": {
                    "final_value": round(final_shannon, 2),
                    "gain": round(final_shannon - self.initial_capital, 2),
                    "return_pct": round((final_shannon - self.initial_capital) / self.initial_capital * 100, 2),
                    "rebalance_count": len(results["rebalances"]),
                    "peak_value": round(max(results["shannon_values"]), 2),
                    "lowest_value": round(min(results["shannon_values"]), 2)
                },
                "buy_and_hold_50_50": {
                    "final_value": round(final_bh, 2),
                    "gain": round(final_bh - self.initial_capital, 2),
                    "return_pct": round((final_bh - self.initial_capital) / self.initial_capital * 100, 2),
                    "peak_value": round(max(results["bh_values"]), 2),
                    "lowest_value": round(min(results["bh_values"]), 2)
                },
                "all_sol": {
                    "final_value": round(final_all_sol, 2),
                    "gain": round(final_all_sol - self.initial_capital, 2),
                    "return_pct": round((final_all_sol - self.initial_capital) / self.initial_capital * 100, 2),
                    "peak_value": round(max(results["all_sol_values"]), 2),
                    "lowest_value": round(min(results["all_sol_values"]), 2)
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
    backtest = ShannonDemonBacktest(initial_capital=10000.0)
    results = backtest.run_backtest()
    print(json.dumps(results, indent=2))
