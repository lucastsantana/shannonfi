# Shannon's Demon Bot — Complete User Guide

This document is a comprehensive skill guide for using the Shannon's Demon volatility-harvesting trading bot. It covers everything from initial setup through advanced configuration, monitoring, and troubleshooting.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start (5 minutes)](#quick-start-5-minutes)
3. [Architecture & How It Works](#architecture--how-it-works)
4. [Installation & Setup](#installation--setup)
5. [Configuration Guide](#configuration-guide)
6. [Running the Bot](#running-the-bot)
7. [Monitoring & Reporting](#monitoring--reporting)
8. [Daily Digest Email](#daily-digest-email)
9. [Tax Compliance](#tax-compliance)
10. [Troubleshooting](#troubleshooting)
11. [Advanced Topics](#advanced-topics)

---

## Overview

**Shannon's Demon** is a volatility-harvesting strategy that holds two assets (SOL and BRL) in a fixed 50/50 ratio by value and rebalances whenever the ratio drifts beyond a threshold. This implementation runs on **Mercado Bitcoin** (SOL/BRL pair) and is fully autonomous.

### Why It Works

Volatility-harvesting captures excess returns from price oscillation through systematic mean-reversion trading:
- When SOL price rises → SOL becomes >50% of portfolio → bot sells SOL, buys BRL
- When SOL price falls → SOL becomes <50% of portfolio → bot buys SOL, sells BRL
- Each rebalance locks in gains from volatility, beating buy-and-hold over time

### Key Facts

- **Funds stay in Mercado Bitcoin** — no custody risk, no blockchain fees
- **Fully autonomous** — runs 24/7 with minimal user intervention
- **Brazilian tax-compliant** — tracks Lei 9.250/1995 Art. 21 exemptions automatically
- **SQLite persistence** — all trades, snapshots, and tax events stored locally
- **Monthly reports** — auto-generated performance summaries with benchmarks
- **Daily digest emails** — morning summary of yesterday's activity
- **62 unit tests** — well-tested, production-ready code
- **Dry-run mode** — test configuration without placing real orders

---

## Quick Start (5 minutes)

### 1. Prerequisites

- **Node.js 20+** — check with `node --version`
- **Mercado Bitcoin account** with SOL and BRL balances
- **MB API credentials** from Account → Settings → API
- **GNOME Keyring** (Linux/macOS/WSL2) for secure credential storage

### 2. Clone & Install

```bash
cd /path/to/repo
cp bot/shannonfi.config.yaml.example bot/shannonfi.config.yaml
cd bot
npm install
npm run build
```

### 3. Store Credentials

```bash
# Store Mercado Bitcoin credentials
secret-tool store --label="Mercado Bitcoin Client ID" \
  service mercadobitcoin key clientId
# (paste your Client ID, then press Ctrl+D)

secret-tool store --label="Mercado Bitcoin Client Secret" \
  service mercadobitcoin key clientSecret
# (paste your Client Secret, then press Ctrl+D)

# Verify they're stored
secret-tool lookup service mercadobitcoin key clientId
```

### 4. Validate Setup

```bash
npm run setup-check
```

This verifies MB credentials, fetches your balances, and confirms API connectivity.

### 5. Test with Dry Run

```bash
npm run dev:once
```

This runs one rebalance cycle in simulation mode (no real orders). Check logs for portfolio snapshot and rebalance decision.

### 6. Run Live (Single Cycle)

```bash
bash start.sh --once
```

This executes one real rebalance cycle and exits. Check `data/trade_history.json` to confirm the trade was placed on MB.

### 7. Run Continuously (Recommended)

```bash
npm install -g pm2
pm2 start ./start.sh --name shannonfi
pm2 logs shannonfi
pm2 save
pm2 startup
```

The bot will now run 24/7, rebalancing every 15 minutes (or when drift exceeds threshold).

---

## Architecture & How It Works

### Rebalance Cycle (Every 15 minutes)

```
1. Get SOL/BRL price from Mercado Bitcoin (1 API call)
   ↓
2. Fetch portfolio snapshot (SOL and BRL balances)
   ↓
3. Compute SOL allocation ratio (as % of total value)
   ↓
4. Check if drift from 50% target exceeds threshold
   ↓
   NO → Sleep 15 min, repeat
   ↓
5. Check cooldown (min 2 hours between rebalances)
   ↓
   YES → Skip, retry later
   ↓
6. Compute trade size (BRL amount to buy/sell)
   ↓
7. Place market order on Mercado Bitcoin
   ↓
8. Poll order status (every 3 sec, max 30 sec)
   ↓
9. Record trade, update cost basis, compute tax event
   ↓
10. Save portfolio snapshot for performance tracking
    ↓
    Sleep 15 min, repeat
```

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point; orchestrates the rebalance cycle |
| `src/config.ts` | Zod schema; loads and validates `shannonfi.config.yaml` |
| `src/math.ts` | Pure functions (ratios, thresholds, trade calculations) |
| `src/adapters/mercadobitcoin/` | OAuth2 client, order execution, price/balance fetching |
| `src/core/rebalancer.ts` | Main rebalancing logic and guards |
| `src/core/tracker/` | Trade history, cost basis (AVCO), tax events, metrics |
| `data/shannonfi.db` | SQLite database (trades, snapshots, tax, cost basis) |
| `data/trade_history.json` | 15-day rolling JSON backup (audit trail) |
| `start.sh` | Wrapper that loads MB credentials from GNOME Keyring |

### Decision Flow

```
Is portfolio value < minPortfolioValueBrl?
  YES → SKIP (portfolio too small)
  NO ↓

Has price been fetched?
  NO → ERROR (fetch price first)
  YES ↓

Is deviation from 50% > effective_threshold_bps?
  NO → SKIP (drift within tolerance)
  YES ↓

Has minRebalanceIntervalSeconds passed since last rebalance?
  NO → SKIP (cooldown active)
  YES ↓

Fetch latest balances & compute trade size

Is trade size < minTradeSizeBrl?
  NO → SKIP (trade too small, not worth fees)
  YES ↓

Place market order on Mercado Bitcoin

Is order successfully filled?
  NO → ERROR (retry next cycle)
  YES ↓

Is fill price within maxSlippageBps of expected?
  NO → WARN (slippage detected, but record trade)
  YES ↓

Record trade, update cost basis, compute tax event
```

---

## Installation & Setup

### 1. Clone Repository

```bash
git clone https://github.com/lucastsantana/shannonfi.git
cd shannonfi
```

### 2. Install Dependencies

```bash
cd bot
npm install
npm run build
```

### 3. Store Mercado Bitcoin Credentials

Credentials are stored in GNOME Keyring (encrypted, survives restarts).

**Option A: Interactive Setup (Recommended)**

```bash
npm run setup-check
```

This script will prompt you for MB Client ID and Client Secret, store them in the keyring, and verify connectivity.

**Option B: Manual Storage**

```bash
# Store Client ID
secret-tool store --label="Mercado Bitcoin Client ID" \
  service mercadobitcoin key clientId
# (paste your Client ID when prompted)

# Store Client Secret
secret-tool store --label="Mercado Bitcoin Client Secret" \
  service mercadobitcoin key clientSecret
# (paste your Client Secret when prompted)

# Verify they're stored
secret-tool lookup service mercadobitcoin key clientId
secret-tool lookup service mercadobitcoin key clientSecret
```

### 4. Create Config File

```bash
cp shannonfi.config.yaml.example shannonfi.config.yaml
```

**Do NOT edit `clientId` or `clientSecret` in the YAML file** — leave them as `PLACEHOLDER`. The `start.sh` wrapper injects them from the keyring at runtime.

### 5. Keyring Setup for WSL2

If you're using WSL2, add this to `~/.bashrc` to auto-start GNOME Keyring on shell login:

```bash
if [ -z "${GNOME_KEYRING_CONTROL:-}" ] && command -v gnome-keyring-daemon &>/dev/null; then
  eval $(gnome-keyring-daemon --start --components=secrets 2>/dev/null) 2>/dev/null || true
  export GNOME_KEYRING_CONTROL
fi
```

Then reload: `source ~/.bashrc`

### 6. Validate Setup

```bash
npm run setup-check
```

This verifies:
- ✓ MB credentials are accessible from keyring
- ✓ API authentication works (OAuth2 token refresh)
- ✓ Can fetch SOL/BRL price
- ✓ Can read your account balances
- ✓ Network connectivity to Mercado Bitcoin

---

## Configuration Guide

### File: `shannonfi.config.yaml`

```yaml
# ─── Exchange & Credentials ────────────────────────────────────
exchange: mercadobitcoin

mercadobitcoin:
  clientId: "PLACEHOLDER"              # From GNOME Keyring
  clientSecret: "PLACEHOLDER"          # From GNOME Keyring
  # apiBaseUrl: https://api.mercadobitcoin.net/api/v4   # default


# ─── Strategy Parameters ───────────────────────────────────────

# Rebalance threshold in basis points (1 bps = 0.01%)
# Used as fallback if adaptive threshold fails
# Range: 10–2000 bps. Default: 100 (1%)
rebalanceThresholdBps: 100

# Max acceptable slippage between expected and actual fill price (bps)
# Range: 10–500 bps. Default: 100 (1%)
maxSlippageBps: 100

# Minimum portfolio size to start trading (BRL)
# Set higher if you want to accumulate before bot activates
# Default: 200
minPortfolioValueBrl: 200

# Minimum trade size (BRL)
# Trades smaller than this are skipped (saves fees)
# Default: 20
minTradeSizeBrl: 20

# How often to check for rebalance opportunities (seconds)
# MB API limit: 60 req/60s; bot uses ~1 per cycle
# Recommended: 900 (15 minutes)
# Range: 60–3600
pollIntervalSeconds: 900

# Minimum cooldown between rebalances (seconds)
# Prevents thrashing if price oscillates around threshold
# Default: 7200 (2 hours)
minRebalanceIntervalSeconds: 7200


# ─── Volatility-Adaptive Threshold ──────────────────────────────

# When true, rebalance threshold is computed per cycle as:
#   threshold = volatility_multiplier × 30day_mean_absolute_daily_return × 10000
# This tightens threshold in calm markets, loosens in volatile ones
# Falls back to rebalanceThresholdBps if candle fetch fails
# Default: true (recommended)
useAdaptiveThreshold: true

# Multiplier for daily volatility (0.5–5.0)
# Lower = rebalance more often (capture more, pay more fees)
# Higher = fewer trades (save fees, miss some volatility)
# Tradeoff: more frequent rebalancing vs fee efficiency
# Default: 1.5 (balanced)
thresholdVolatilityMultiplier: 1.5

# Rolling window for volatility calculation (days; 7–90)
# Shorter = react faster to market regime changes
# Longer = smoother/more stable thresholds
# Default: 30 (standard lookback)
volatilityWindowDays: 30


# ─── Tax Compliance (Brazil) ────────────────────────────────────

# Lei 9.250/1995 Art. 21: Monthly SELL proceeds ≤ R$35,000 exempt
# When true, caps SELL_SOL trades so monthly proceeds stay ≤ R$34,650
# (1% safety buffer). BUY_SOL trades are never capped.
# If remaining allowance < minTradeSizeBrl, SELL is skipped.
# Default: false (tracking only; no capping)
neverExceedExemptionLimit: false


# ─── Runtime ───────────────────────────────────────────────────

# Dry-run mode: simulate rebalances without placing real orders
# All logic runs normally; trades logged with status DRY_RUN
# Default: false
dryRun: false

# Log level: error | warn | info | debug
# Default: info
logLevel: info


# ─── Data Persistence ──────────────────────────────────────────

# SQLite database path (created automatically)
# Default: ./data/shannonfi.db
dbPath: ./data/shannonfi.db

# Days to keep data in JSON rolling backup
# After this period, old records are pruned from JSON (stay in SQLite)
# Default: 15
jsonRetentionDays: 15


# ─── Daily Digest Email ────────────────────────────────────────

# Optional: Store SMTP credentials in GNOME Keyring using:
#   npm run setup-smtp
#
# Fallback (less secure): Specify here
# smtp:
#   host: smtp.mail.yahoo.com
#   port: 587
#   secure: false
#   username: your-email@yahoo.com.br
#   password: your-app-password
#   recipientEmail: your-email@yahoo.com.br
```

### Common Configuration Scenarios

#### Scenario 1: Conservative (Fewer Trades, Lower Fees)

```yaml
rebalanceThresholdBps: 150          # 1.5% minimum drift
minRebalanceIntervalSeconds: 10800  # 3 hours cooldown
thresholdVolatilityMultiplier: 2.0  # Wait for more volatility
volatilityWindowDays: 30
```

#### Scenario 2: Aggressive (More Trades, Capture More Volatility)

```yaml
rebalanceThresholdBps: 75           # 0.75% minimum drift
minRebalanceIntervalSeconds: 3600   # 1 hour cooldown
thresholdVolatilityMultiplier: 1.0  # Lower threshold
volatilityWindowDays: 14            # React faster to regime changes
```

#### Scenario 3: Approaching R$35k Tax Threshold

```yaml
neverExceedExemptionLimit: true  # Auto-cap SELL trades
# Monitor data/tax_events.json to see cumulative monthly sales
```

---

## Running the Bot

### Test Setup (Validate Credentials)

```bash
npm run setup-check
```

Output shows your SOL balance, BRL balance, and total portfolio value.

### Dry Run (Simulate Without Real Orders)

```bash
npm run dev:once
```

Runs one cycle with `dryRun: true` in memory. Check logs for:
- Current price
- Portfolio ratio
- Rebalance decision (triggered or skipped)
- Simulated trade (not placed on MB)

### Single Live Cycle

```bash
bash start.sh --once
```

Executes one real rebalance cycle. Credentials are injected from GNOME Keyring. Check:
- Logs for order details
- `data/trade_history.json` to confirm trade was placed

### Continuous Operation (Recommended)

```bash
# Install PM2 (process manager)
npm install -g pm2

# Start bot
pm2 start ./start.sh --name shannonfi

# View logs in real-time
pm2 logs shannonfi

# Check status
pm2 status

# Stop
pm2 stop shannonfi

# Restart
pm2 restart shannonfi

# Make it persist across reboots
pm2 save
pm2 startup
```

PM2 will:
- Keep the bot alive if it crashes
- Auto-restart on system reboot
- Manage logs (viewable with `pm2 logs`)

### One-Off Commands

```bash
# Check all-time performance summary
bash start.sh --report

# Generate report for a specific month
npm run report -- --month 2026-05

# Send yesterday's digest email manually
npm run daily-digest
```

---

## Monitoring & Reporting

### View Live Logs

```bash
pm2 logs shannonfi
```

Each cycle logs:
- **Price check**: Current SOL/BRL price
- **Adaptive threshold**: Computed from 30-day volatility (if enabled)
- **Portfolio snapshot**: SOL balance, BRL balance, ratio %, deviation from 50%
- **Rebalance decision**: Triggered or skipped, and why
- **Order details**: Order ID, fill price, fee, realized gain (if SELL)

### Performance Summaries

**Quick all-time summary:**
```bash
bash start.sh --report
```

Prints:
- Total return (%)
- CAGR (annualized)
- Max drawdown
- Number of rebalances executed
- Total fees paid
- Days since last rebalance

**Monthly report:**
```bash
npm run report -- --month 2026-05
```

Generates `data/reports/2026-05.md` with:
- **Executive summary** — rule-based qualitative analysis
- **Monthly & cumulative metrics** — return, drawdown, rebalances, fees
- **Benchmark comparison** — vs SOL-only, CDI (risk-free), IBOV (equity)
- **Rebalance history** — table of all trades with prices and fees
- **Tax summary** — Lei 9.250/1995 Art. 21 compliance status
- **Portfolio state** — current holdings, AVCO cost basis, unrealized P&L
- **Track record** — CAGR, Sharpe, max drawdown, total fees

Reports are auto-generated on the **1st of each month at 03:00 AM BRT** via:
- **Local**: systemd timer (`systemctl --user list-timers`)
- **Cloud**: GitHub Actions (`.github/workflows/monthly-report.yml`)

### Data Files

| File | Contents |
|------|----------|
| `data/shannonfi.db` | SQLite: trades, snapshots, tax events, cost basis (authoritative) |
| `data/trade_history.json` | JSON: last 15 days of trades (rolling backup) |
| `data/portfolio_snapshots.json` | JSON: last 15 days of daily snapshots (rolling backup) |
| `data/tax_events.json` | JSON: last 15 days of tax events (rolling backup) |
| `data/cost_basis.json` | JSON: current AVCO cost per SOL (rolling backup) |
| `data/reports/YYYY-MM.md` | Monthly performance reports |

---

## Daily Digest Email

The bot sends a formatted email summary every morning at **00:30 AM BRT** with yesterday's trading activity.

### Setup (Recommended: GNOME Keyring)

```bash
npm run setup-smtp
```

This interactive script will:
1. Prompt for your Yahoo email and app password
2. Store them encrypted in GNOME Keyring (like MB credentials)
3. Test SMTP connection to verify settings
4. Exit on success

**Yahoo Mail Setup:**
1. Go to [Account Security](https://login.yahoo.com/account/security)
2. Click **"Generate app password"**
3. Select app: **Other App**, enter: **Shannon's Demon**
4. Copy the 16-character password and paste it when running `npm run setup-smtp`

### Automated Scheduling

**Local (systemd):**

```bash
systemctl --user daemon-reload
systemctl --user enable --now shannonfi-daily-digest.timer
```

Runs at **00:30 AM BRT (03:30 UTC)** every day. Check with:

```bash
systemctl --user list-timers shannonfi-daily-digest.timer
journalctl --user -u shannonfi-daily-digest.service --no-pager
```

**Cloud (GitHub Actions):**

If deployed on GitHub, `.github/workflows/daily-digest.yml` runs automatically at the same time.

Requires secrets:
- `MB_CLIENT_ID`, `MB_CLIENT_SECRET` (for SQLite cache)
- `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_RECIPIENT_EMAIL` (for email)

### Email Contents

Each digest includes:
- **Daily return (%)** and absolute P&L (BRL)
- **Portfolio composition** — SOL balance, BRL balance, allocation %
- **SOL allocation drift** from 50% target
- **Trading activity** — count of rebalances, buys, sells, fees paid
- **SOL price movement** — start, end, change

### Manual Testing

```bash
npm run daily-digest
```

This sends an email for yesterday's activity. If no snapshots exist for yesterday (bot wasn't running), it exits silently.

---

## Tax Compliance

### Lei 9.250/1995 Art. 21 (Domestic Crypto Trading)

**The Rule:**
- SELL proceeds ≤ R$35,000/month → **Exempt from capital gains tax**
- SELL proceeds > R$35,000/month → **Taxable; payment due last business day of following month**
- BUY trades → **No tax event** (cost basis only)

**Bot Tracking:**
Every SELL_SOL trade is logged with:
- Gross proceeds (BRL)
- Cost basis (AVCO method)
- Realized gain (BRL)
- Monthly cumulative sales
- Exemption status
- DARF payment deadline (if applicable)

View in: `data/tax_events.json`

### What the Bot Does Automatically

1. **Records** — Every SELL trade is logged with realized gain
2. **Computes** — AVCO cost basis updated on each trade
3. **Tracks** — Monthly cumulative sales and exemption status
4. **Calculates** — DARF payment deadline (last business day of following month)
5. **Stores** — All data in SQLite and JSON for audit trail

### What You Must Do Manually

**If monthly realized gains > R$35,000:**
1. By the last business day of the following month, file and pay DARF
2. Amount to pay: `(realized_gain_brl × 0.15) / 0.85` (simplified; consult tax professional)
3. Payment deadline is printed in logs and stored in `tax_events.json`

**At year-end:**
1. Calculate total realized gains from `tax_events.json`
2. Report on your IRPF annual tax return under "gains from sale of assets"
3. Keep `tax_events.json` and `trade_history.json` as audit trail

---

## Troubleshooting

### Bot Won't Start

**Error: "Config file not found"**
```bash
cd bot
cp shannonfi.config.yaml.example shannonfi.config.yaml
```

**Error: "401 Unauthorized" or "Invalid credentials"**
```bash
# Check if credentials are in keyring
secret-tool lookup service mercadobitcoin key clientId
secret-tool lookup service mercadobitcoin key clientSecret

# If missing, re-store them
secret-tool store service mercadobitcoin key clientId
# (paste your ID, Ctrl+D)

secret-tool store service mercadobitcoin key clientSecret
# (paste your Secret, Ctrl+D)

# Verify connectivity
npm run setup-check
```

### Orders Not Executing

**Error: "400 Bad Request" during order status poll**
- This is usually transient. Bot retries automatically on next cycle.
- Check MB API status on their website.
- Verify your IP isn't rate-limited (MB allows 60 req/60s).

**No rebalances happening**
- Check logs: `pm2 logs shannonfi`
- Is `useAdaptiveThreshold: true`? If volatility is very low, threshold might be high
- Check `volatilityWindowDays` (30 is default) and `thresholdVolatilityMultiplier` (1.5 is default)
- Verify `pollIntervalSeconds` (default 900 = 15 min)

**"Portfolio below minimum size"**
- Set `minPortfolioValueBrl` lower, or deposit more SOL/BRL
- Default: 200 BRL

### GNOME Keyring Issues (WSL2)

**Error: "org.freedesktop.DBus.Error.ServiceUnknown"**
```bash
# Check if keyring daemon is running
echo $GNOME_KEYRING_CONTROL

# If empty, start it manually
eval $(gnome-keyring-daemon --start --components=secrets)
export GNOME_KEYRING_CONTROL
```

**Credentials lost after reboot**
Add this to `~/.bashrc`:
```bash
if [ -z "${GNOME_KEYRING_CONTROL:-}" ] && command -v gnome-keyring-daemon &>/dev/null; then
  eval $(gnome-keyring-daemon --start --components=secrets 2>/dev/null) 2>/dev/null || true
  export GNOME_KEYRING_CONTROL
fi
```

Then: `source ~/.bashrc`

### Daily Digest Not Sending

**Email never arrives**
- Run manually: `npm run daily-digest` and check logs
- Verify Yahoo app password is correct (16 chars)
- Check email spam folder
- Re-run setup: `npm run setup-smtp`

**"SMTP authentication failed"**
```bash
# Test SMTP connection
npm run setup-smtp
```

This will verify host, port, and credentials. If it fails, check:
- Yahoo app password (from Account Security, not main password)
- Firewall not blocking port 587
- VPN not interfering with SMTP

**"No data for yesterday"**
- Bot needs to be running and have at least one snapshot
- Script skips email if no trading data exists for that date (normal)
- Check: `ls -lh data/shannonfi.db` to verify database exists and has size

---

## Advanced Topics

### Volatility-Adaptive Threshold

**How it works:**

1. Fetch 30 days of SOL/BRL daily candles from MB (free public endpoint)
2. Compute **MAD** (Mean Absolute Daily Return): avg(|daily % change|)
3. Compute threshold: `round(MAD × 10,000 × multiplier)` BPS
4. Clamp to [50, 500] BPS (0.5% floor, 5% ceiling)
5. Cache per calendar day → no re-fetch until next day

**Example:**
- High volatility (MAD 2%): threshold = 2% × 1.5 = 3%
- Low volatility (MAD 0.3%): threshold = 0.3% × 1.5 = 0.45% → clamped to 50 BPS (0.5%)

**Tuning:**
- **Too many trades?** Increase `thresholdVolatilityMultiplier` (e.g., 2.0)
- **Missing volatility?** Decrease `thresholdVolatilityMultiplier` (e.g., 1.0)
- **Slow to react?** Decrease `volatilityWindowDays` (e.g., 14)
- **Noisy?** Increase `volatilityWindowDays` (e.g., 60)

### Cost Basis Tracking (AVCO)

**AVCO = Weighted Average Cost**

Every BUY updates the average cost:
```
new_avg = (old_total_cost + new_purchase_cost) / total_sol
```

Every SELL uses current average to compute realized gain:
```
realized_gain = (sell_proceeds) - (sol_sold × current_avg_cost)
```

Stored in: `data/cost_basis.json`

**Example:**
- Buy 1 SOL at R$400 → cost basis = R$400
- Buy 1 SOL at R$450 → cost basis = (400 + 450) / 2 = R$425
- Sell 1 SOL at R$500 → realized gain = 500 - 425 = R$75

### Slippage Monitoring

**Slippage** = difference between expected fill price and actual fill price

The bot:
1. Computes expected fill price from last known price
2. Executes market order
3. Checks actual fill price
4. If `|actual - expected| / expected > maxSlippageBps` → warns in logs, but records trade

**Why this matters:**
- Market orders don't guarantee a price
- High slippage suggests illiquid market or network delay
- Mercado Bitcoin taker fees (~0.3%) + slippage can erode gains
- Increasing `maxSlippageBps` (default 100 = 1%) allows larger price gaps

### Cooldown Interval

**Purpose:** Prevent "thrashing" if price oscillates around threshold.

**Default:** 2 hours (`minRebalanceIntervalSeconds: 7200`)

**Scenario:**
- Price oscillates: +1.5% → rebalance triggered
- 5 minutes later: -1.5% → threshold exceeded again, but cooldown blocks it
- 2 hours later: cooldown expires, next rebalance is allowed

**Tuning:**
- **Too conservative?** Lower to 3600 (1 hour) or 1800 (30 min)
- **Thrashing?** Raise to 10800 (3 hours) or 14400 (4 hours)

### Dry Run Mode

Test changes without placing real orders:

```bash
# In shannonfi.config.yaml
dryRun: true

npm run dev:once
```

Or via environment:
```bash
DRY_RUN=true node dist/index.js --once
```

**What happens:**
- All logic runs normally
- Trades logged with status `DRY_RUN`
- No orders actually placed
- Portfolio not updated
- Cost basis not changed

### Recovery from Crashes

If the bot crashes during order execution, a trade might be placed but not recorded. To check:

```bash
npm run setup-check
```

This fetches your current balances. Compare with `data/trade_history.json` to identify orphaned trades.

**Manual recovery:**
1. Check Mercado Bitcoin order history to find the missing trade
2. Manually insert a trade record in `data/trade_history.json` (or update SQLite)
3. Update cost basis in `data/cost_basis.json`
4. Restart bot

---

## Additional Resources

- **Strategy Paper**: [Shannon's Demon on Wikipedia](https://en.wikipedia.org/wiki/Entropy_and_second_law_of_thermodynamics)
- **Exchange API**: [Mercado Bitcoin REST v4](https://www.mercadobitcoin.com.br)
- **Brazilian Tax**: Lei 9.250/1995 Art. 21 (domestic crypto trading exemption)
- **Repository**: [https://github.com/lucastsantana/shannonfi](https://github.com/lucastsantana/shannonfi)
- **Backtest Results**: See `backtest/HISTORICAL_BENCHMARK_REPORT.md` for strategy validation

---

**Last Updated:** 2026-05-27

**Questions?** Review the logs (`pm2 logs shannonfi`), check the troubleshooting section, or open an issue on GitHub.
