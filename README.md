# Shannon's Demon — Mercado Bitcoin Bot

Volatility-harvesting rebalancer holding HYPE/BRL at 50/50. Sells the outperformer and buys the underperformer whenever drift exceeds a dynamic threshold, capturing the volatility premium over time.

---

## Architecture

| Component | Role |
|---|---|
| **Local PM2 (`hype-mb`)** | Live rebalancer — runs 24/7, executes trades, sends Telegram alerts and daily digest at 00:30 BRT |
| **GitHub Actions** | Daily asset scanner (20:00 UTC) and monthly DB backup |

---

## Local PM2 Setup

### 1. Store credentials in GNOME Keyring

```bash
secret-tool store --label="MB Client ID"     service mercadobitcoin key clientId
secret-tool store --label="MB Client Secret" service mercadobitcoin key clientSecret
secret-tool store --label="Telegram Token"   service telegram key botToken
```

### 2. Configure the instance

Edit `bot/configs/hype-mb.yaml`:

```yaml
exchange: mercadobitcoin
symbol: HYPE-BRL
dbPath: ./data/hype-mb/shannonfi.db

rebalanceThresholdBps: 100
maxSlippageBps: 100
minPortfolioValueBrl: 200
minTradeSizeBrl: 20

useAdaptiveThreshold: true
thresholdVolatilityMultiplier: 1.5
volatilityWindowDays: 30

neverExceedExemptionLimit: false
dryRun: false
logLevel: info

telegram:
  chatId: "YOUR_CHAT_ID"
```

### 3. Start with PM2

```bash
npm install && cd bot && npm install && npm run build && cd ..
pm2 start ecosystem.config.cjs --only hype-mb
pm2 save
```

(`ecosystem.config.cjs`, at the repo root, defines every local instance — `hype-mb`, `coinbase-shannon-1`, etc. — each running `bot/start-instance.sh <name>`, which loads that instance's credentials from GNOME Keyring.)

### 4. Useful PM2 commands

```bash
pm2 logs hype-mb          # live logs
pm2 restart hype-mb       # restart after config change
pm2 stop hype-mb          # stop
pm2 status                # all instances
```

---

## GitHub Actions Setup

Four workflows run in the cloud, all against the `hype-mb` instance only (other local instances aren't mirrored to GitHub Actions):

| Workflow | Schedule | Purpose |
|---|---|---|
| `rebalancer.yml` | Hourly | Runs a single rebalance cycle (`--once`) |
| `scan.yml` | Daily 20:00 UTC | Scans all MB pairs, ranks by volatility score, sends results to Telegram |
| `dashboard.yml` | After each rebalancer run + every 6h | Regenerates and deploys the GitHub Pages dashboard |
| `monthly-db-backup.yml` | 1st of month 00:00 UTC | Creates a GitHub Release with a DB snapshot |

### Required secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `MB_CLIENT_ID` | Mercado Bitcoin client ID |
| `MB_CLIENT_SECRET` | Mercado Bitcoin client secret |
| `BINANCE_API_KEY` | Binance API key (only if running a Binance instance via Actions) |
| `BINANCE_API_SECRET` | Binance API secret |
| `COINBASE_API_KEY_NAME` | Coinbase CDP API key name (only if running a Coinbase instance via Actions) |
| `COINBASE_API_KEY_SECRET` | Coinbase CDP private key, full multi-line PEM block |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

To get your Telegram chat ID: message your bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat.id` value.

### Push secrets from local keyring (one-time)

```bash
gh secret set MB_CLIENT_ID       --body "$(secret-tool lookup service mercadobitcoin key clientId)"
gh secret set MB_CLIENT_SECRET   --body "$(secret-tool lookup service mercadobitcoin key clientSecret)"
gh secret set TELEGRAM_BOT_TOKEN --body "$(secret-tool lookup service telegram key botToken)"
gh secret set TELEGRAM_CHAT_ID   --body "YOUR_CHAT_ID"
```

---

## Telegram notifications

| Event | Sender |
|---|---|
| Trade executed | Local PM2 bot (immediate) |
| Daily digest at 00:30 BRT | Local PM2 bot |
| Asset scanner results | GitHub Actions (daily 20:00 UTC) |
| Monthly backup confirmation | GitHub Actions (1st of month) |

---

## Data files

All persistent state lives under `bot/data/hype-mb/`:

| File | Contents |
|---|---|
| `shannonfi.db` | Primary SQLite store (trades, snapshots, tax, cost basis) |
| `trade_history.json` | Rolling 15-day backup |
| `cost_basis.json` | AVCO state |
| `tax_events.json` | Rolling 15-day backup |
| `portfolio_snapshots.json` | Rolling 15-day backup |

---

## Dry-run / one-shot

```bash
cd bot
DRY_RUN=true node dist/index.js --config configs/hype-mb.yaml --once
```
