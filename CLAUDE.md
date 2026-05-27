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
│   │           ├── db.ts         # SQLite singleton, schema migrations, getDb()
│   │           ├── tax.ts        # Brazilian tax event tracking (Lei 9.250/1995)
│   │           ├── cost-basis.ts # AVCO for capital gains
│   │           └── history.ts    # Trade history & snapshot persistence
│   ├── tests/                    # 65+ unit tests (vitest)
│   ├── data/                     # Persistent local state
│   │   ├── shannonfi.db          # Primary SQLite store (trades, snapshots, tax, cost basis)
│   │   ├── shannonfi.db-shm      # WAL shared memory index (auto-managed by SQLite)
│   │   ├── shannonfi.db-wal      # WAL journal (auto-managed by SQLite)
│   │   ├── trade_history.json    # Rolling 15-day JSON backup of trades
│   │   ├── cost_basis.json       # JSON backup of current AVCO state
│   │   ├── tax_events.json       # Rolling 15-day JSON backup of tax events
│   │   └── portfolio_snapshots.json  # Rolling 15-day JSON backup of daily snapshots
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
- `core/tracker/db.ts` — SQLite singleton (`getDb()`), schema migrations, WAL + FK pragmas
- `core/tracker/history.ts` — writes trades and snapshots to SQLite; dual-writes rolling JSON backup
- `cooldown.ts` — tracks last rebalance time
- `volatility.ts` — caches daily MAD (computed once/day from 30-day candle history)

**Primary store:** SQLite (`shannonfi.db`) via `better-sqlite3`. JSON files are a rolling 15-day human-readable backup; SQLite holds the authoritative full history.

---

## Database Architecture

**File:** `bot/src/core/tracker/db.ts`

The bot's primary datastore is a SQLite database (`bot/data/shannonfi.db`) managed by `better-sqlite3`. All three tracker services (`TradeHistoryService`, `CostBasisService`, `TaxService`) obtain a shared connection through the `getDb()` singleton.

### Singleton & Initialization

```typescript
getDb(dbPath?: string): Database.Database
```

- Called once at startup; subsequent calls return the same instance (matched by path).
- If `dbPath` differs from the active instance (e.g., in tests), the old connection is closed and a new one is opened.
- The `data/` directory is created automatically (`mkdirSync recursive`) on first run.
- Accepts `:memory:` for in-memory test databases (skips directory creation).

**Pragmas set on every open:**

| Pragma | Value | Effect |
|--------|-------|--------|
| `journal_mode` | `WAL` | Write-Ahead Logging — readers don't block writers; produces `.db-shm` and `.db-wal` companion files |
| `foreign_keys` | `ON` | Enforces referential integrity (`tax_events.trade_id → trades.id`) |

**Schema creation** (`runMigrations`) runs on every open using `CREATE TABLE IF NOT EXISTS` — idempotent and safe to call on an already-initialized database.

---

### Tables

#### `trades`

Every rebalance (real or dry-run) is a single row with 31 columns capturing the full before/after portfolio state at the moment of execution.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID assigned before order placement |
| `client_order_id` | TEXT | Client-side order ID sent to MB |
| `exchange_order_id` | TEXT | MB's order ID (null until filled) |
| `exchange` | TEXT | Default `'mercadobitcoin'` |
| `timestamp` | TEXT | ISO 8601 execution time |
| `direction` | TEXT | `'BUY_SOL'` or `'SELL_SOL'` |
| `brl_amount_target` | REAL | BRL amount computed by `computeRebalanceTrade()` before order |
| `sol_amount_filled` | REAL | Actual SOL quantity exchanged |
| `brl_amount_filled` | REAL | Actual BRL quantity exchanged |
| `fill_price` | REAL | Execution price (BRL/SOL) |
| `fee_brl` | REAL | MB taker fee |
| `status` | TEXT | `FILLED` / `DRY_RUN` / `PENDING` / `FAILED` |
| `dry_run` | INTEGER | Boolean `0`/`1` |
| `realized_gain_brl` | REAL | SELL only: gross proceeds − AVCO cost basis |
| `trade_date_brt` | TEXT | `YYYY-MM-DD` in Brasília timezone |
| `before_sol_balance` | REAL | SOL holdings before trade |
| `before_brl_balance` | REAL | BRL cash before trade |
| `before_sol_price` | REAL | SOL/BRL spot price before trade |
| `before_sol_value` | REAL | `before_sol_balance × before_sol_price` |
| `before_total_value` | REAL | `before_sol_value + before_brl_balance` |
| `before_sol_ratio_bps` | INTEGER | SOL weight in BPS (0–10,000) before trade |
| `before_deviation_bps` | INTEGER | `|before_sol_ratio_bps − 5,000|` |
| `before_timestamp` | TEXT | ISO 8601 time of before-snapshot |
| `after_sol_balance` | REAL | SOL holdings after fill (null if pending/failed) |
| `after_brl_balance` | REAL | BRL cash after fill |
| `after_sol_price` | REAL | SOL/BRL price at fill confirmation |
| `after_sol_value` | REAL | `after_sol_balance × after_sol_price` |
| `after_total_value` | REAL | `after_sol_value + after_brl_balance` |
| `after_sol_ratio_bps` | INTEGER | SOL weight post-trade |
| `after_deviation_bps` | INTEGER | Residual deviation post-trade |
| `after_timestamp` | TEXT | ISO 8601 fill confirmation time |

**Indexes:** `idx_trades_date (trade_date_brt)`, `idx_trades_status (status)`

---

#### `portfolio_snapshots`

One row per calendar day (BRT). The primary key is `date_brt`, so `INSERT OR REPLACE` updates the row in-place if the bot runs multiple cycles on the same day.

| Column | Type | Notes |
|--------|------|-------|
| `date_brt` | TEXT PK | `YYYY-MM-DD` in Brasília timezone |
| `timestamp` | TEXT | ISO 8601 snapshot time |
| `total_value_brl` | REAL | SOL value + BRL balance |
| `sol_balance` | REAL | SOL holdings |
| `brl_balance` | REAL | BRL balance |
| `sol_price` | REAL | SOL/BRL price |
| `sol_ratio_bps` | INTEGER | SOL weight in BPS |
| `effective_threshold_bps` | INTEGER | Adaptive or static threshold active that day |
| `rebalanced_today` | INTEGER | `1` if at least one trade executed today |
| `exchange` | TEXT | Default `'mercadobitcoin'` |

**Index:** `idx_snapshots_date (date_brt)`

---

#### `tax_events`

One row per trade. Foreign key links back to `trades(id)`. Tracks Brazilian capital-gains exemption status under Lei 9.250/1995 Art. 21.

| Column | Type | Notes |
|--------|------|-------|
| `trade_id` | TEXT PK → `trades(id)` | One-to-one with trade record |
| `trade_date_brt` | TEXT | `YYYY-MM-DD` |
| `month_brt` | TEXT | `YYYY-MM` — used for monthly aggregation queries |
| `direction` | TEXT | `'BUY_SOL'` or `'SELL_SOL'` |
| `traded_volume_brl` | REAL | Gross SELL proceeds in BRL (0 for BUY) |
| `gross_proceeds_brl` | REAL | Same as `traded_volume_brl` |
| `cost_basis_brl` | REAL | AVCO cost of SOL sold (0 for BUY) |
| `realized_gain_brl` | REAL | `gross_proceeds − cost_basis` (0 for BUY) |
| `cum_monthly_sales_brl` | REAL | Running SELL proceeds this month, including this trade |
| `cum_monthly_gain_brl` | REAL | Running realized gain this month |
| `exempt` | INTEGER | `1` if `cum_monthly_sales_brl ≤ R$35,000` |
| `payment_deadline` | TEXT | Last BR business day of the following month; null if exempt |
| `exchange` | TEXT | Default `'mercadobitcoin'` |

**Index:** `idx_tax_month (month_brt)`

---

#### `cost_basis`

Single-row table (one row per asset; currently only `'SOL'`). Stores the running AVCO state used by the cost-basis tracker.

| Column | Type | Notes |
|--------|------|-------|
| `asset` | TEXT PK | Currently only `'SOL'` |
| `average_cost_brl` | REAL | Weighted average BRL cost per SOL |
| `total_sol` | REAL | Total SOL in the tracked position |
| `last_updated` | TEXT | ISO 8601 timestamp of last BUY or SELL |

Initialized on every startup with `INSERT OR IGNORE INTO cost_basis (asset) VALUES ('SOL')`, so the row is always present even on a fresh database.

---

### Dual-Write Strategy

All three tracker services write to SQLite as the primary store, then append to rolling JSON files as a human-readable backup:

| Service | SQLite table(s) | JSON file(s) | JSON retention |
|---------|----------------|--------------|----------------|
| `TradeHistoryService` | `trades`, `portfolio_snapshots` | `trade_history.json`, `portfolio_snapshots.json` | 15 days (configurable via `jsonRetentionDays`) |
| `CostBasisService` | `cost_basis` | `cost_basis.json` | Full history (small file) |
| `TaxService` | `tax_events` | `tax_events.json` | 15 days |

JSON files are a failsafe and audit trail. If `shannonfi.db` is lost or corrupted, the last 15 days of state can be reconstructed from the JSON backups. Records older than the retention window exist only in SQLite.

---

### Test Isolation

Tests pass `:memory:` as `dbPath`. `closeDb()` / `resetDb()` drop the singleton so each test suite starts from a clean schema. The singleton tracks `lastPath` and automatically closes the previous connection when the path changes, so test teardown is explicit rather than leaky.

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

## Weight Drift Trigger: Mathematical Derivation

### 1. Setup

Define the portfolio at any moment after the last rebalance:

| Symbol | Meaning |
|--------|---------|
| `V_s` | SOL value in BRL (`sol_balance × sol_price`) |
| `V_b` | BRL cash balance |
| `V = V_s + V_b` | Total portfolio value |
| `w = V_s / V` | SOL weight (fraction, 0–1) |
| `w* = 0.5` | Target weight (50/50) |
| `δ = \|w − w*\|` | Absolute deviation from target |
| `τ = threshold_bps / 10,000` | Rebalance threshold as a fraction |

**Rebalance trigger fires when:** `δ > τ`

In integer basis-point arithmetic (as implemented in `math.ts`):
```
solRatioBps  = round(V_s / V × 10,000)
deviationBps = |solRatioBps − 5,000|
trigger      ← deviationBps > thresholdBps
```

---

### 2. How Price Change Maps to Weight Drift

Starting from a freshly rebalanced portfolio (`w = 0.5`, `V_s = V_b = V/2`), suppose SOL price changes by factor `f > 0`:

```
V_s' = (V/2) × f
V_b' = V/2                 (BRL nominal value is unchanged)
V'   = V(f + 1)/2

w' = V_s' / V' = f / (f + 1)
```

Deviation from target:
```
δ(f) = |w' − 0.5| = |f/(f+1) − 1/2| = |f − 1| / (2(f + 1))
```

When `f > 1` (SOL up), SOL becomes overweight. When `f < 1` (SOL down), SOL becomes underweight. The deviation is symmetric in the sense that the same absolute price return produces nearly the same drift in either direction.

---

### 3. Critical Price Move That Triggers the Threshold

Set `δ(f*) = τ` and solve for the triggering price factor `f*`:

**Case SOL up (`f > 1`):**
```
(f − 1) / (2(f + 1)) = τ
f − 1 = 2τf + 2τ
f(1 − 2τ) = 1 + 2τ
f* = (1 + 2τ) / (1 − 2τ)

Price return:  r* = f* − 1 = 4τ / (1 − 2τ)
```

**Case SOL down (`f < 1`):**
```
(1 − f) / (2(f + 1)) = τ
1 − f = 2τf + 2τ
1 − 2τ = f(1 + 2τ)
f* = (1 − 2τ) / (1 + 2τ)

Price drop:  1 − f* = 4τ / (1 + 2τ)
```

For small `τ` (τ ≪ 0.5), both converge to `≈ 4τ`. The trigger is nearly symmetric around the last rebalance price.

**Price move required to trigger, by threshold:**

| threshold_bps | τ | SOL must rise by | SOL must fall by |
|:---:|:---:|:---:|:---:|
| 50 | 0.005 | 2.02% | 1.98% |
| 100 | 0.01 | 4.08% | 3.92% |
| 200 | 0.02 | 8.33% | 7.69% |
| 300 | 0.03 | 12.89% | 11.32% |
| 500 | 0.05 | 22.22% | 18.18% |

At the default 100 BPS threshold, rebalancing fires when SOL moves approximately **±4%** from the price at the last rebalance.

---

### 4. Rebalance Trade Size

When the trigger fires, `computeRebalanceTrade()` solves for the BRL amount that exactly restores `w = 0.5`:

```
target = V / 2

SELL_SOL (w > 0.5):  brlAmount = V_s − target = V × (w − 0.5) = V × δ
BUY_SOL  (w < 0.5):  brlAmount = target − V_s = V × (0.5 − w) = V × δ
```

Both cases: **trade size = total portfolio value × drift from target (as a fraction).**

**Example** (threshold 100 BPS, triggered at w = 0.51):
```
V = R$10,000   V_s = R$5,100   V_b = R$4,900
δ = 0.51 − 0.50 = 0.01
brlAmount = R$10,000 × 0.01 = R$100    direction = SELL_SOL
```

After execution, `V_s ≈ target = R$5,000`, restoring exact 50/50.

---

### 5. Shannon's Demon: Why Rebalancing Extracts Return

Consider a complete oscillation starting from a 50/50 portfolio at price `P`:

**Step 1 — SOL rises by factor `f` (new price `fP`):**
```
V_s = (V/2)×f    V_b = V/2    V' = V(f+1)/2
Rebalance: each side = V(f+1)/4
```

**Step 2 — SOL falls back by factor `1/f` (price returns to `P`):**
```
V_s = V(f+1)/4 × (1/f) = V(1 + 1/f)/4
V_b = V(f+1)/4
Final V = V(f+1)/4 × (1 + 1/f) + V(f+1)/4
        = V(f+1)(2f+1) / (4f)
```

**Without rebalancing:** SOL returns to its start price → final `V` = original `V` (zero net return).

**Excess return from rebalancing:**
```
Gain = V(f+1)(2f+1)/(4f) − V
     = V × [2f² − f + 1] / (4f) − V/... (simplifying)
```

Substituting `f = 1 + r` (price return `r`) and expanding to leading order for small `r`:
```
Gain ≈ V × r² / 4
```

The per-cycle gain is **quadratic in the price move** — larger oscillations yield disproportionately more profit. This is the volatility premium Shannon's Demon systematically harvests.

**Concrete example** (`f = 2`, SOL doubles then halves):
```
Start:        SOL = R$5,000   BRL = R$5,000   total = R$10,000
After ×2:     SOL = R$10,000  BRL = R$5,000   total = R$15,000
Rebalanced:   SOL = R$7,500   BRL = R$7,500
After ÷2:     SOL = R$3,750   BRL = R$7,500   total = R$11,250
Gain = +R$1,250 (+12.5%) vs. buy-and-hold (0%)
```

---

### 6. Volatility-Adaptive Threshold Derivation

The bot sets `τ` proportional to recent realized daily volatility to avoid triggering on noise in calm markets while still catching meaningful moves in volatile ones.

**Step 1 — Compute Mean Absolute Daily Return (MAD):**
```
closes = [P_0, P_1, ..., P_{n-1}]       # n closing prices (oldest first)
r_i    = |P_i − P_{i-1}| / P_{i-1}     # absolute daily return for day i

MAD = (1/(n−1)) × Σ_{i=1}^{n-1} r_i    # mean over n−1 daily moves
```
(`computeMeanAbsoluteDailyReturn()` in `math.ts`, default `n = 31` giving 30 daily returns)

**Step 2 — Convert to threshold basis points:**
```
raw_bps       = round(MAD × 10,000 × multiplier)
threshold_bps = clamp(raw_bps, min=50, max=500)
```
(`computeAdaptiveThresholdBps()` in `math.ts`, default `multiplier = 1.5`)

**Examples with multiplier = 1.5:**

| Market regime | MAD | raw_bps | threshold_bps | SOL trigger move |
|---|:---:|:---:|:---:|:---:|
| Calm (stablecoin-like) | 0.3% | 45 | **50** (floor) | ±2.0% |
| Typical crypto | 1.5% | 225 | **225** | ±9.5% |
| Volatile | 2.0% | 300 | **300** | ±12.9% |
| Extreme (≥3.3%) | ≥3.3% | ≥500 | **500** (ceiling) | ±26.7% |

**Why proportional to MAD?**
The volatility premium per rebalance cycle scales as `~(price_swing)²`. Tying the threshold to typical daily moves means the bot requires `≈ multiplier × 2` standard moves to accumulate triggering drift (e.g., at multiplier 1.5: roughly 3 typical daily moves). This filters high-frequency mean-reverting noise while still capturing genuine volatility swings.

**Why the [50, 500] BPS clamp?**
- **Floor 50 BPS:** Below 0.5% drift, market-order spreads and MB taker fees consume the expected volatility premium. 50 BPS is the practical fee-adjusted minimum.
- **Ceiling 500 BPS:** In extreme regimes the formula could produce thresholds > 5%, preventing any rebalancing entirely. 500 BPS caps the maximum drift tolerance.

**Cache behaviour:** `VolatilityService` stores the computed threshold for the current UTC calendar day. Subsequent calls within the same day return the cached value at zero API cost; a fresh 30-day candle fetch fires only once per day.

---

### 7. Pre-Check Optimisation (Price-Only Drift Estimate)

Before fetching account balances (an authenticated API call), the rebalancer estimates current drift from the price change alone:

```
priceRatio   = currentPrice / lastTrade.portfolioAfter.solPrice
estSolValue  = lastTrade.portfolioAfter.solValueBrl × priceRatio
estTotal     = estSolValue + lastTrade.portfolioAfter.brlBalance
estWeight    = estSolValue / estTotal    # = f/(f+1) from §2
```

If `|estWeight − 0.5| ≤ τ`, the balance fetch is skipped for this cycle. The estimate is exact when no external deposits or withdrawals have occurred since the last trade. In practice, drift is driven almost entirely by price, so the estimate is accurate and eliminates the balance API call on the majority of cycles.

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

**Last Updated:** 2026-05-27
