# Shannon's Demon — Mercado Bitcoin Bot

Volatility-harvesting rebalancer holding HYPE/BRL at 50/50. Sells the outperformer and buys the underperformer whenever drift exceeds a dynamic threshold, capturing the volatility premium over time.

---

## Architecture

`hype-mb` runs entirely on GitHub Actions — no local PM2 process (local PM2 was stopped 2026-08-02 to eliminate a dual-writer split-brain risk; see `CLAUDE.md`'s "`hype-mb` dual-writer incident").

| Component | Role |
|---|---|
| **GitHub Actions — `rebalancer.yml`** | Hourly single-cycle rebalance (`--once`), executes trades, sends Telegram trade notifications |
| **GitHub Actions — `scan.yml`** | Daily asset scanner (20:00 UTC), posts results to Telegram |
| **GitHub Actions — `dashboard.yml`** | Regenerates and deploys the GitHub Pages dashboard |
| **GitHub Actions — `monthly-db-backup.yml`** | Monthly DB snapshot as a GitHub Release |

---

## Local PM2 Setup

`hype-mb` itself does **not** run here (GitHub Actions is its sole runner, see above) — this section is for running a new local instance via PM2. `ecosystem.config.cjs` (repo root) currently has no active `apps` entries; add one following its instructions to bring up a new instance.

### 1. Store credentials in GNOME Keyring

```bash
secret-tool store --label="MB Client ID"     service mercadobitcoin key clientId
secret-tool store --label="MB Client Secret" service mercadobitcoin key clientSecret
secret-tool store --label="Telegram Token"   service telegram key botToken
```

### 2. Configure the instance

Create `bot/configs/<exchange>-shannon-<n>.yaml` (e.g. `bot/configs/coinbase-shannon-2.yaml`), following the naming convention `{exchange}-{strategy}-{n}` — copy from `bot/configs/coinbase-shannon-1.yaml.template` as a scaffold:

```yaml
exchange: mercadobitcoin   # or: coinbase
symbol: SOL-BRL             # BASE-BRL for mercadobitcoin, BASE-USDC for coinbase
dbPath: ./data/<instance-name>/shannonfi.db

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

Add an entry for the new instance to `apps: []` in `ecosystem.config.cjs` (repo root) — follow its own doc comment and the existing (commented-out) `hype-mb`/`coinbase-shannon-1` blocks as examples — then:

```bash
npm install && cd bot && npm install && npm run build && cd ..
pm2 start ecosystem.config.cjs --only <instance-name>
pm2 save
```

(Each app entry runs `bot/start-instance.sh <name>`, which loads that instance's credentials from GNOME Keyring.)

### 4. Useful PM2 commands

```bash
pm2 logs <instance-name>          # live logs
pm2 restart <instance-name>       # restart after config change
pm2 stop <instance-name>          # stop
pm2 status                        # all instances
```

---

## GitHub Actions Setup

Four workflows run in the cloud, all against the `hype-mb` instance only. `coinbase-shannon-1` is deprecated/stopped and not mirrored here either (its matrix entries are commented out, ready to reactivate for a future Coinbase instance).

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
| Trade executed | GitHub Actions `rebalancer.yml` (within the hourly cycle that executed it) |
| Daily digest at 00:30 BRT | Not currently sent for `hype-mb` — the digest only fires when a poll cycle happens to land in the 00:30–00:35 BRT window, which `rebalancer.yml`'s on-the-hour cron never does. Local PM2 (when running an instance) would send it. |
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
