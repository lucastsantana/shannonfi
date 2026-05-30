# Configuration Guide

Complete reference for all Shannon's Demon configuration parameters.

## Config File Locations

```
bot/configs/
├── hype-mb.yaml         # HYPE-BRL on Mercado Bitcoin
├── btc-binance.yaml     # BTC-BRL on Binance
└── template.yaml        # Copy this to add new strategies
```

## Structure

```yaml
# Exchange & Asset
exchange: mercadobitcoin    # or: binance
symbol: HYPE-BRL            # or: BTC-BRL, SOL-BRL, etc.

# Exchange credentials (loaded from GNOME Keyring)
mercadobitcoin:            # if exchange: mercadobitcoin
  clientId: "PLACEHOLDER"
  clientSecret: "PLACEHOLDER"
  apiBaseUrl: "https://api.mercadobitcoin.net/api/v4"

binance:                   # if exchange: binance
  apiKey: "PLACEHOLDER"
  apiSecret: "PLACEHOLDER"
  apiBaseUrl: "https://api.binance.com"

# Strategy Parameters
rebalanceThresholdBps: 100
maxSlippageBps: 100
minPortfolioValueBrl: 10
minTradeSizeBrl: 1
pollIntervalSeconds: 300
minRebalanceIntervalSeconds: 300

# Adaptive Threshold
useAdaptiveThreshold: true
thresholdVolatilityMultiplier: 1.25
volatilityWindowDays: 30

# Tax Compliance (Mercado Bitcoin only)
neverExceedExemptionLimit: true

# Runtime
dryRun: false
logLevel: info

# Data Persistence
dbPath: ./data/hype-mb/shannonfi.db
jsonRetentionDays: 15
```

## Parameter Reference

### Exchange & Asset

| Parameter | Type | Example | Notes |
|-----------|------|---------|-------|
| `exchange` | string | `mercadobitcoin`, `binance` | Which exchange to trade on |
| `symbol` | string | `HYPE-BRL`, `BTC-BRL` | Trading pair (base-quote) |

### Exchange Credentials

**Mercado Bitcoin:**
- `clientId`: API client ID from MB dashboard
- `clientSecret`: API client secret (keep secret!)
- `apiBaseUrl`: Default `https://api.mercadobitcoin.net/api/v4` (rarely change)

**Binance:**
- `apiKey`: API key from Binance API Management
- `apiSecret`: API secret (keep secret!)
- `apiBaseUrl`: Default `https://api.binance.com` (or `https://api.binance.us` for US)

**Security note**: Set to `"PLACEHOLDER"`. Real values loaded from GNOME Keyring at runtime:
```bash
secret-tool store service mercadobitcoin key clientId
secret-tool store service binance key apiKey
```

### Strategy Parameters

#### Rebalance Threshold

| Parameter | Type | Range | Default | Notes |
|-----------|------|-------|---------|-------|
| `rebalanceThresholdBps` | integer | 10-2000 | 100 | Drift trigger in basis points (bps). 1 bps = 0.01% |

**What it means**: Rebalance when portfolio deviates from 50/50 by more than this amount.

**Examples:**
- `100` bps = 1% drift → rebalance when SOL allocation hits 49% or 51%
- `50` bps = 0.5% drift → more frequent rebalancing (higher fees)
- `200` bps = 2% drift → less frequent (may miss profit opportunities)

**Tuning:**
- Higher = fewer trades, lower fees, but slower return to 50/50
- Lower = more trades, higher fees, but tighter tracking

**Default**: 100 bps is a good balance for most assets.

#### Max Slippage

| Parameter | Type | Range | Default | Notes |
|-----------|------|-------|---------|-------|
| `maxSlippageBps` | integer | 10-500 | 100 | Max acceptable fill price deviation (bps) |

**What it means**: Warn if fill price deviates from expected price by more than this.

**Examples:**
- Expected price: R$400/SOL
- `100` bps = R$4 tolerance → accept fills between R$396-404
- `200` bps = R$8 tolerance → more lenient
- `50` bps = R$2 tolerance → stricter

**Note**: High slippage is logged but trade still executes. Slippage check is informational.

**Tuning**: Match your exchange's typical spread. MB spreads are tighter than Binance.

#### Portfolio Minimums

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `minPortfolioValueBrl` | float | 10 | Skip rebalancing if total < this |
| `minTradeSizeBrl` | float | 1 | Skip trade if rebalance amount < this |

**Why?** Very small portfolios waste money on fees.

**Examples:**
- Portfolio R$50 with `minPortfolioValueBrl: 200` → skip rebalancing
- Rebalance needs R$0.50 with `minTradeSizeBrl: 1` → skip
- Rebalance needs R$50 with `minTradeSizeBrl: 1` → execute

**Tuning**:
- Set `minPortfolioValueBrl` to 3-5× your typical trade size
- Set `minTradeSizeBrl` to cover exchange fees + slippage

#### Poll Interval

| Parameter | Type | Range | Default | Notes |
|-----------|------|-------|---------|-------|
| `pollIntervalSeconds` | integer | 60-3600 | 900 | How often to check price (seconds) |

**Meaning**: How many seconds between price checks.

**Examples:**
- `300` = check every 5 minutes = 288 checks/day
- `600` = check every 10 minutes = 144 checks/day
- `900` = check every 15 minutes = 96 checks/day

**Trade-off**: More frequent = faster to catch volatility but higher API costs. Less frequent = lower costs but might miss moves.

**Tuning**:
- High-liquidity assets (BTC, ETH): can use longer intervals (900s+)
- Low-liquidity assets: shorter intervals (300s) to catch moves
- Cost-conscious: longer intervals (1800s+)

#### Min Rebalance Interval

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `minRebalanceIntervalSeconds` | integer | 300 | Minimum seconds between consecutive rebalances |

**Meaning**: Once you rebalance, don't rebalance again for at least this long.

**Why?** Prevent thrashing if price oscillates around the threshold.

**Examples:**
- `300` (5 min) = rebalance at most every 5 minutes
- `7200` (2 hours) = rebalance at most every 2 hours
- `0` = no minimum (not recommended)

**Tuning**: Set to 1-2× your poll interval to avoid thrashing.

### Adaptive Threshold

| Parameter | Type | Range | Default | Notes |
|-----------|------|-------|---------|-------|
| `useAdaptiveThreshold` | boolean | true/false | true | Use volatility-based threshold |
| `thresholdVolatilityMultiplier` | float | 0.5-5.0 | 1.25 | Multiplier for volatility-based threshold |
| `volatilityWindowDays` | integer | 7-90 | 30 | Days of history for volatility calculation |

**How it works**: Instead of fixed threshold, compute:
```
threshold = (mean_absolute_daily_return × multiplier × 10000) bps
clamped to [50, 500] bps
```

**Examples with multiplier 1.25:**
- Calm market (0.3% daily volatility) → threshold 50 bps (floor)
- Normal market (1% daily volatility) → threshold 125 bps
- Volatile market (2% daily volatility) → threshold 250 bps
- Extreme (5% daily volatility) → threshold 500 bps (ceiling)

**Tuning:**
- `multiplier 0.5` = aggressive (low thresholds, frequent trades)
- `multiplier 1.0` = moderate (balanced)
- `multiplier 2.0` = conservative (high thresholds, rare trades)
- `volatilityWindowDays`: larger = smoother (less reactive to spikes)

### Tax Compliance (Mercado Bitcoin Only)

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `neverExceedExemptionLimit` | boolean | false | Cap SELL trades to stay ≤ R$35k/month |

**Lei 9.250/1995 Art. 21 (Brazil-specific)**:
- SELL proceeds ≤ R$35,000/month: exempt from capital gains tax
- Above that: taxable

**What this does**: If `true`, skip or cap SELL trades to avoid exceeding R$34,650 monthly limit (with 1% safety buffer).

**Example:**
- Month sales so far: R$30,000
- Next rebalance wants to SELL R$10,000 → would exceed limit
- With `neverExceedExemptionLimit: true` → CAP to R$4,650 (stay under limit)
- With `neverExceedExemptionLimit: false` → execute full R$10,000 (now taxable)

**Note**: Only applies to MB. Binance trades are always taxable.

### Runtime

| Parameter | Type | Options | Notes |
|-----------|------|---------|-------|
| `dryRun` | boolean | true/false | Simulate trades without executing |
| `logLevel` | string | error/warn/info/debug | Console verbosity |

**dryRun**: Useful for testing. All trades logged as `status: DRY_RUN`, no real orders placed.

**logLevel**:
- `error`: Only errors
- `warn`: Errors + warnings (recommended for production)
- `info`: Errors + warnings + key events (default, best for monitoring)
- `debug`: Everything including internal details (verbose)

### Data Persistence

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `dbPath` | string | `./data/shannonfi.db` | SQLite database location |
| `jsonRetentionDays` | integer | 15 | Days to keep JSON backups |

**CRITICAL**: Each instance must have a unique `dbPath`.

**dbPath examples:**
- `./data/hype-mb/shannonfi.db` — HYPE-BRL instance
- `./data/btc-binance/shannonfi.db` — BTC-BRL instance
- `./data/sol-binance/shannonfi.db` — SOL-BRL instance

**jsonRetentionDays**: Rolling window of JSON backups. Records older than N days are deleted from JSON but kept in SQLite.

## Preset Configurations

### Conservative (Low frequency, high fees tolerance)

```yaml
rebalanceThresholdBps: 200      # 2% drift
pollIntervalSeconds: 1800       # 30 min
minTradeSizeBrl: 100
thresholdVolatilityMultiplier: 2.0
```

Use for: Small portfolios, low-liquidity assets

### Moderate (Default)

```yaml
rebalanceThresholdBps: 100      # 1% drift
pollIntervalSeconds: 300        # 5 min
minTradeSizeBrl: 1
thresholdVolatilityMultiplier: 1.25
```

Use for: General purpose (HYPE-BRL, BTC-BRL)

### Aggressive (High frequency, volatility capture)

```yaml
rebalanceThresholdBps: 50       # 0.5% drift
pollIntervalSeconds: 60         # 1 min
minTradeSizeBrl: 1
thresholdVolatilityMultiplier: 0.5
```

Use for: High-liquidity assets (BTC, ETH), if fees are low

## Common Tuning Scenarios

### "Fees are eating my profits"

```yaml
rebalanceThresholdBps: 150      # Increase threshold (fewer trades)
pollIntervalSeconds: 900        # Poll less often
minTradeSizeBrl: 50             # Skip tiny trades
```

### "I'm not capturing volatility swings"

```yaml
rebalanceThresholdBps: 75       # Decrease threshold (more trades)
pollIntervalSeconds: 300        # Poll more often
minTradeSizeBrl: 1              # Execute smaller trades
```

### "Too many rebalances, slowing portfolio recovery"

```yaml
minRebalanceIntervalSeconds: 7200  # Enforce 2-hour cooldown
```

### "Want to hit the Lei 9.250 exemption exactly"

```yaml
neverExceedExemptionLimit: true
minTradeSizeBrl: 5              # Ensure minimum precision
```

## Validation

The bot validates configs on startup. Common errors:

```
exchange must be 'mercadobitcoin' or 'binance'
symbol must match BASE-BRL (e.g., SOL-BRL)
rebalanceThresholdBps must be 10-2000
pollIntervalSeconds must be 60-3600
dbPath must be an absolute or relative path
```

If you see a validation error, check your YAML syntax and parameter ranges above.

---

**Next**: See [STRATEGY.md](./STRATEGY.md) for parameter meaning, or [MULTI_INSTANCE.md](./MULTI_INSTANCE.md) to add instances.
