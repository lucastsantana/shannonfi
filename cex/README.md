# Shannon's Demon CEX Bot

Automated 50/50 SOL/USD rebalancing bot using [Shannon's Demon](https://en.wikipedia.org/wiki/Entropy_and_second_law_of_thermodynamics) volatility-harvesting strategy on Coinbase Advanced Trade API.

## Overview

Shannon's Demon maintains a 50/50 allocation between SOL and USD by value. When the ratio drifts beyond a threshold (default 1%), it rebalances: selling the over-weight asset and buying the under-weight one. Over time this systematically sells high and buys low, harvesting volatility into excess return.

This bot is a TypeScript port of the on-chain Solana vault in `../programs/shannonfi/`. It runs against a Coinbase retail account instead of a smart contract vault — no blockchain or gas fees, funds stay on Coinbase.

**Key differences from the on-chain vault:**

| Feature | On-chain Vault | CEX Bot |
|---|---|---|
| Custody | Solana PDA vault | Your Coinbase account |
| Trading pair | SOL/USDC | SOL/USD |
| Price feed | Pyth Pull Oracle | Coinbase best bid/ask |
| Execution | Jupiter v6 CPI | Coinbase market order |
| Rebalance trigger | Keeper wallet + slot interval | Cron job + time cooldown |
| Keeper fee | 0.1% vault AUM | None (you are the keeper) |
| Tokenized shares | Yes (6-decimal SPL token) | No (single-user bot) |

See `../backtest/` for historical performance analysis (12-month results with real Coinbase price data).

---

## Architecture

```
src/
├── index.ts              Entry point. Wires all services; --once flag for GitHub Actions.
├── config.ts             Zod-validated env loading. Fails fast on misconfiguration.
├── constants.ts          Port of constants.rs — thresholds, rate limits, API paths.
├── math.ts               Port of math.rs — computeSolRatioBps, shouldRebalance,
│                         computeRebalanceTrade, usdToSol, isqrt, etc.
├── coinbase/
│   ├── auth.ts           JWT ES256 generation per Coinbase CDP spec (fresh token per request).
│   ├── client.ts         Axios HTTP client + Bottleneck rate limiter (10 req/s) + retry.
│   ├── endpoints.ts      Typed wrappers: listAccounts, getBestBidAsk, createOrder,
│   │                     getOrder, getCandles.
│   └── types.ts          Complete Coinbase Advanced Trade v3 API response interfaces.
├── bot/
│   ├── portfolio.ts      Fetches SOL + USD balances and mid-market price in parallel.
│   │                     Returns a Portfolio snapshot with ratio/deviation pre-computed.
│   ├── trader.ts         Builds and places market orders. Polls for fill (2s interval,
│   │                     60s timeout). Dry-run shim logs intent without calling API.
│   └── rebalancer.ts     Core loop (port of rebalance.rs + keeper.ts). Five guards:
│                         min portfolio size, drift threshold, cooldown interval,
│                         min trade size, balance check. Persists cooldown via history.
├── tracker/
│   ├── logger.ts         Winston: JSON file transports + colorized console.
│   ├── history.ts        Append-only JSON trade log. getLastRebalanceTime() restores
│   │                     cooldown state across restarts and --once invocations.
│   └── pnl.ts            Per-trade structured log + printReport() summary.
└── scripts/
    ├── setup-check.ts    Pre-flight: auth, SOL/USD accounts, SOL-USD market, candles.
    └── backtest.ts       Historical replay via Coinbase ONE_DAY candles with paging.
```

**Request flow for a rebalance cycle:**

```
RebalancerBot.checkAndRebalance()
  └─ PortfolioService.getPortfolio()
       ├─ CoinbaseEndpoints.listAccounts()   ─┐ parallel
       └─ CoinbaseEndpoints.getBestBidAsk()  ─┘
  └─ [guards: size, drift, cooldown, trade size]
  └─ TraderService.executeTrade(direction, usdAmount)
       ├─ CoinbaseEndpoints.createOrder()
       └─ CoinbaseEndpoints.getOrder()  (polled until FILLED or timeout)
  └─ PortfolioService.getPortfolio()  (post-trade snapshot)
  └─ TradeHistoryService.appendTrade()
  └─ PnlService.logRebalance()
```

---

## Prerequisites

- **Node.js >= 18**
- **Coinbase account** with Advanced Trade enabled (available to all retail users at coinbase.com/advanced-trade)
- **Coinbase CDP API key** with "Trade" and "View" permissions
- SOL and USD balances on Coinbase

---

## API Key Setup

1. Go to **https://portal.cdp.coinbase.com/**
2. Sign in with your Coinbase account
3. Navigate to **API Keys** → **Create API Key**
4. Select scope: **Advanced Trade** → enable **Trade** and **View** permissions
5. Complete 2FA verification
6. **Download the JSON credentials file** — store it securely, the private key cannot be retrieved again

The downloaded JSON file contains:
```json
{
  "name": "organizations/<org-id>/apiKeys/<key-id>",
  "privateKey": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
}
```

Set these as:
- `COINBASE_API_KEY_NAME` → the `name` field
- `COINBASE_API_KEY_PRIVATE_KEY` → the `privateKey` field

> **PEM newline gotcha:** The private key contains literal `\n` characters in the JSON file. When copying into a `.env` file (a single line), keep them as the two-character sequence `\n` — the bot unescapes them on load. If using `COINBASE_API_KEY_PEM_FILE` instead, write the key to a real file with actual newlines.

**Minimum required permissions:** Trade + View. Do NOT grant Transfer permissions — the bot only places orders, it never moves funds off-platform.

---

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `COINBASE_API_KEY_NAME` | *(required)* | CDP API key name (`organizations/...`) |
| `COINBASE_API_KEY_PRIVATE_KEY` | *(required)* | PEM EC private key inline (see note above) |
| `COINBASE_API_KEY_PEM_FILE` | — | Path to PEM file (alternative to the env var) |
| `REBALANCE_THRESHOLD_BPS` | `100` | Min drift before rebalancing (100 = 1%) |
| `MAX_SLIPPAGE_BPS` | `100` | Post-fill slippage warning threshold (100 = 1%) |
| `MIN_PORTFOLIO_VALUE_USD` | `50` | Skip if total portfolio < this |
| `MIN_TRADE_SIZE_USD` | `5` | Skip if trade amount < this |
| `POLL_INTERVAL_SECONDS` | `300` | How often to check drift (5 minutes) |
| `MIN_REBALANCE_INTERVAL_SECONDS` | `7200` | Minimum gap between rebalances (2 hours) |
| `DRY_RUN` | `false` | Set `true` to simulate without placing orders |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `TRADE_HISTORY_PATH` | `./data/trade_history.json` | Trade log location |

---

## Running

### Pre-flight check (run this first)

```bash
npm install
npm run build
npm run setup-check
```

Validates API keys, confirms SOL and USD accounts are accessible, checks the SOL-USD market, and verifies candle data availability.

### Dry-run (no real orders)

```bash
DRY_RUN=true node dist/index.js --once
```

Logs what the bot *would* do without placing any orders. Use this to verify setup before going live.

### Single check (one-shot)

```bash
node dist/index.js --once
```

Runs one rebalance cycle and exits. Used by GitHub Actions cron.

### Continuous loop (local / VPS)

```bash
node dist/index.js
```

Polls every `POLL_INTERVAL_SECONDS` (default 5 minutes). Cooldown state survives restarts because `lastRebalanceTime` is restored from `data/trade_history.json` on startup.

---

## Deployment as a Persistent Service

For continuous mode on a VPS or server, run the bot as a managed process so it restarts automatically on crash or reboot.

### Option A — PM2 (simplest)

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name shannon-cex
pm2 save
pm2 startup   # follow the printed command to enable auto-start on boot
```

Useful commands:
```bash
pm2 logs shannon-cex       # tail logs
pm2 status                 # check process health
pm2 restart shannon-cex    # restart after config change
pm2 stop shannon-cex       # stop
```

### Option B — systemd

Create `/etc/systemd/system/shannon-cex.service`:

```ini
[Unit]
Description=Shannon's Demon CEX Bot
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/path/to/shannonfi/cex
EnvironmentFile=/path/to/shannonfi/cex/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable shannon-cex
sudo systemctl start shannon-cex
sudo journalctl -fu shannon-cex   # tail logs
```

### Option C — GitHub Actions (no server required)

See the [GitHub Actions](#github-actions-automated) section below. No server needed — runs in the cloud on a 5-minute cron. Requires the trade history to be persisted between runs for the cooldown guard to work (see note there).

---

## Backtesting

Fetch real Coinbase historical price data and replay the strategy:

```bash
npm run backtest                             # 2025-05-01 to 2026-05-01, $10k capital
npm run backtest -- 2024-01-01 2025-01-01   # custom period
npm run backtest -- 2024-01-01 2025-01-01 25000  # custom period + capital
```

Results print a comparison table and emit full JSON. Compare against `../backtest/HISTORICAL_BENCHMARK_REPORT.md` for cross-validation.

> **Fee note:** The backtest does not deduct Coinbase taker fees (see [Fees and Real Returns](#fees-and-real-returns) below). For an accurate net-return estimate, subtract ~0.4% per rebalance from each trade's filled value.

---

## Fees and Real Returns

Coinbase Advanced Trade charges **taker fees** on market orders (the order type this bot uses). Fee tiers as of 2026:

| 30-day volume | Taker fee |
|---|---|
| < $10k | 0.60% |
| $10k – $50k | 0.40% |
| $50k – $100k | 0.25% |
| > $100k | 0.15% |

Most retail users are in the 0.40–0.60% range. Each rebalance involves one trade, so the effective cost per rebalance is roughly `trade_usd_amount × taker_fee`.

**Practical impact on Shannon's Demon:**
- With 7 rebalances over 12 months (from the historical backtest) and average trade sizes of ~$1–2k on a $10k portfolio, total fees would be roughly $28–$84 at 0.4% — about 0.28–0.84% of capital annually.
- Shannon's Demon alpha (excess return vs. buy-and-hold 50/50) is driven by volatility. In the historical 12-month backtest it was approximately +0.01%, meaning fees matter at smaller portfolio sizes.
- The strategy performs better at higher portfolio values where fees are a smaller percentage of each trade and fee tiers are lower.

The `feeUsd` field in each `TradeRecord` captures the actual fee charged by Coinbase and is included in the `printReport()` output.

---

## GitHub Actions (Automated)

The workflow in `.github/workflows/cex-rebalancer.yml` runs the bot every 5 minutes using `--once` mode.

**Required GitHub Secrets** (Settings → Secrets → Actions):

| Secret | Value |
|---|---|
| `COINBASE_API_KEY_NAME` | `organizations/xxx/apiKeys/yyy` |
| `COINBASE_API_KEY_PRIVATE_KEY` | Full PEM with `\n` as literal two-character sequence |
| `SLACK_WEBHOOK_URL` | *(optional)* Slack webhook for failure alerts |

**GitHub Variables** (Settings → Variables → Actions — not secret, visible in logs):

| Variable | Default |
|---|---|
| `REBALANCE_THRESHOLD_BPS` | `100` |
| `MIN_REBALANCE_INTERVAL_SECONDS` | `7200` |
| `MIN_PORTFOLIO_VALUE_USD` | `50` |
| `MIN_TRADE_SIZE_USD` | `5` |

**First run:** Use `workflow_dispatch` with `dry_run=true` to verify everything works before enabling live trading.

**Cooldown persistence in GitHub Actions:**
Each workflow run starts with a fresh filesystem. The bot reads `lastRebalanceTime` from `data/trade_history.json` on startup, but that file is not automatically carried over between runs — it's uploaded as an artifact but not downloaded at the start of the next run.

**Consequence:** In GitHub Actions, `MIN_REBALANCE_INTERVAL_SECONDS` is not enforced across runs. If drift stays above the threshold, the bot will rebalance on every triggered run.

**To enforce cooldown in GitHub Actions**, either:
1. Add an Actions cache step to restore/save `data/trade_history.json` between runs:
   ```yaml
   - uses: actions/cache@v4
     with:
       path: cex/data/trade_history.json
       key: trade-history-${{ github.repository }}
       restore-keys: trade-history-
   ```
2. Use `MIN_REBALANCE_INTERVAL_SECONDS` at a value that naturally prevents over-trading given how often the underlying condition persists (e.g., set it to `86400` for daily-at-most rebalancing regardless of cron frequency).
3. Switch to a VPS deployment (PM2/systemd) where the history file persists.

---

## Monitoring

**Log files:**
- `logs/combined.log` — all log levels
- `logs/error.log` — errors only

**P&L report:**
```bash
node dist/index.js --report 2>/dev/null  # not yet a flag; use the snippet below
node -e "
const { TradeHistoryService } = require('./dist/tracker/history');
const { PnlService } = require('./dist/tracker/pnl');
const h = new TradeHistoryService('./data/trade_history.json');
new PnlService(h).printReport();
"
```

**Trade history schema** (`data/trade_history.json`):
```jsonc
[
  {
    "id": "uuid",
    "clientOrderId": "uuid",        // idempotency key sent to Coinbase
    "coinbaseOrderId": "string",    // null if order never placed (dry-run / error)
    "timestamp": "ISO 8601",
    "direction": "SELL_SOL | BUY_SOL",
    "usdAmountTarget": 100.00,      // USD the bot intended to trade
    "solAmountFilled": 0.666666,    // SOL actually filled (null if not filled)
    "usdAmountFilled": 99.99,       // USD actually filled (null if not filled)
    "fillPrice": 150.00,            // average fill price
    "feeUsd": 0.40,                 // Coinbase taker fee charged
    "status": "FILLED | DRY_RUN | CANCELLED | FAILED | PENDING",
    "portfolioBefore": { ... },     // Portfolio snapshot before the trade
    "portfolioAfter": { ... },      // Portfolio snapshot after fill (null for dry-run)
    "dryRun": false
  }
]
```

---

## Development

```bash
npm test              # run all tests (vitest)
npm run test:watch    # watch mode
npm run test:coverage # coverage report
npm run typecheck     # tsc --noEmit (zero tolerance for type errors)
npm run build         # compile to dist/
npm run dev           # ts-node src/index.ts (no build step, for local iteration)
```

**Test coverage:**
- `tests/math.test.ts` — 27 tests; parity with `math.rs` verified including `isqrt`
- `tests/auth.test.ts` — 5 tests; JWT payload and header structure
- `tests/portfolio.test.ts` — 3 tests; balance parsing, mid-price, error cases
- `tests/history.test.ts` — 6 tests; persistence, `getLastRebalanceTime()` across statuses
- `tests/rebalancer.test.ts` — 7 tests; all guard conditions including cooldown restoration

**Adding a test:** Tests live in `tests/` and are plain Vitest — no special setup. Import directly from `../src/`. Mock with `vi.fn()`.

---

## Security Checklist

- [ ] Never commit `.env` to version control (`.gitignore` covers `data/`, `logs/`, `.env`)
- [ ] Use GitHub Secrets for CI credentials, not plaintext workflow variables
- [ ] CDP API key permissions: **Trade + View only** — never Transfer
- [ ] Review `data/trade_history.json` periodically for unexpected trades
- [ ] Set `MIN_PORTFOLIO_VALUE_USD` to prevent dust trades
- [ ] Start with `DRY_RUN=true` and verify logs before enabling live trading
- [ ] Use `COINBASE_API_KEY_PEM_FILE` (file mount / Docker secret) rather than the env var in production
- [ ] Rotate API keys periodically or immediately if a key is exposed

---

## Strategy Notes

Shannon's Demon works best in **high-volatility, mean-reverting markets**. It systematically:
- Sells SOL when it outperforms (taking profits)
- Buys SOL when it underperforms (buying the dip)

From the 12-month backtest (`../backtest/HISTORICAL_BENCHMARK_REPORT.md`):
- 7 rebalances over 12 months (approximately one every 2 months)
- Outperforms buy-and-hold 50/50 in volatile conditions
- Dramatically reduces maximum drawdown versus 100% SOL exposure
- Underperforms in strongly trending markets (pure bull or bear runs without volatility)

The CEX bot defaults to a 1% drift threshold and 2-hour minimum interval between rebalances. The on-chain vault uses ~432,000 Solana slots (~2 days) between rebalances. The CEX bot is more responsive but the cooldown prevents over-trading in choppy price action.
