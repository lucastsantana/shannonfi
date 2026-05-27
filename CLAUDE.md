# Shannon's Demon Architecture & Context

## Overview

This is a **Mercado Bitcoin trading bot** implementing Shannon's Demon, a volatility-harvesting strategy. The bot maintains a 50/50 SOL/BRL allocation and rebalances when drift exceeds a threshold, profiting from mean reversion in volatile markets.

The repo contains **only the CEX bot** — the Solana on-chain vault implementation has been removed entirely.

---

## Repo Structure

```
shannonfi/
├── bot/                          # Complete CEX rebalancer
│   ├── src/
│   │   ├── index.ts              # Entry point; orchestrates rebalance cycle
│   │   ├── config.ts             # Zod schema; loads shannonfi.config.yaml
│   │   ├── math.ts               # Pure functions (ratios, thresholds, trades)
│   │   ├── constants.ts          # Strategy params, Mercado Bitcoin endpoints
│   │   ├── adapters/
│   │   │   ├── types.ts          # ExchangeAdapter interface
│   │   │   └── mercadobitcoin/   # OAuth2 client, order execution, polling
│   │   └── core/
│   │       ├── rebalancer.ts     # Decision logic & trade execution
│   │       └── tracker/
│   │           ├── tax.ts        # Brazilian tax event tracking (Lei 9.250/1995)
│   │           ├── cost-basis.ts # AVCO for capital gains
│   │           └── history.ts    # Trade history persistence
│   ├── tests/                    # 65+ unit tests (vitest)
│   ├── data/                     # Persistent local state
│   │   ├── trade_history.json    # All rebalance trades
│   │   ├── cost_basis.json       # AVCO tracking
│   │   ├── tax_events.json       # Tax-reportable events
│   │   └── portfolio_snapshots.json
│   ├── README.md                 # Full bot setup & tuning guide
│   ├── shannonfi.config.yaml.example
│   ├── start.sh                  # Wrapper: loads creds from GNOME Keyring
│   ├── package.json
│   └── .github/workflows/rebalancer.yml
│
├── backtest/                     # Historical analysis (Python)
│   ├── shannon_backtest_real.py  # Real MB price data
│   ├── shannon_backtest_coingecko.py
│   ├── shannon_full_history.py
│   ├── README.md                 # Backtest guide
│   └── *.json, *.md              # Results & reports
│
├── README.md                     # Quick start + deployment
├── CLAUDE.md                     # This file
├── package.json                  # Minimal (Node 20 TS setup)
└── .gitignore

Deleted (won't exist):
- programs/    (Anchor smart contract)
- app/         (Solana keeper service)
- Anchor.toml, Cargo.toml, Cargo.lock
- PRICING_GUIDE.md (Solana deployment costs)
- tsconfig.json (root, orphaned)
```

---

## Core Rebalance Cycle

**File:** `bot/src/index.ts`

```
1. Load config (exchange: 'mercadobitcoin' only)
2. Poll loop (every 15 min or pollIntervalSeconds)
   a. Get SOL price from MB (1 API call, cached per cycle)
   b. Compute portfolio ratio
   c. Check rebalance threshold (cached daily volatility → adaptive)
   d. Check cooldown (min time between rebalances)
   e. Get balances (SOL value + BRL balance)
   f. Execute trade if needed
   g. Record trade + tax event
   h. Sleep for next cycle
3. On signal/SIGTERM: flush state & exit
```

**Lazy Evaluation:** Only calls APIs/fetch state if previous checks passed. Price check happens first (cheapest); if threshold not triggered, we skip balances/trade entirely.

---

## Key Modules

### `config.ts`
- **Zod schema** validates `shannonfi.config.yaml`
- **Single exchange:** `z.literal('mercadobitcoin')`
- **Fields:** MB client ID/secret, rebalance threshold, slippage max, dry-run flag, tax settings
- **Loads from:** `--config` arg or default `./shannonfi.config.yaml`

### `math.ts`
Pure functions (no side effects):
- `computeSolRatioBps()` — SOL allocation as basis points
- `computeDeviationBps()` — distance from 50% target
- `shouldRebalance()` — drift > threshold?
- `computeRebalanceTrade()` — BRL amount & direction (BUY_SOL or SELL_SOL)
- `brlToSol()` — convert BRL to SOL quantity, floored at 8 decimals
- `computeAdaptiveThresholdBps()` — MAD × multiplier, clamped to [50, 500] BPS
- `isSlippageAcceptable()` — fill price within tolerance?

### `ExchangeAdapter` Interface
**File:** `adapters/types.ts`

```typescript
interface ExchangeAdapter {
  getPrice(): Promise<number>;  // SOL/BRL
  getPortfolio(knownPrice?: number): Promise<Portfolio>;
  executeTrade(trade: TradeRequest): Promise<ExecutedTrade>;
  getCandles(limit: number): Promise<Candle[]>;
}
```

Only implementation: `adapters/mercadobitcoin/adapter.ts`

### Mercado Bitcoin Adapter
**Files:**
- `adapter.ts` — Main interface impl, OAuth token refresh, dry-run logic
- `client.ts` — HTTP client with bearer token & error handling
- `endpoints.ts` — REST API calls (price, balances, place/get orders)

**OAuth Flow:** Client credentials → access token (cached 59 min) → requests

**Order Execution:**
1. Place market order (SOL→BRL or BRL→SOL)
2. Poll order status every 3s, max 10 attempts (30s total)
3. Return executed trade with fill price & fee
4. Per-attempt try-catch: transient 400s don't abort, only final retry throws

### Tax Tracker
**File:** `core/tracker/tax.ts`

**Brazilian Law:** Lei 9.250/1995 Art. 21
- SELL proceeds ≤ R$35,000/month → **exempt** from capital gains tax
- SELL proceeds > R$35,000/month → taxable; **payment by last business day of following month** (skips weekends & BR holidays)
- BUY trades → no tax event (cost basis only)

**TaxService:**
- Appends events to `tax_events.json`
- `buildTaxEvent()` computes exemption status + deadline
- `getMonthlySalesBrl()` sums SELL volume for a month (YYYYMM)
- `computePaymentDeadline()` finds next business day (handles `BR_HOLIDAYS`)

### Cost Basis Tracker
**File:** `core/tracker/cost-basis.ts`

**AVCO (Average Cost):**
- Every BUY: update weighted average cost
- Every SELL: use current average, record realized gain for tax
- Persisted in `cost_basis.json` (key: "SOL")

### History & Persistence
**Files:**
- `core/tracker/history.ts` — writes trades to `trade_history.json`
- `cooldown.ts` — tracks last rebalance time
- `volatility.ts` — caches daily MAD (computed once/day from 30-day candle history)

---

## Configuration

**File:** `bot/shannonfi.config.yaml`

```yaml
exchange: mercadobitcoin

mercadobitcoin:
  clientId: "PLACEHOLDER"       # from GNOME Keyring
  clientSecret: "PLACEHOLDER"   # from GNOME Keyring

rebalanceThresholdBps: 100      # 1% drift default
maxSlippageBps: 100             # 1% fill tolerance
minPortfolioValueBrl: 200       # Skip if < R$200 balance
minTradeSizeBrl: 20             # Skip tiny trades

useAdaptiveThreshold: true      # Use volatility-based threshold
thresholdVolatilityMultiplier: 1.5
volatilityWindowDays: 30

neverExceedExemptionLimit: false  # Enforce Lei 9.250 R$35k monthly limit
dryRun: false                     # Simulation mode (no real orders)
logLevel: info

tradeHistoryPath: ./data/trade_history.json
costBasisPath: ./data/cost_basis.json
taxEventsPath: ./data/tax_events.json
portfolioSnapshotsPath: ./data/portfolio_snapshots.json
```

**Via Environment:**
- `DRY_RUN=true node dist/index.js --once` — test without orders
- `--config <path>` — custom config file
- `--once` — run single cycle then exit (vs. continuous polling)

---

## Credentials Management

### Local (PM2)

Uses **GNOME Keyring** (`secret-tool`):
```bash
secret-tool store service mercadobitcoin key clientId <ID>
secret-tool store service mercadobitcoin key clientSecret <SECRET>
```

**`start.sh`:** Reads keyring, injects into config YAML, passes to bot.

**Why not directly in config?** Never commit secrets. Keyring is encrypted, survives restarts, and is WSL2/Linux standard.

### GitHub Actions (Scheduled)

Secrets stored in GitHub repo settings:
- `MB_CLIENT_ID`
- `MB_CLIENT_SECRET`
- `SLACK_WEBHOOK_URL` (optional)

Workflow injects them into `shannonfi.config.yaml` at runtime.

---

## Testing

**File:** `bot/tests/`, ~65 unit tests (vitest)

**Test Categories:**
- `math.test.ts` — ratio, threshold, trade calc
- `config.test.ts` — schema validation
- `tax.test.ts` — exemption logic, deadlines
- `cost-basis.test.ts` — AVCO tracking
- `history.test.ts` — trade persistence
- `adapter.test.ts` — mocked MB API responses

**Run:**
```bash
cd bot
npm test                    # vitest
npm run build               # tsc
npm run setup-check         # validate MB credentials
```

---

## Volatility-Adaptive Threshold

**Concept:** Rebalance more aggressively in volatile markets, less in quiet ones.

**Computation:**
1. Fetch 30 days of SOL/BRL candles from MB (free public endpoint)
2. Compute **MAD** (Mean Absolute Daily Return): avg(|daily % change|)
3. Compute threshold = round(MAD × 10,000 × multiplier)
4. Clamp to [50, 500] BPS (0.5% floor, 5% ceiling)
5. Cache per calendar day → no re-fetch until next day

**Example:**
- High volatility (MAD 2%): threshold = 2% × 1.5 = 3%
- Low volatility (MAD 0.3%): threshold = 0.3% × 1.5 = 0.45% → clamped to 50 BPS (0.5%)

---

## Deployment Modes

### 1. Local PM2
- Run on your machine (macOS, Linux, WSL2)
- Credentials from GNOME Keyring
- Data files stay local (`.gitignore`d)
- Manual restart on failure (or PM2 auto-restart)

### 2. GitHub Actions
- Runs every 15 minutes on schedule
- Credentials from GitHub Secrets
- Caches data files between runs
- Slack notifications on failure

### 3. Backtest (Python, offline)
- `shannon_backtest_real.py` — uses public MB candle API
- No OAuth needed, no live trading
- Validates strategy parameters before deploying

---

## Known Limitations & Quirks

1. **Order Fill Transience:** Polling order status from MB can return transient 400 errors. Fixed with per-attempt try-catch; only re-throws on final retry.

2. **Cost Basis Orphaning:** If bot crashes after order executes but before recording, trade is orphaned. Mitigated by `recover-orders.ts` helper (lists known trades, guides manual repair).

3. **Tax Threshold Boundary:** `neverExceedExemptionLimit: true` will skip a SELL if it would push monthly total over R$35,000. This may leave you with 51% SOL allocation; next cycle will rebalance when threshold permits.

4. **API Rate Limit:** MB allows 60 req/60s per token. Bot uses ~1 req/poll cycle; 15-min schedule = 4 req/h, well within limits.

5. **Slippage on Market Orders:** Real market orders fill at slightly worse prices than displayed price. `maxSlippageBps` is checked post-fill; if exceeded, trade is recorded but flagged as risky in logs.

---

## Troubleshooting Checklist

| Symptom | Check |
|---------|-------|
| 401 Unauthorized | Credentials expired? Revoke/regenerate on MB, update keyring |
| 400 Bad Request | Order status poll error? Logs show attempt count; usually transient |
| Threshold not triggering | Is volatility very low? Check `volatilityWindowDays` and `thresholdVolatilityMultiplier` |
| Trade recorded as pending | Bot crashed during polling? Run `recover-orders.ts` to inspect |
| Tax events empty | No SELL trades yet? Tax events only on SELL_SOL direction |
| GitHub Actions timeout | Single cycle > 4 min? Increase `timeout-minutes` in workflow |

---

## Future Tuning

- **Rebalance Threshold:** Lower = more frequent trades, higher fees. Default 1% is reasonable; try 0.5–2% range.
- **Volatility Multiplier:** Higher = wait for more volatility before rebalancing. Default 1.5 balances responsiveness & cost.
- **Cooldown Interval:** `minRebalanceIntervalSeconds` prevents too-frequent rebalances. Default 7,200s (2h) is conservative.
- **Portfolio Min Size:** `minPortfolioValueBrl` skips rebalance if portfolio too small for meaningful fees/slippage. Raise if testing on tiny account.

---

## References

- **Strategy:** [Shannon's Demon (Wikipedia)](https://en.wikipedia.org/wiki/Entropy_and_second_law_of_thermodynamics)
- **Exchange API:** [Mercado Bitcoin REST v4](https://www.mercadobitcoin.com.br)
- **Brazilian Tax:** Lei 9.250/1995 Art. 21 (domestic crypto trading exemption)
- **Backtest Results:** See `backtest/README.md` and `backtest/HISTORICAL_BENCHMARK_REPORT.md`
- **Deployment:** See `bot/README.md` for full setup guide

---

**Last Updated:** 2026-05-26
