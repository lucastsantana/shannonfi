#!/usr/bin/env python3
"""
Shannon's Demon full backtest from SOL network inception to today.

Data:
  - SOL/USD: CoinGecko free API (days=max)
  - USD/BRL: yfinance BRL=X
  - CDI daily rate: BCB API series 12
  - IBOV: yfinance ^BVSP

Strategy:
  - 50/50 SOL/BRL, daily granularity
  - Adaptive threshold: clamp(round(MAD_30d * 10000 * 2.0), 50, 500) bps
  - 0.3% fee per rebalance on traded BRL amount
  - Two runs: neverExceedExemptionLimit=False and =True (R$34,650/month SELL cap)

Outputs:
  - inception_timeseries.csv   — daily portfolio values + metadata
  - INCEPTION_REPORT.md        — performance tables + rebalance log
  - inception_chart.png        — log-scale portfolio chart
"""

import sys
import json
import time
import math
import csv
from datetime import datetime, date, timedelta
from collections import defaultdict

import requests

try:
    import yfinance as yf
except ImportError:
    sys.exit("Missing dependency: pip install yfinance")

try:
    import pandas as pd
except ImportError:
    sys.exit("Missing dependency: pip install pandas")

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False
    print("Warning: matplotlib not installed — chart will be skipped")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

INITIAL_PORTFOLIO_BRL = 100.0
REBALANCE_FEE = 0.003          # 0.3% per trade
VOLATILITY_WINDOW = 30
MULTIPLIER = 2.0
MIN_THRESHOLD_BPS = 50
MAX_THRESHOLD_BPS = 500
BR_MONTHLY_LIMIT_BRL = 34_650.0   # R$35k with 1% safety buffer

STRATEGY_LABELS = {
    "shannon_nolimit":  "Shannon (no limit)",
    "shannon_taxlimit": "Shannon (tax limit)",
    "buyhold":          "50/50 Buy & Hold",
    "sol_only":         "100% SOL",
    "cdi":              "CDI",
    "ibov":             "IBOV",
}

# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def fetch_sol_usd() -> dict[str, float]:
    """Fetch all available daily SOL/USD closes from Yahoo Finance."""
    print("Fetching SOL/USD from Yahoo Finance (SOL-USD)...")
    # SOL-USD on Yahoo goes back to ~2020-04-10 (before mainnet; use from ~Aug 2020)
    df = yf.download("SOL-USD", start="2020-01-01", progress=False, auto_adjust=True)
    if df.empty:
        sys.exit("Failed to fetch SOL/USD from Yahoo Finance")
    closes = df["Close"].dropna()
    if hasattr(closes, "squeeze"):
        closes = closes.squeeze()
    result = {str(d.date()): float(v) for d, v in closes.items()}
    print(f"  Got {len(result)} days ({min(result)} → {max(result)})")
    return result


def fetch_usdbrl(start: str, end: str) -> dict[str, float]:
    """Fetch daily USD/BRL closes from yfinance (1 USD = X BRL)."""
    print("Fetching USD/BRL from yfinance...")
    df = yf.download("BRL=X", start=start, end=end, progress=False, auto_adjust=True)
    if df.empty:
        sys.exit("Failed to fetch USD/BRL from yfinance")
    closes = df["Close"].dropna()
    # yfinance returns a MultiIndex column when single ticker — flatten
    if hasattr(closes, "squeeze"):
        closes = closes.squeeze()
    result = {str(d.date()): float(v) for d, v in closes.items()}
    print(f"  Got {len(result)} days ({min(result)} → {max(result)})")
    return result


def fetch_cdi_daily(start: str, end: str) -> dict[str, float]:
    """
    Fetch daily CDI rate from BCB (Banco Central do Brasil) API.
    Series 12 = CDI taxa diaria (% ao dia).
    Returns a dict date→daily_factor (i.e. 1 + rate/100).
    """
    print("Fetching CDI daily rate from BCB...")
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt   = datetime.strptime(end,   "%Y-%m-%d")
    # BCB date format is DD/MM/YYYY
    url = (
        "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados"
        f"?formato=json&dataInicial={start_dt.strftime('%d/%m/%Y')}"
        f"&dataFinal={end_dt.strftime('%d/%m/%Y')}"
    )
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        data = r.json()
        result = {}
        for entry in data:
            raw_date = entry["data"]  # DD/MM/YYYY
            dt = datetime.strptime(raw_date, "%d/%m/%Y")
            daily_rate = float(entry["valor"]) / 100.0
            result[dt.strftime("%Y-%m-%d")] = 1.0 + daily_rate
        print(f"  Got {len(result)} trading days ({min(result)} → {max(result)})")
        return result
    except Exception as e:
        sys.exit(f"Failed to fetch CDI from BCB: {e}")


def fetch_ibov(start: str, end: str) -> dict[str, float]:
    """Fetch daily IBOV closes from yfinance."""
    print("Fetching IBOV from yfinance...")
    df = yf.download("^BVSP", start=start, end=end, progress=False, auto_adjust=True)
    if df.empty:
        sys.exit("Failed to fetch IBOV from yfinance")
    closes = df["Close"].dropna()
    if hasattr(closes, "squeeze"):
        closes = closes.squeeze()
    result = {str(d.date()): float(v) for d, v in closes.items()}
    print(f"  Got {len(result)} days ({min(result)} → {max(result)})")
    return result


# ---------------------------------------------------------------------------
# Strategy helpers
# ---------------------------------------------------------------------------

def compute_mad(prices: list[float]) -> float:
    """Mean absolute daily return for a price window."""
    if len(prices) < 2:
        return 0.0
    returns = [abs(prices[i] / prices[i-1] - 1.0) for i in range(1, len(prices))]
    return sum(returns) / len(returns)


def adaptive_threshold_bps(mad: float) -> int:
    raw = round(mad * 10_000 * MULTIPLIER)
    return max(MIN_THRESHOLD_BPS, min(MAX_THRESHOLD_BPS, raw))


def rebalance_to_50_50(sol_units: float, brl: float, price: float,
                        direction: str, cap_brl: float | None = None
                        ) -> tuple[float, float, float, float]:
    """
    Returns (new_sol_units, new_brl, fee_paid_brl, actual_trade_brl).
    cap_brl: max BRL that can be sold (tax limit); None = no cap.
    direction: 'BUY_SOL' or 'SELL_SOL'
    """
    total = sol_units * price + brl
    target_brl_each = total / 2.0

    if direction == "SELL_SOL":
        trade_brl = sol_units * price - target_brl_each   # BRL to receive
        if cap_brl is not None:
            trade_brl = min(trade_brl, cap_brl)
        if trade_brl <= 0:
            return sol_units, brl, 0.0, 0.0
        fee = trade_brl * REBALANCE_FEE
        net_receive = trade_brl - fee
        new_sol_units = sol_units - trade_brl / price
        new_brl = brl + net_receive
    else:  # BUY_SOL
        trade_brl = target_brl_each - sol_units * price    # BRL to spend
        if trade_brl <= 0:
            return sol_units, brl, 0.0, 0.0
        fee = trade_brl * REBALANCE_FEE
        spend = trade_brl + fee
        if spend > brl:
            spend = brl
            fee = spend * REBALANCE_FEE / (1 + REBALANCE_FEE)
            trade_brl = spend - fee
        new_sol_units = sol_units + trade_brl / price
        new_brl = brl - spend

    return new_sol_units, new_brl, fee, trade_brl


# ---------------------------------------------------------------------------
# Main backtest loop
# ---------------------------------------------------------------------------

def run_backtest(dates: list[str], sol_brl_prices: dict[str, float],
                 cdi_factors: dict[str, float], ibov_prices: dict[str, float],
                 never_exceed_limit: bool) -> dict:
    """
    Runs the backtest for Shannon (with/without tax limit), 50/50 B&H,
    100% SOL, CDI, and IBOV. Returns a dict of daily records + rebalance log.
    """
    first_price = sol_brl_prices[dates[0]]

    # Shannon state
    sh_sol   = INITIAL_PORTFOLIO_BRL / 2.0 / first_price
    sh_brl   = INITIAL_PORTFOLIO_BRL / 2.0
    sh_fees  = 0.0
    sh_monthly_sell: dict[str, float] = defaultdict(float)
    sh_rebalances = []

    # 50/50 B&H
    bh_sol = INITIAL_PORTFOLIO_BRL / 2.0 / first_price
    bh_brl = INITIAL_PORTFOLIO_BRL / 2.0

    # 100% SOL
    sol_units = INITIAL_PORTFOLIO_BRL / first_price

    # CDI — accumulate factor; use first available CDI date as anchor
    cdi_value = INITIAL_PORTFOLIO_BRL

    # IBOV — index return
    first_ibov = next((ibov_prices[d] for d in dates if d in ibov_prices), None)
    ibov_value = INITIAL_PORTFOLIO_BRL

    price_window: list[float] = []
    records = []

    for i, d in enumerate(dates):
        price = sol_brl_prices[d]
        price_window.append(price)
        if len(price_window) > VOLATILITY_WINDOW + 1:
            price_window.pop(0)

        # CDI compounding
        if d in cdi_factors:
            cdi_value *= cdi_factors[d]

        # IBOV
        if first_ibov and d in ibov_prices:
            ibov_value = INITIAL_PORTFOLIO_BRL * (ibov_prices[d] / first_ibov)

        # Compute threshold (needs 30 days of data)
        rebalanced = False
        threshold_bps = 0
        sol_ratio_bps = 0

        if len(price_window) >= VOLATILITY_WINDOW + 1:
            mad = compute_mad(price_window)
            threshold_bps = adaptive_threshold_bps(mad)

            sol_value = sh_sol * price
            total = sol_value + sh_brl
            sol_ratio_bps = round(sol_value / total * 10_000) if total > 0 else 5000
            deviation_bps = abs(sol_ratio_bps - 5000)

            if deviation_bps > threshold_bps:
                direction = "SELL_SOL" if sol_value > total / 2 else "BUY_SOL"

                cap = None
                if never_exceed_limit and direction == "SELL_SOL":
                    month_key = d[:7]
                    already_sold = sh_monthly_sell[month_key]
                    cap = max(0.0, BR_MONTHLY_LIMIT_BRL - already_sold)

                prev_sol = sh_sol
                sh_sol, sh_brl, fee, trade_brl = rebalance_to_50_50(
                    sh_sol, sh_brl, price, direction, cap_brl=cap
                )

                if trade_brl > 0:
                    sh_fees += fee
                    rebalanced = True
                    if direction == "SELL_SOL":
                        month_key = d[:7]
                        sh_monthly_sell[month_key] += trade_brl

                    sh_rebalances.append({
                        "date": d,
                        "price_brl": round(price, 4),
                        "direction": direction,
                        "trade_brl": round(trade_brl, 2),
                        "fee_brl": round(fee, 2),
                        "portfolio_before": round(prev_sol * price + sh_brl + fee, 2),
                        "threshold_bps": threshold_bps,
                        "deviation_bps": deviation_bps,
                    })

        sh_value  = sh_sol * price + sh_brl
        bh_value  = bh_sol * price + bh_brl
        sol_value_total = sol_units * price

        records.append({
            "date": d,
            "sol_price_brl": round(price, 4),
            "shannon": round(sh_value, 6),
            "buyhold": round(bh_value, 6),
            "sol_only": round(sol_value_total, 6),
            "cdi": round(cdi_value, 6),
            "ibov": round(ibov_value, 6),
            "threshold_bps": threshold_bps,
            "sol_ratio_bps": sol_ratio_bps,
            "rebalanced": rebalanced,
        })

    return {
        "records": records,
        "rebalances": sh_rebalances,
        "total_fees_brl": round(sh_fees, 2),
    }


# ---------------------------------------------------------------------------
# Performance metrics
# ---------------------------------------------------------------------------

def daily_returns(values: list[float]) -> list[float]:
    return [(values[i] - values[i-1]) / values[i-1] for i in range(1, len(values))]


def annualised_cdi(cdi_values: list[float]) -> float:
    if len(cdi_values) < 2:
        return 0.0
    total_return = cdi_values[-1] / cdi_values[0] - 1.0
    n_years = (len(cdi_values) - 1) / 252.0
    return (1.0 + total_return) ** (1.0 / n_years) - 1.0 if n_years > 0 else 0.0


def compute_metrics(values: list[float], rf_annual: float) -> dict:
    rets = daily_returns(values)
    n = len(values) - 1
    if n < 2:
        return {}

    n_years = n / 252.0
    total_ret = (values[-1] / values[0]) - 1.0
    annual_ret = (1.0 + total_ret) ** (1.0 / n_years) - 1.0 if n_years > 0 else 0.0

    vol = (sum((r - sum(rets)/len(rets))**2 for r in rets) / (len(rets)-1)) ** 0.5
    annual_vol = vol * math.sqrt(252)

    rf_daily = (1.0 + rf_annual) ** (1.0 / 252) - 1.0
    excess = [r - rf_daily for r in rets]
    sharpe = (sum(excess) / len(excess)) / (vol if vol > 0 else 1e-9) * math.sqrt(252)

    downside = [r - rf_daily for r in rets if r < rf_daily]
    sortino_vol = (sum(d**2 for d in downside) / len(downside)) ** 0.5 if downside else vol
    sortino = (annual_ret - rf_annual) / (sortino_vol * math.sqrt(252)) if sortino_vol > 0 else 0.0

    peak = values[0]
    max_dd = 0.0
    for v in values:
        peak = max(peak, v)
        dd = (v - peak) / peak
        max_dd = min(max_dd, dd)

    return {
        "total_return_pct": round(total_ret * 100, 2),
        "annual_return_pct": round(annual_ret * 100, 2),
        "annual_vol_pct":    round(annual_vol * 100, 2),
        "sharpe":            round(sharpe, 3),
        "sortino":           round(sortino, 3),
        "max_drawdown_pct":  round(max_dd * 100, 2),
        "final_value_brl":   round(values[-1], 2),
    }


def period_returns(records: list[dict], col: str, freq: str) -> list[tuple[str, float]]:
    """
    Compute per-period returns for a column.
    freq: 'M' (monthly), 'Q' (quarterly), 'Y' (yearly)
    """
    def period_key(d: str) -> str:
        dt = datetime.strptime(d, "%Y-%m-%d")
        if freq == "M":
            return f"{dt.year}-{dt.month:02d}"
        if freq == "Q":
            q = (dt.month - 1) // 3 + 1
            return f"{dt.year}-Q{q}"
        return str(dt.year)

    buckets: dict[str, list[float]] = defaultdict(list)
    for r in records:
        buckets[period_key(r["date"])].append(r[col])

    result = []
    for period in sorted(buckets.keys()):
        vals = buckets[period]
        if len(vals) >= 2:
            ret = (vals[-1] - vals[0]) / vals[0] * 100
            result.append((period, round(ret, 2)))
    return result


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

STRATS = ["shannon", "buyhold", "sol_only", "cdi", "ibov"]
STRAT_NAMES = ["Shannon", "50/50 B&H", "100% SOL", "CDI", "IBOV"]

def fmt_pct(v: float) -> str:
    return f"{v:+.2f}%"


def period_table_md(records: list[dict], freq: str, freq_label: str) -> str:
    cols = {s: period_returns(records, s, freq) for s in STRATS}
    # align periods
    periods = sorted(set(p for s in STRATS for p, _ in cols[s]))

    col_w = 12
    header = f"| {'Period':<10} |" + "".join(f" {n:>{col_w}} |" for n in STRAT_NAMES)
    sep    = f"|{'-'*12}|" + "".join(f"{'-'*(col_w+2)}|" for _ in STRATS)
    rows = [f"\n### {freq_label} Returns\n\n{header}\n{sep}"]

    lookup = {s: dict(cols[s]) for s in STRATS}
    for period in periods:
        row = f"| {period:<10} |"
        for s in STRATS:
            val = lookup[s].get(period)
            row += f" {fmt_pct(val) if val is not None else 'N/A':>{col_w}} |"
        rows.append(row)
    return "\n".join(rows)


def metrics_table_md(metrics: dict[str, dict], rebalance_counts: dict, fees: dict) -> str:
    labels = [
        ("total_return_pct",  "Total Return"),
        ("annual_return_pct", "Annual Return"),
        ("annual_vol_pct",    "Annual Volatility"),
        ("sharpe",            "Sharpe (CDI rf)"),
        ("sortino",           "Sortino (CDI rf)"),
        ("max_drawdown_pct",  "Max Drawdown"),
        ("final_value_brl",   "Final Value (R$)"),
    ]
    col_w = 16
    header = f"| {'Metric':<22} |" + "".join(f" {n:>{col_w}} |" for n in STRAT_NAMES)
    sep    = f"|{'-'*24}|" + "".join(f"{'-'*(col_w+2)}|" for _ in STRATS)
    rows = [header, sep]

    for key, label in labels:
        row = f"| {label:<22} |"
        for s in STRATS:
            v = metrics.get(s, {}).get(key, "N/A")
            if isinstance(v, float):
                if key in ("total_return_pct", "annual_return_pct", "annual_vol_pct", "max_drawdown_pct"):
                    cell = fmt_pct(v)
                elif key == "final_value_brl":
                    cell = f"R${v:.2f}"
                else:
                    cell = f"{v:.3f}"
            else:
                cell = str(v)
            row += f" {cell:>{col_w}} |"
        rows.append(row)

    # Rebalance count / fees rows (Shannon only)
    row = f"| {'Rebalance Count':<22} |"
    for s in STRATS:
        v = rebalance_counts.get(s, "—")
        row += f" {str(v):>{col_w}} |"
    rows.append(row)

    row = f"| {'Total Fees (R$)':<22} |"
    for s in STRATS:
        v = fees.get(s, "—")
        row += f" {str(v):>{col_w}} |"
    rows.append(row)

    return "\n".join(rows)


def rebalance_log_md(rebalances: list[dict], title: str) -> str:
    if not rebalances:
        return f"\n### {title}\n\nNo rebalances triggered.\n"
    header = "| Date       | Price (R$) | Direction | Trade (R$) | Fee (R$) | Portfolio | Threshold | Deviation |"
    sep    = "|------------|------------|-----------|------------|----------|-----------|-----------|-----------|"
    rows = [f"\n### {title}\n\n{header}\n{sep}"]
    for r in rebalances:
        rows.append(
            f"| {r['date']} | {r['price_brl']:>10.2f} | {r['direction']:<9} | "
            f"{r['trade_brl']:>10.2f} | {r['fee_brl']:>8.2f} | "
            f"{r['portfolio_before']:>9.2f} | {r['threshold_bps']:>9} | {r['deviation_bps']:>9} |"
        )
    return "\n".join(rows)


# ---------------------------------------------------------------------------
# Chart
# ---------------------------------------------------------------------------

def make_chart(records_nolimit: list[dict], records_taxlimit: list[dict],
               rebal_nolimit: list[dict], rebal_taxlimit: list[dict]) -> None:
    if not HAS_MATPLOTLIB:
        return

    dates_nl = [datetime.strptime(r["date"], "%Y-%m-%d") for r in records_nolimit]

    fig, ax = plt.subplots(figsize=(16, 8))

    colors = {
        "Shannon (no limit)": "#e74c3c",
        "Shannon (tax limit)": "#e67e22",
        "50/50 Buy & Hold":   "#3498db",
        "100% SOL":           "#9b59b6",
        "CDI":                "#2ecc71",
        "IBOV":               "#95a5a6",
    }
    series = [
        ("shannon",  "Shannon (no limit)",  records_nolimit),
        ("shannon",  "Shannon (tax limit)", records_taxlimit),
        ("buyhold",  "50/50 Buy & Hold",    records_nolimit),
        ("sol_only", "100% SOL",            records_nolimit),
        ("cdi",      "CDI",                 records_nolimit),
        ("ibov",     "IBOV",                records_nolimit),
    ]

    for col, label, recs in series:
        vals = [r[col] for r in recs]
        ax.plot(dates_nl[:len(vals)], vals, label=label,
                color=colors[label], linewidth=1.5, alpha=0.9)

    # Rebalance markers
    for r in rebal_nolimit:
        d = datetime.strptime(r["date"], "%Y-%m-%d")
        ax.axvline(d, color="#e74c3c", alpha=0.15, linewidth=0.5)

    ax.set_yscale("log")
    ax.set_title("Shannon's Demon — SOL/BRL Since Inception (R$100 start)", fontsize=14)
    ax.set_xlabel("Date")
    ax.set_ylabel("Portfolio Value (R$, log scale)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    ax.xaxis.set_major_locator(mdates.YearLocator())
    ax.legend(loc="upper left", fontsize=9)
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("inception_chart.png", dpi=150)
    print("Chart saved to inception_chart.png")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    # 1. Fetch SOL/USD
    sol_usd = fetch_sol_usd()
    if not sol_usd:
        sys.exit("No SOL/USD data")

    start_date = min(sol_usd)
    end_date   = max(sol_usd)
    # Add one day for yfinance end (exclusive)
    end_yf = (datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

    # 2. Fetch USD/BRL
    usd_brl = fetch_usdbrl(start_date, end_yf)

    # 3. Compute SOL/BRL on common dates (forward-fill USD/BRL for weekends)
    # Build a sorted list of dates from SOL/USD; fill FX gaps with last known value
    all_sol_dates = sorted(sol_usd)
    last_fx = None
    sol_brl: dict[str, float] = {}
    for d in all_sol_dates:
        fx = usd_brl.get(d, last_fx)
        if fx is None:
            continue
        last_fx = fx
        sol_brl[d] = sol_usd[d] * fx

    # 4. Fetch CDI and IBOV
    cdi_factors = fetch_cdi_daily(start_date, end_date)
    ibov_raw    = fetch_ibov(start_date, end_yf)

    # Forward-fill IBOV for weekends/holidays
    last_ibov = None
    ibov_prices: dict[str, float] = {}
    for d in sorted(sol_brl):
        v = ibov_raw.get(d, last_ibov)
        if v is not None:
            last_ibov = v
            ibov_prices[d] = v

    # 5. Aligned date list
    dates = sorted(sol_brl)
    print(f"\nBacktest period: {dates[0]} → {dates[-1]}  ({len(dates)} days)")

    # 6. Run backtests
    print("\nRunning Shannon (no exemption limit)...")
    result_nolimit  = run_backtest(dates, sol_brl, cdi_factors, ibov_prices, never_exceed_limit=False)

    print("Running Shannon (with tax exemption limit)...")
    result_taxlimit = run_backtest(dates, sol_brl, cdi_factors, ibov_prices, never_exceed_limit=True)

    records_nl = result_nolimit["records"]
    records_tl = result_taxlimit["records"]

    # 7. Save time series CSV (no-limit Shannon as reference for shared columns)
    csv_path = "inception_timeseries.csv"
    fieldnames = [
        "date", "sol_price_brl",
        "shannon_nolimit", "shannon_taxlimit",
        "buyhold", "sol_only", "cdi", "ibov",
        "threshold_bps", "sol_ratio_bps",
        "rebalanced_nolimit", "rebalanced_taxlimit",
    ]
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        tl_by_date = {r["date"]: r for r in records_tl}
        for r in records_nl:
            d = r["date"]
            tl = tl_by_date.get(d, r)
            writer.writerow({
                "date":              d,
                "sol_price_brl":     r["sol_price_brl"],
                "shannon_nolimit":   r["shannon"],
                "shannon_taxlimit":  tl["shannon"],
                "buyhold":           r["buyhold"],
                "sol_only":          r["sol_only"],
                "cdi":               r["cdi"],
                "ibov":              r["ibov"],
                "threshold_bps":     r["threshold_bps"],
                "sol_ratio_bps":     r["sol_ratio_bps"],
                "rebalanced_nolimit":  r["rebalanced"],
                "rebalanced_taxlimit": tl["rebalanced"],
            })
    print(f"Time series saved to {csv_path}")

    # 8. Metrics
    cdi_vals  = [r["cdi"] for r in records_nl]
    rf_annual = annualised_cdi(cdi_vals)

    def extract(recs, col):
        return [r[col] for r in recs]

    metrics_nl = {
        "shannon": compute_metrics(extract(records_nl, "shannon"), rf_annual),
        "buyhold":  compute_metrics(extract(records_nl, "buyhold"),  rf_annual),
        "sol_only": compute_metrics(extract(records_nl, "sol_only"), rf_annual),
        "cdi":      compute_metrics(extract(records_nl, "cdi"),      rf_annual),
        "ibov":     compute_metrics(extract(records_nl, "ibov"),     rf_annual),
    }
    metrics_tl = {
        "shannon": compute_metrics(extract(records_tl, "shannon"), rf_annual),
    }

    rebal_counts_nl = {"shannon": len(result_nolimit["rebalances"]),  "buyhold": 0, "sol_only": 0, "cdi": 0, "ibov": 0}
    fees_nl         = {"shannon": result_nolimit["total_fees_brl"],    "buyhold": 0, "sol_only": 0, "cdi": 0, "ibov": 0}
    rebal_counts_tl = {"shannon": len(result_taxlimit["rebalances"]), "buyhold": 0, "sol_only": 0, "cdi": 0, "ibov": 0}
    fees_tl         = {"shannon": result_taxlimit["total_fees_brl"],   "buyhold": 0, "sol_only": 0, "cdi": 0, "ibov": 0}

    # 9. Print console summary
    print("\n" + "="*80)
    print("OVERALL RISK METRICS — Shannon (no limit) + Benchmarks")
    print("="*80)
    for s, name in zip(STRATS, STRAT_NAMES):
        m = metrics_nl.get(s, {})
        print(f"  {name:<20} | Total: {m.get('total_return_pct', 0):>8.2f}%  "
              f"Annual: {m.get('annual_return_pct', 0):>7.2f}%  "
              f"Sharpe: {m.get('sharpe', 0):>6.3f}  "
              f"MaxDD: {m.get('max_drawdown_pct', 0):>7.2f}%  "
              f"Final: R${m.get('final_value_brl', 0):>9.2f}")

    print(f"\n  Shannon (tax limit) | Total: {metrics_tl['shannon'].get('total_return_pct', 0):>8.2f}%  "
          f"Annual: {metrics_tl['shannon'].get('annual_return_pct', 0):>7.2f}%  "
          f"Sharpe: {metrics_tl['shannon'].get('sharpe', 0):>6.3f}  "
          f"MaxDD: {metrics_tl['shannon'].get('max_drawdown_pct', 0):>7.2f}%  "
          f"Final: R${metrics_tl['shannon'].get('final_value_brl', 0):>9.2f}")

    print(f"\n  CDI risk-free rate (annualised): {rf_annual*100:.2f}%")
    print(f"  Shannon no-limit rebalances: {rebal_counts_nl['shannon']}, fees: R${fees_nl['shannon']:.2f}")
    print(f"  Shannon tax-limit rebalances: {rebal_counts_tl['shannon']}, fees: R${fees_tl['shannon']:.2f}")

    # Note if tax limit never triggered
    if result_nolimit["rebalances"] == result_taxlimit["rebalances"]:
        peak_nl = max(r["shannon"] for r in records_nl)
        print(f"\n  Note: Tax limit (R${BR_MONTHLY_LIMIT_BRL:,.0f}/month) never bound with R${INITIAL_PORTFOLIO_BRL:.0f} "
              f"starting portfolio (peak value R${peak_nl:.2f}). "
              f"Both Shannon variants are identical.")

    # 10. Build Markdown report
    md_lines = [
        "# Shannon's Demon — Full Backtest Since SOL Inception",
        "",
        f"**Period:** {dates[0]} → {dates[-1]} ({len(dates)} trading days)",
        f"**Initial portfolio:** R${INITIAL_PORTFOLIO_BRL:.2f}",
        f"**Strategy:** Adaptive threshold (30-day MAD × {MULTIPLIER}), clamped [{MIN_THRESHOLD_BPS}, {MAX_THRESHOLD_BPS}] bps",
        f"**Fee per rebalance:** {REBALANCE_FEE*100:.1f}%",
        f"**CDI risk-free rate (annualised):** {rf_annual*100:.2f}%",
        "",
        "## Overall Risk Metrics — Shannon (no limit)",
        "",
        metrics_table_md(metrics_nl, rebal_counts_nl, fees_nl),
        "",
        "## Overall Risk Metrics — Shannon (tax limit)",
        "",
        "> **Note:** With a R$100 starting portfolio, the R$34,650/month SELL cap (Lei 9.250) "
        "never binds — the portfolio's peak value was well below that threshold. "
        "Both variants are therefore identical. The tax limit would only differentiate "
        "with a starting portfolio large enough to generate >R$34,650 in monthly SELL proceeds.",
        "",
        metrics_table_md(metrics_tl, rebal_counts_tl, fees_tl),
        "",
        period_table_md(records_nl, "Y", "Yearly"),
        "",
        period_table_md(records_nl, "Q", "Quarterly"),
        "",
        period_table_md(records_nl, "M", "Monthly"),
        "",
        rebalance_log_md(result_nolimit["rebalances"],  "Rebalance Log — Shannon (no limit)"),
        "",
        rebalance_log_md(result_taxlimit["rebalances"], "Rebalance Log — Shannon (tax limit)"),
        "",
        "---",
        "*Generated by `shannon_since_inception.py`*",
    ]

    report_path = "INCEPTION_REPORT.md"
    with open(report_path, "w") as f:
        f.write("\n".join(md_lines))
    print(f"Report saved to {report_path}")

    # 11. Chart
    make_chart(records_nl, records_tl,
               result_nolimit["rebalances"], result_taxlimit["rebalances"])


if __name__ == "__main__":
    main()
