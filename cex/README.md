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

The JSON file contains:
```json
{
  "name": "organizations/<org-id>/apiKeys/<key-id>",
  "privateKey": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n"
}
```

Set these as:
- `COINBASE_API_KEY_NAME` → the `name` field
- `COINBASE_API_KEY_PRIVATE_KEY` → the `privateKey` field (replace literal newlines with `\n` if using `.env`)

**Minimum required permissions:** Trade + View. Do NOT grant Transfer permissions — the bot only needs to place orders, not move funds off-platform.

---

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `COINBASE_API_KEY_NAME` | *(required)* | CDP API key name (`organizations/...`) |
| `COINBASE_API_KEY_PRIVATE_KEY` | *(required)* | PEM EC private key (or use `COINBASE_API_KEY_PEM_FILE`) |
| `COINBASE_API_KEY_PEM_FILE` | — | Path to PEM file (alternative to env var) |
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

This validates your API keys, confirms SOL and USD accounts are accessible, checks the SOL-USD market, and verifies candle data availability.

### Dry-run (no real orders)

```bash
DRY_RUN=true node dist/index.js --once
```

Logs what the bot *would* do without placing any orders. Use this to verify setup before going live.

### Single check (one-shot)

```bash
node dist/index.js --once
```

Runs one rebalance cycle and exits. Ideal for cron jobs and GitHub Actions.

### Continuous loop

```bash
node dist/index.js
```

Polls every `POLL_INTERVAL_SECONDS` (default 5 minutes). Run as a background service on a server or VPS.

---

## Backtesting

Fetch real Coinbase historical price data and replay the strategy:

```bash
npm run backtest                            # 2025-05-01 to 2026-05-01, $10k
npm run backtest -- 2024-01-01 2025-01-01  # custom period
npm run backtest -- 2024-01-01 2025-01-01 25000  # custom period + capital
```

Results are printed to the console and output as JSON. Compare against `../backtest/HISTORICAL_BENCHMARK_REPORT.md` for cross-validation.

---

## GitHub Actions (Automated)

The workflow in `.github/workflows/cex-rebalancer.yml` runs the bot every 5 minutes using `--once` mode.

**Required GitHub Secrets** (Settings → Secrets → Actions):

| Secret | Value |
|---|---|
| `COINBASE_API_KEY_NAME` | `organizations/xxx/apiKeys/yyy` |
| `COINBASE_API_KEY_PRIVATE_KEY` | Full PEM with `\n` escaped as literal `\n` |
| `SLACK_WEBHOOK_URL` | *(optional)* Slack webhook for failure alerts |

**GitHub Variables** (Settings → Variables → Actions — not secret):

| Variable | Default |
|---|---|
| `REBALANCE_THRESHOLD_BPS` | `100` |
| `MIN_REBALANCE_INTERVAL_SECONDS` | `7200` |
| `MIN_PORTFOLIO_VALUE_USD` | `50` |
| `MIN_TRADE_SIZE_USD` | `5` |

**First run:** Use `workflow_dispatch` with `dry_run=true` to verify everything works before enabling live trading.

**Trade history:** Each run uploads `data/trade_history.json` as a GitHub Actions artifact (retained 90 days). For persistent accumulation across runs, replace the JSON file store with an external database.

---

## Monitoring

**Log files:**
- `logs/combined.log` — all log levels
- `logs/error.log` — errors only

**P&L report:**
```bash
node -e "
const h = require('./dist/tracker/history');
const p = require('./dist/tracker/pnl');
const history = new h.TradeHistoryService('./data/trade_history.json');
const pnl = new p.PnlService(history);
pnl.printReport();
"
```

---

## Security Checklist

- [ ] Never commit `.env` to version control (`.gitignore` covers it)
- [ ] Use GitHub Secrets for CI credentials, not plaintext workflow vars
- [ ] CDP API key permissions: **Trade + View only** — never Transfer
- [ ] Review `data/trade_history.json` periodically
- [ ] Set `MIN_PORTFOLIO_VALUE_USD` to prevent dust trades
- [ ] Start with `DRY_RUN=true` and verify logs before enabling live trading
- [ ] Use `COINBASE_API_KEY_PEM_FILE` (Docker secret / file mount) instead of env var for production deployments

---

## Strategy Notes

Shannon's Demon works best in **high-volatility, mean-reverting markets**. It systematically:
- Sells SOL when it outperforms (taking profits)
- Buys SOL when it underperforms (buying the dip)

From the 12-month backtest (`../backtest/HISTORICAL_BENCHMARK_REPORT.md`):
- 7 rebalances over 12 months (averaging ~1 per 2 months)
- Outperforms buy-and-hold 50/50 in volatile conditions
- Dramatically reduces maximum drawdown vs 100% SOL exposure
- The strategy underperforms in strongly trending markets (pure bull/bear runs with no volatility)

The CEX bot defaults to a 1% drift threshold and 2-hour minimum interval between rebalances. The on-chain vault uses ~2-day slots (~432,000 slots) between rebalances. The CEX bot is more responsive but the minimum rebalance interval prevents over-trading.
