# Shannon's Demon — Mercado Bitcoin Bot

A fully autonomous rebalancer implementing the Shannon's Demon volatility-harvesting strategy on [Mercado Bitcoin](https://www.mercadobitcoin.com.br) (SOL/BRL).

**What it does:** Holds SOL and BRL in a 50/50 ratio by value and rebalances every 15 minutes when the ratio drifts beyond a dynamic threshold, selling the outperformer and buying the underperformer.

**Why:** Volatility-harvesting captures excess return from price oscillation — systematic mean-reversion trading. Over time, rebalancing a volatile asset pair beats buy-and-hold.

---

## Prerequisites

- Node 18+ (`node --version`)
- A [Mercado Bitcoin](https://www.mercadobitcoin.com.br) account with SOL and BRL balances
- API credentials from MB Account → Settings → API
- Linux/macOS with GNOME Keyring (for credential storage), or Windows/WSL2 with setup

---

## Installation

```bash
npm install
npm run build
```

---

## Credential Setup

### On Linux/macOS with GNOME Keyring (recommended)

Store your MB API credentials in the system keyring:

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
```

### On WSL2

Add this to `~/.bashrc` to auto-start the keyring daemon on shell login:

```bash
if [ -z "${GNOME_KEYRING_CONTROL:-}" ] && command -v gnome-keyring-daemon &>/dev/null; then
  eval $(gnome-keyring-daemon --start --components=secrets 2>/dev/null) 2>/dev/null || true
  export GNOME_KEYRING_CONTROL
fi
```

Then reload: `source ~/.bashrc`

### Config File

Copy the example config:

```bash
cp shannonfi.config.yaml.example shannonfi.config.yaml
```

Do NOT edit `clientId` or `clientSecret` in the file — leave them as `PLACEHOLDER`. The `start.sh` script injects them from the keyring at runtime.

---

## Configuration Reference

Edit `shannonfi.config.yaml` to tune the strategy and set your preferences.

### Exchange & Credentials

```yaml
exchange: mercadobitcoin    # only option; required

mercadobitcoin:
  clientId: "PLACEHOLDER"                                      # do NOT edit; from keyring
  clientSecret: "PLACEHOLDER"                                  # do NOT edit; from keyring
  # apiBaseUrl: https://api.mercadobitcoin.net/api/v4        # default; do not change
```

### Strategy Parameters

```yaml
# Rebalance threshold (basis points; 1 bps = 0.01%)
# Used as fallback if adaptive threshold fails.
# Default: 100 (1%)
rebalanceThresholdBps: 100

# Max acceptable slippage between expected and actual fill price (bps)
# Default: 100 (1%)
maxSlippageBps: 100

# Minimum portfolio size to start trading (BRL)
# Set this higher if you want to accumulate cash before the bot activates.
# Default: 200
minPortfolioValueBrl: 200

# Minimum trade size (BRL)
# Trades smaller than this are skipped (saves fees).
# Default: 20
minTradeSizeBrl: 20

# How often to check for rebalance opportunities (seconds)
# 900 = 15 minutes. MB API limit: 60 req/60s; we use ~1 per cycle.
# Recommended: 900 (daily-candle strategy aligns with 15-min polling)
# Range: 60–3600
pollIntervalSeconds: 900

# Minimum cooldown between rebalances (seconds)
# Prevents thrashing if price oscillates around the threshold.
# Default: 7200 (2 hours)
minRebalanceIntervalSeconds: 7200
```

### Volatility-Adaptive Threshold

```yaml
# When true, rebalance threshold is computed per cycle as:
#   threshold_bps = volatility_multiplier × 30day_mean_absolute_daily_return × 10000
# This automatically tightens the threshold in calm markets and loosens it in volatile ones.
# Falls back to rebalanceThresholdBps if candle fetch fails.
# Default: true (recommended)
useAdaptiveThreshold: true

# Multiplier for daily volatility (0.5–5.0)
# Lower = rebalance more often; higher = fewer trades (saves fees)
# Tradeoff: more frequent rebalancing captures more volatility but incurs more fees.
# Default: 1.5 (reasonable balance)
thresholdVolatilityMultiplier: 1.5

# Rolling window for volatility calculation (days; 7–90)
# Shorter = react faster to market regime changes; longer = smoother/more stable
# Default: 30 (standard lookback; captures monthly seasonality)
volatilityWindowDays: 30
```

### Tax Compliance (Brazil)

```yaml
# Lei 9.250/1995 Art. 21: Monthly SELL proceeds ≤ R$35,000 are exempt from capital gains tax.
# When true, the bot caps SELL_SOL trades so monthly gross proceeds stay ≤ R$34,650 
# (with 1% safety buffer). BUY_SOL trades are never capped.
# If remaining allowance < minTradeSizeBrl, the SELL is skipped.
# Default: false (tracking only; no capping)
#
# Set to true if you're approaching the R$35k/month threshold.
neverExceedExemptionLimit: false
```

### Runtime

```yaml
# Dry-run mode: simulate rebalances without placing real orders
# All logic runs normally; trades are logged with status DRY_RUN
# Useful for testing config changes before going live
# Default: false
dryRun: false

# Log level: error | warn | info | debug
# Default: info
logLevel: info
```

### Data Files

```yaml
# Paths are relative to the bot/ directory
# These files are created automatically on first run

tradeHistoryPath: ./data/trade_history.json              # all trades (for audit)
portfolioSnapshotsPath: ./data/portfolio_snapshots.json  # daily NAV snapshots
costBasisPath: ./data/cost_basis.json                    # AVCO cost basis tracking
taxEventsPath: ./data/tax_events.json                    # realized gains per trade
```

---

## Running the Bot

### Test Setup

Validate your credentials and account before going live:

```bash
npm run setup-check
```

This verifies MB authentication, fetches your balances, and checks API connectivity.

### Dry Run (Simulated)

Test a single rebalance cycle without placing real orders:

```bash
# Via npm script
npm run dev:once

# Or via bash with dryRun: true in config
bash start.sh  # (with dryRun: true)
```

Check the logs for rebalance logic and verify the portfolio snapshot.

### Single Live Cycle

Execute one rebalance and exit:

```bash
bash start.sh --once
```

Inspect the trade history to confirm the order was placed on MB.

### Continuous Operation (Recommended)

Run the bot in the background with PM2 (process manager):

```bash
# Install PM2 globally (once)
npm install -g pm2

# Start the bot
pm2 start ./start.sh --name shannonfi

# View logs
pm2 logs shannonfi

# Check status
pm2 status

# Stop or restart
pm2 stop shannonfi
pm2 restart shannonfi

# Save config so it auto-restarts on reboot
pm2 save
pm2 startup
```

PM2 will keep the bot alive if it crashes and auto-restart on system reboot.

---

## Monitoring & Tuning Over Time

### View Performance

```bash
bash start.sh --report
```

Prints:
- Total return (%) and CAGR
- Max drawdown
- Number of rebalances executed
- Total fees paid
- Days since last rebalance

### Interpret the Logs

Each cycle logs:
- **Price check**: Current SOL/BRL price
- **Computed adaptive threshold**: Volatility-based threshold for this cycle (if `useAdaptiveThreshold: true`)
- **Portfolio snapshot**: Current balances, SOL ratio, deviation from 50/50
- **Rebalance triggered** or **No rebalance needed**: Decision and why
- **Order placed**: Order ID and direction (if trade executed)
- **Error in rebalance cycle**: Network/API issues (will retry next cycle)

### Tuning the Strategy

**Rebalancing too often (high fees)?**
- Increase `thresholdVolatilityMultiplier` (e.g., 2.0 instead of 1.5)
- Increase `rebalanceThresholdBps` as fallback (e.g., 150 instead of 100)
- Increase `minRebalanceIntervalSeconds` cooldown (e.g., 10800 instead of 7200)

**Rebalancing too infrequently (missing volatility)?**
- Decrease `thresholdVolatilityMultiplier` (e.g., 1.0 instead of 1.5)
- Decrease `volatilityWindowDays` to react faster (e.g., 14 instead of 30)
- Ensure `useAdaptiveThreshold: true` is enabled

**Approaching R$35,000/month tax threshold?**
- Set `neverExceedExemptionLimit: true` to auto-cap SELL trades
- Monitor `data/tax_events.json` to see cumulative monthly gains

**Portfolio too small or trades too large?**
- Increase `minPortfolioValueBrl` to require larger account
- Increase `minTradeSizeBrl` to reduce dust trades

---

## Tax Compliance

### What's Tracked Automatically

Every SELL_SOL trade is logged with:
- Gross proceeds (BRL)
- Cost basis (BRL, via AVCO)
- Realized gain (BRL)
- Monthly cumulative sales
- Exemption status (≤ R$35,000 = exempt; > R$35,000 = taxable)
- Payment deadline (last Brazilian business day of following month)

See `data/tax_events.json` for the complete ledger.

### What You Must Do Manually

1. **If monthly realized gains > R$35,000:**
   - By the last Brazilian business day of the following month, file and pay DARF (tax payment receipt) in the amount of:
     - `realized_gain_brl × 0.15 ÷ 0.85` (simplified; consult a tax professional)
   - The payment deadline is printed in the logs and stored in `tax_events.json`

2. **Annual reconciliation:**
   - At year-end, calculate total realized gains from `tax_events.json`
   - Report on your annual tax return (IRPF) under "gains from the sale of assets"

3. **Record keeping:**
   - Keep `data/tax_events.json` and `data/trade_history.json` — they are your audit trail

---

## Troubleshooting

### "Cannot fetch price" or 400 errors

The bot retries automatically. If persistent:
- Check `npm run setup-check` to verify MB connectivity
- Check MB API status on their website
- Verify your IP is not rate-limited (MB has 60 req/60s limit)

### "Monthly exemption limit reached"

If `neverExceedExemptionLimit: true`, SELL trades are capped. If remaining allowance < `minTradeSizeBrl`, the trade is skipped until the next month.

### "Portfolio below minimum size"

Set `minPortfolioValueBrl` lower, or deposit more BRL/SOL.

### Keyring errors (WSL2)

Ensure `~/.bashrc` has the keyring startup block and `source ~/.bashrc` was run. If still failing:
```bash
pkill -f gnome-keyring-daemon
eval $(gnome-keyring-daemon --start --components=secrets)
```

---

## Architecture

**Components:**
- `src/adapters/mercadobitcoin/` — MB API client + adapter
- `src/core/rebalancer.ts` — Main rebalancing logic, guards, and cycle control
- `src/core/tracker/` — Trade history, PnL, cost basis, tax, volatility, metrics
- `src/config.ts` — Config parsing from YAML
- `src/scripts/setup-check.ts` — Pre-flight validation
- `start.sh` — Secure credential injection from keyring; entry point

**Data files:**
- `data/trade_history.json` — Complete audit log of all trades (append-only)
- `data/portfolio_snapshots.json` — Daily NAV snapshots for performance metrics
- `data/cost_basis.json` — AVCO (weighted average) cost in BRL
- `data/tax_events.json` — Realized gains ledger for tax reporting

---

## Support & Issues

- Check the logs: `pm2 logs shannonfi` or `bash start.sh --once`
- Run setup validation: `npm run setup-check`
- Read `shannonfi.config.yaml.example` for all config options
- Review `data/trade_history.json` for trade audit trail

---

**Last Updated:** 2026-05-26
