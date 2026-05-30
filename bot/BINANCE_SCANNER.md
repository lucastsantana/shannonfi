# Binance Asset Scanner

The Binance asset scanner analyzes all BRL-paired trading pairs on Binance, scores them using Shannon's Demon volatility-premium formula, and sends daily reports to Telegram.

## Quick Start

### One-time Scan

```bash
cd bot
npm run scan:binance -- --config configs/btc-binance.yaml --window 30 --dry-run
```

### With Telegram Notifications

First, enable Telegram in your config:

```yaml
# configs/btc-binance.yaml
telegram:
  chatId: "1684226180"  # Your Telegram chat ID
```

Then run:

```bash
npm run scan:binance -- --config configs/btc-binance.yaml --window 30
```

## Daily Automated Scans

The scanner can be scheduled to run daily at 9 AM BRT via cron.

### Setup Instructions

1. **Verify the wrapper script exists:**

```bash
cat bot/scan-binance-daily.sh
```

2. **Add to your crontab:**

```bash
crontab -e
```

Add this line (9 AM BRT = 12:00 PM UTC):

```cron
0 12 * * * /home/user/repos/shannonfi/bot/scan-binance-daily.sh >> /home/user/repos/shannonfi/bot/logs/scanner/binance/cron.log 2>&1
```

Or use your local timezone:

```cron
TZ=America/Sao_Paulo 0 9 * * * /home/user/repos/shannonfi/bot/scan-binance-daily.sh >> /home/user/repos/shannonfi/bot/logs/scanner/binance/cron.log 2>&1
```

3. **Verify the cron job:**

```bash
crontab -l
tail -f /home/user/repos/shannonfi/bot/logs/scanner/binance/cron.log
```

## CLI Options

```
npm run scan:binance -- [options]

Options:
  --config <path>      Config file path (required)
  --window <days>      Analysis window in days (default: 30)
  --min-volume <brl>   Minimum daily volume filter in BRL (default: 5000)
  --top <n>            Display top N candidates (default: 15)
  --dry-run            Print to console only, no Telegram
```

### Examples

**Quick scan with default settings:**

```bash
npm run scan:binance -- --config configs/btc-binance.yaml
```

**60-day analysis, minimum R$10k daily volume:**

```bash
npm run scan:binance -- --config configs/btc-binance.yaml --window 60 --min-volume 10000
```

**Show top 25 candidates:**

```bash
npm run scan:binance -- --config configs/btc-binance.yaml --top 25
```

**Test without sending Telegram:**

```bash
npm run scan:binance -- --config configs/btc-binance.yaml --dry-run
```

## Scoring Formula

Each asset is scored using Shannon's Demon volatility premium:

```
SCORE = MAD × (1 + rolling_return)
```

Where:
- **MAD** = Mean Absolute Daily Return (volatility) over the analysis window
- **rolling_return** = Total return: `(lastPrice - firstPrice) / firstPrice`
- **Score** = Combined metric emphasizing high-volatility, positive-return assets

### Filtering

Assets are filtered by:
- **Return floor:** Excludes assets with rolling return < -20%
- **Minimum ADTV:** Excludes assets with < R$5,000 average daily trading volume
- **Stablecoins:** Automatically excluded (USDC, USDT, BUSD, etc.)

## Output Format

### Console Report

```
┌─────────────────────────────────────────────────────────────┐
│ Asset Scanner Results                                       │
│ Window: 30 days | Scanned: 15 symbols | Current: BTC-BRL   │
├─────────────────────────────────────────────────────────────┤
│ #  │ Symbol    │ MAD   │ Return │ Vol/day    │ Score      │
├─────────────────────────────────────────────────────────────┤
│  1 │ LINK-BRL  │  1.8% │ +  2.0% │    R$158K │   0.02    │
│  2 │ AVAX-BRL  │  1.6% │ +  0.1% │     R$66K │   0.02    │
│  3 │ PEPE-BRL  │  1.8% │  -10.3% │    R$555K │   0.02    │
...
└─────────────────────────────────────────────────────────────┘
```

### Telegram Report

Numbered ranked list with metrics:

```
1. LINK — MAD: 1.8% | ADTV: R$158K | Score: 0.018
2. AVAX — MAD: 1.6% | ADTV: R$66K | Score: 0.017
3. PEPE — MAD: 1.8% | ADTV: R$555K | Score: 0.015
...
```

## Configuration

### Binance Config Example

```yaml
exchange: binance
symbol: BTC-BRL              # Current trading pair

# Binance API credentials (loaded from GNOME Keyring at runtime)
# See CLAUDE.md for credential storage instructions

# Strategy parameters
rebalanceThresholdBps: 100
maxSlippageBps: 100
minPortfolioValueBrl: 10
minTradeSizeBrl: 1

# Adaptive threshold (volatility-responsive)
useAdaptiveThreshold: true
thresholdVolatilityMultiplier: 1.25
volatilityWindowDays: 30

# Runtime
dryRun: false
logLevel: info

# Data persistence
dbPath: ./data/btc-binance/shannonfi.db
jsonRetentionDays: 15

# Telegram (optional)
telegram:
  chatId: "1684226180"
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Invalid symbol` errors | Some symbols don't exist on Binance with -BRL pairing. Scanner filters these automatically. |
| No Telegram message sent | Ensure `telegram.chatId` is set in config and Telegram bot token is stored in GNOME Keyring. |
| Cron job not running | Check `crontab -l` and verify full path to script. Use `TZ=America/Sao_Paulo` prefix for local timezone. |
| Scanner timeouts | Network issue with Binance API. Wait and retry. |
| Credential errors | Verify Binance API key/secret are stored in GNOME Keyring: `secret-tool lookup service binance key apiKey` |

## Data Storage

All scan results are stored in SQLite for audit trail and replay:

```
./data/btc-binance/shannonfi.db   # Primary database
./data/btc-binance/               # Rolling JSON backups (15-day retention)
  ├─ trade_history.json
  ├─ portfolio_snapshots.json
  ├─ tax_events.json
  └─ cost_basis.json
```

## Comparing MB vs Binance

| Aspect | Mercado Bitcoin | Binance |
|--------|-----------------|---------|
| **Pairs** | 15 BRL-paired assets | 12+ BRL-paired assets |
| **Liquidity** | Lower on most pairs | Higher overall ADTV |
| **Fees** | Taker ~0.3% | Taker ~0.1% |
| **API** | OAuth2 (REST) | HMAC-SHA256 (REST) |
| **Orders** | Async polling | Mostly synchronous |
| **Scanner** | `npm run scan` | `npm run scan:binance` |

## Daily Reports

The scanner sends reports at the configured time with:
- **Symbol ranking** by Shannon premium score
- **Top candidate** highlighted with metrics
- **Liquidity & volatility** analysis
- **Interactive buttons** for approval (if configured)

**Telegram format example:**

```
🔍 Asset Scanner
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Window: 30 days | Scanned: 15

Top Candidates

1. LINK — MAD: 1.8% | ADTV: R$158K | Score: 0.018
2. AVAX — MAD: 1.6% | ADTV: R$66K | Score: 0.017
3. PEPE — MAD: 1.8% | ADTV: R$555K | Score: 0.015
...

📍 Metrics:
  MAD = Mean Absolute Daily Return (volatility)
  ADTV = Average Daily Trading Volume in BRL (liquidity)
  SCORE = MAD × (1 + return) — Shannon premium
```

## Related Documentation

- **Strategy:** See `CLAUDE.md` for Shannon's Demon deep dive
- **Live Bot:** See `README.md` for rebalancer setup
- **MB Scanner:** See `SCANNER_CRON.md` for Mercado Bitcoin scanner
- **Credentials:** See `CLAUDE.md` "Credentials Management" for API key setup

---

**Last Updated:** 2026-05-30
