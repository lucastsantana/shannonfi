# Shannon's Demon Architecture & Context

## Overview

This is a **multi-exchange, multi-instance trading bot** implementing Shannon's Demon, a volatility-harvesting strategy. Each instance maintains a 50/50 base-asset/BRL allocation for one symbol on one exchange, and rebalances when drift exceeds a threshold, profiting from mean reversion in volatile markets.

The repo contains **only the CEX bot** — the Solana on-chain vault implementation has been removed entirely.

**Exchanges:** Mercado Bitcoin and Coinbase, sharing an `ExchangeAdapter` interface (see `adapters/types.ts`). Coinbase has no BRL-quoted trading pairs — its adapter converts BRL<->USD at the boundary using the daily BACEN PTAX rate (treating USDC as 1:1 with USD; USDC, not USD, is the quote currency it actually trades), so every other layer still operates on plain BRL values. See `docs/coinbase-adapter-plan.md`. Binance was removed entirely (adapter code, config schema, credentials, docs) — its only real instance, `btc-binance`, was decommissioned and never replaced; there is no remaining Binance code path anywhere in the repo.

**Instances:** Each instance is one `(exchange, symbol)` pair driven by its own config file under `bot/configs/`, with its own SQLite database and JSON backups under `bot/data/<instance>/`. Instances run independently — there is no shared global config or shared database. The *active* symbol for an instance is resolved from its database (`current_symbol`, seeded from the YAML default on first run), not hardcoded — this is what asset rotation (see `docs/dynamic-asset-rotation-plan.md`) updates without a restart.

**Naming convention:** `{exchange}-{strategy}-{n}`, e.g. `coinbase-shannon-1`, with `coinbase-shannon-2` etc. for additional parallel instances on the same exchange. This deliberately excludes the symbol — since dynamic asset rotation means an instance's traded symbol can change at runtime, naming it after a point-in-time symbol would go stale. `hype-mb` is a pre-convention name kept as-is: it already has real accumulated trade/tax history and GitHub Actions artifact/release continuity tied to that exact name, so renaming it isn't worth the risk. `btc-binance` (a real, now-decommissioned Binance instance) was removed entirely, not renamed — Binance is no longer in active use.

| Instance | Exchange | Symbol | Config | Deployment |
|---|---|---|---|---|
| `hype-mb` | Mercado Bitcoin | HYPE-BRL | `bot/configs/hype-mb.yaml` | GitHub Actions only (rebalancer, scan, dashboard) — local PM2 stopped 2026-08-02, see below |
| `coinbase-shannon-1` | Coinbase | BTC-USDC (bootstraps/rotates via scanner) | `bot/configs/coinbase-shannon-1.yaml` (git-tracked, real config; `.yaml.template` remains as the scaffold) | **Deprecated/stopped.** Ran real (non-dry-run) trades on local PM2 from 2026-06-24 until its local PM2 process was taken down; never mirrored to GitHub Actions. Config, data (`bot/data/coinbase-shannon-1/`), and the Coinbase adapter itself are all kept intact — only this instance's active trading is deprecated, not the exchange integration. |

`hype-mb` is the only instance actively running anywhere (GitHub Actions). `coinbase-shannon-1` is deprecated and not running on either PM2 or GitHub Actions. All four workflows are matrix-based and ready to reactivate a future Coinbase instance on (just uncomment its entry) — none currently run anything beyond `hype-mb`.

**`hype-mb` dual-writer incident (2026-08-02):** `hype-mb` used to run on both local PM2 and GitHub Actions simultaneously. This was a bug, not a supported mode: each side polled the same live MB account against its own independent SQLite file (local disk vs. GH Actions artifact), each with its own `mb_last_synced_deposit_id`/`mb_last_synced_withdrawal_id` checkpoint and `capital_flows` ledger, with zero synchronization between them — exactly the risk `rebalancer.yml`'s own header comment warns about. This caused a real R$40 PIX deposit (landed 2026-07-31) to go undetected by capital-flow auto-detection (see "Capital-flow auto-detection" under the Mercado Bitcoin Adapter section) on the GH Actions side, inflating `nav_per_share`. Local PM2 was stopped for `hype-mb` and its `ecosystem.config.cjs` entry removed (see comment there) — GitHub Actions is now the single authoritative runner. Do not re-enable local PM2 for `hype-mb` without first disabling (or otherwise reconciling with) its GitHub Actions matrix entry.

---

## Repo Structure

```
shannonfi/
├── bot/                          # Complete CEX rebalancer (multi-exchange, multi-instance)
│   ├── src/
│   │   ├── index.ts              # Entry point; orchestrates rebalance cycle
│   │   ├── config.ts             # Zod discriminated union (mercadobitcoin | coinbase); loads --config path
│   │   ├── math.ts               # Pure functions (ratios, thresholds, trades) — asset-agnostic ("base")
│   │   ├── constants.ts          # Strategy params, exchange endpoints
│   │   ├── adapters/
│   │   │   ├── types.ts          # ExchangeAdapter interface
│   │   │   ├── mercadobitcoin/   # OAuth2 client, order execution, polling
│   │   │   └── coinbase/         # CDP-key JWT-signed client; converts BRL<->USD at the boundary (FxRateService)
│   │   ├── publishers/           # Everything that ships output somewhere external
│   │   │   ├── telegram.ts       # Telegram Bot API client (messages, buttons)
│   │   │   ├── daily-digest.ts   # Daily portfolio summary → Telegram, sent once its 00:30-00:35 BRT window is hit
│   │   │   ├── scan-reporter.ts  # Formats scanner results → Telegram
│   │   │   └── dashboard.ts      # Renders retro HTML dashboard from SQLite (CLI + GitHub Pages)
│   │   ├── scanner/              # Cross-pair volatility scanner (candidate-asset ranking)
│   │   │   ├── scan.ts           # CLI entry (`npm run scan`)
│   │   │   ├── scanner.ts        # Ranking logic
│   │   │   └── types.ts
│   │   ├── scripts/              # One-off / maintenance CLIs
│   │   │   ├── setup-check.ts        # Validates exchange credentials (mercadobitcoin or coinbase)
│   │   │   ├── liquidate.ts          # Emergency: sell entire base position to BRL
│   │   │   ├── reconcile-orders.ts   # Rebuild trade history from exchange order history (MB only)
│   │   │   ├── recover-orders.ts     # Diagnostic: lists known trades for manual repair
│   │   │   └── migrate-json-to-db.ts # One-time JSON→SQLite migration (legacy DBs)
│   │   └── core/
│   │       ├── keyring.ts        # Credential loading from GNOME Keyring
│   │       ├── rebalancer.ts     # Decision logic & trade execution
│   │       └── tracker/
│   │           ├── db.ts         # SQLite singleton, schema migrations, getDb()
│   │           ├── tax.ts        # Brazilian tax event tracking (Lei 9.250/1995)
│   │           ├── costbasis.ts  # AVCO for capital gains
│   │           ├── history.ts    # Trade history & snapshot persistence
│   │           ├── volatility.ts # Adaptive threshold (cached daily MAD)
│   │           ├── pnl.ts        # Realized/unrealized P&L helpers
│   │           ├── metrics.ts    # Track-record metrics (returns, drawdown, etc.)
│   │           └── logger.ts
│   ├── configs/                  # One YAML per instance — naming: {exchange}-{strategy}-{n}
│   │   ├── hype-mb.yaml          # HYPE-BRL on Mercado Bitcoin (live: GitHub Actions only; pre-convention name)
│   │   ├── coinbase-shannon-1.yaml            # BTC-USDC on Coinbase (deprecated/stopped — kept for its trade/tax history)
│   │   └── coinbase-shannon-1.yaml.template   # Scaffold for a new Coinbase instance
│   ├── tests/                    # vitest unit tests
│   ├── data/                     # Persistent local state, gitignored
│   │   └── <instance>/           # e.g. hype-mb/, coinbase-shannon-1/ — one dir per instance, fully isolated
│   │       ├── shannonfi.db          # Primary SQLite store (trades, snapshots, tax, cost basis)
│   │       ├── shannonfi.db-shm/-wal # WAL companion files (auto-managed by SQLite)
│   │       ├── trade_history.json    # Rolling 15-day JSON backup of trades
│   │       ├── cost_basis.json       # JSON backup of current AVCO state
│   │       ├── tax_events.json       # Rolling 15-day JSON backup of tax events
│   │       ├── portfolio_snapshots.json  # Rolling 15-day JSON backup of daily snapshots
│   │       └── dashboard.html        # Generated by publishers/dashboard.ts
│   ├── README.md                 # Full bot setup & tuning guide
│   ├── ecosystem.config.cjs      # PM2: no active `apps` entries currently — hype-mb is GitHub-Actions-only and coinbase-shannon-1 is deprecated/stopped, see Deployment Modes
│   ├── start-instance.sh         # Wrapper: loads creds from GNOME Keyring, launches one instance
│   ├── package.json
│   └── .github/workflows/ → see .github/workflows/ below (top-level, not under bot/)
│
├── reporting/                    # Manual/offline: monthly Markdown + investor PDF report generator
│   └── src/{monthly-report,pdf-report,html-report,claude-commentary,strategy-deck}.ts
│       # pdf-report.ts renders the dashboard's dark theme (shared via bot/src/publishers/theme.ts)
│       # to PDF with Playwright; commentary comes from Claude (claude-commentary.ts), falling back
│       # to the rule-based generateCommentary() in report-builder.ts on any API failure.
│       # Run by hand; not wired into any workflow.
│
├── backtest/                     # Historical analysis (Python), offline, manual
│   ├── shannon_backtest_real.py  # Real exchange price data
│   ├── shannon_backtest_coingecko.py
│   ├── shannon_full_history.py
│   ├── shannon_historical_analysis.py
│   ├── shannon_since_inception.py
│   ├── generate_charts.py        # PNG charts for reporting/strategy-deck
│   ├── README.md                 # Backtest guide
│   └── *.json, *.md              # Results & reports
│
├── .github/workflows/             # rebalancer.yml, scan.yml, dashboard.yml, monthly-db-backup.yml
│                                   # All four currently target the hype-mb instance only
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
- switch-asset.sh, bot/shannonfi.config.yaml(.example) — removed; predated per-instance configs
- bot/src/adapters/binance/ — removed along with the `binance` config schema variant, keyring
  credential loading, and every dispatch branch; its only real instance (`btc-binance`) was
  decommissioned and never replaced (see "Exchanges" above)
```

---

## Core Rebalance Cycle

**File:** `bot/src/index.ts`

```
1. Load config for one instance (--config path; exchange + symbol fixed by that file)
2. Poll loop (every 15 min or pollIntervalSeconds)
   a. Get base-asset price from the exchange (1 API call, cached per cycle)
   b. Compute portfolio ratio
   c. Check rebalance threshold (cached daily volatility → adaptive)
   d. Check cooldown (min time since last rebalance, tracked in-memory on the RebalancerBot instance)
   e. Get balances (base-asset value + BRL balance)
   f. Execute trade if needed
   g. Record trade + tax event
   h. Sleep for next cycle
3. On signal/SIGTERM: flush state & exit
```

**Lazy Evaluation:** Only calls APIs/fetch state if previous checks passed. Price check happens first (cheapest); if threshold not triggered, we skip balances/trade entirely.

---

## Key Modules

### `config.ts`
- **Zod discriminated union** on `exchange`: `mercadobitcoin` | `coinbase` — each variant has its own credential fields
- **Fields:** exchange credentials, rebalance threshold, slippage max, dry-run flag, tax settings, `dbPath` (per-instance)
- **Loads from:** `--config <path>` (required in practice — points at one file under `bot/configs/`)

### `math.ts`
Pure functions (no side effects), asset-agnostic ("base" = whatever symbol the instance trades):
- `computeBaseRatioBps()` — base-asset allocation as basis points
- `computeDeviationBps()` — distance from 50% target
- `shouldRebalance()` — drift > threshold?
- `computeRebalanceTrade()` — BRL amount & direction (`BUY_BASE` or `SELL_BASE`)
- `brlToBase()` — convert BRL to base-asset quantity, floored at 8 decimals
- `computeMeanAbsoluteDailyReturn()` / `computeAdaptiveThresholdBps()` — MAD × multiplier, clamped to [50, 500] BPS
- `isSlippageAcceptable()` — fill price within tolerance?

### `ExchangeAdapter` Interface
**File:** `adapters/types.ts`

```typescript
interface ExchangeAdapter {
  getPrice(): Promise<number>;  // base-asset/BRL
  getPortfolio(knownPrice?: number): Promise<Portfolio>;
  executeTrade(trade: TradeRequest): Promise<ExecutedTrade>;
  getCandles(limit: number): Promise<Candle[]>;
}
```

Two implementations, selected by `config.exchange` in `bot/src/index.ts`:
- `adapters/mercadobitcoin/adapter.ts`
- `adapters/coinbase/adapter.ts`

### Mercado Bitcoin Adapter
**Files:**
- `adapter.ts` — Main interface impl, OAuth token refresh, dry-run logic
- `client.ts` — HTTP client with bearer token & error handling
- `endpoints.ts` — REST API calls (price, balances, place/get orders)

**OAuth Flow:** Client credentials → access token (cached 59 min) → requests

**Order Execution:**
1. Place market order (base→BRL or BRL→base)
2. Poll order status every 3s, max 10 attempts (30s total)
3. Return executed trade with fill price & fee
4. Per-attempt try-catch: transient 400s don't abort, only final retry throws

**Capital-flow auto-detection:** `adapter.ts` also exposes `listFiatDeposits()`/`listWithdrawals()` — NOT on the `ExchangeAdapter` interface (same "concrete-adapter-only" pattern as `getCandlesWithVolume()`/`getTickersForSymbols()`, which are scanner-specific). These wrap MB's real wallet API (`GET .../wallet/fiat/BRL/deposits`, `GET .../wallet/BRL/withdraw` — confirmed against MB's actual OpenAPI spec, not just the docs page) and list every BRL deposit/withdrawal on the account, however it was made (PIX transfer, MB's own app — not just ones the API itself initiated). `core/capital-flow-sync.ts`'s `syncMbCapitalFlows()` polls both every cycle from `RebalancerBot.checkAndRebalance()` (gated on `config.exchange === 'mercadobitcoin'`, and only there — no equivalent exists for Coinbase), tracks two checkpoints in `config` (`mb_last_synced_deposit_id`, `mb_last_synced_withdrawal_id`), and auto-calls `ShareLedgerService.recordCapitalFlow()` for any new `CREDITED` deposit or `status: 2` (done) withdrawal — so a PIX top-up or a withdrawal made directly on MB's app gets reflected in NAV/share accounting without a manual `record-flow` CLI call. A sync failure is caught and logged, never aborts the cycle (see `RebalancerBot.syncMbCapitalFlowsIfApplicable()`).

### Coinbase Adapter
**Files:**
- `adapter.ts` — Main interface impl, BRL<->USD conversion at the boundary, dry-run logic
- `client.ts` — HTTP client, signs every request with a freshly-generated JWT (see `jwt.ts`)
- `jwt.ts` — CDP JWT generation (ES256/EdDSA per key type, ~120s expiry, one JWT per request — see `COINBASE_JWT_EXPIRY_SECONDS`)
- `endpoints.ts` — REST API calls (Advanced Trade: price, balances, place/get orders, candles)

Same `ExchangeAdapter` contract as Mercado Bitcoin; the rebalancer, tax tracker, and cost-basis tracker are exchange-agnostic and work unmodified against either adapter. Coinbase has no BRL-quoted pairs — every product this adapter trades is USDC-quoted (e.g. `BTC-USDC`); it converts BRL<->USD at the boundary via the daily BACEN PTAX rate (`FxRateService`), treating USDC as 1:1 with USD, so the rest of the engine sees plain BRL values (see "Exchanges" above and `docs/coinbase-adapter-plan.md`). Note: `scripts/reconcile-orders.ts` is currently Mercado Bitcoin–only (hard-codes `MbClient`/`MbEndpoints`) — there is no Coinbase equivalent yet.

### Publishers (`bot/src/publishers/`)
Everything that ships output to somewhere external to the bot, mirroring the `adapters/` pattern (one concern per file, no forced shared interface since the four publishers don't share a natural call signature):
- `telegram.ts` — Telegram Bot API client (messages, interactive buttons)
- `daily-digest.ts` — Builds and sends a daily portfolio summary via `telegram.ts`; called every cycle (local PM2's poll loop and each GitHub Actions `--once` run alike), but `sendDailyDigestIfScheduled()` only actually sends when the wall clock is within 00:30–00:35 BRT. For `hype-mb`, `rebalancer.yml` has an extra `30 3 * * *` (03:30 UTC = 00:30 BRT) cron tick specifically so a run lands in that window — see the comment in `rebalancer.yml`; without it, an hourly-only `:00` cron never would
- `scan-reporter.ts` — Formats scanner output and sends it via `telegram.ts`
- `dashboard.ts` — Reads the SQLite DB, renders the retro HTML dashboard; dual-purpose as a library and CLI (`npm run dashboard -- --config <path>`), invoked by `dashboard.yml` to publish to GitHub Pages. Resolves `current_symbol` from the DB (same as `index.ts`) before fetching a live price — an instance that has rotated (see asset rotation below) trades a different symbol than its YAML default, and fetching the YAML symbol's price would compare the wrong asset entirely. `fetchCurrentPrice()` and the client-side 30s live-refresh script are both exchange-aware: Mercado Bitcoin's public ticker API is queried directly; Coinbase has no public endpoint for its actual USDC-quoted pairs (`api.exchange.coinbase.com` only lists USD pairs, and the "BASE-USD" substitution is deliberate — see the comment in `fetchCurrentPrice()`), so its USD price is PTAX-converted via `FxRateService` server-side, with that PTAX rate baked into the page as a constant for the client-side refresh (browser-side BACEN fetches would likely hit CORS).

### Scanner (`bot/src/scanner/`)
Cross-pair volatility scanner — ranks candidate symbols on an exchange by recent volatility, trend direction, and liquidity to help pick what to trade next. `scan.ts` is the CLI entry (`npm run scan`). Nothing currently runs it on a schedule: `scan.yml`'s scheduled trigger is disabled (`workflow_dispatch`-only) since `hype-mb` is deliberately kept single-asset on HYPE-BRL with no rotation wanted (its every-scan Telegram approve/reject push was undesired, not just the rotation itself) and `coinbase-shannon-1`'s matrix entry is commented out since that instance is deprecated/stopped; the local daily cron scripts that used to run it for each instance (`bot/scan-mb-daily.sh`, `bot/scan-coinbase-daily.sh`) were removed for the same reason — `scan-coinbase-daily.sh` in particular had an active crontab entry still firing daily for the already-deprecated `coinbase-shannon-1` instance, found and removed alongside the scripts. Each candidate's score is `MAD × (1 + rollingReturn) × liquidityWeight`; candidates with a clearly negative trend (`computeNormalizedTrendSlope()` in `math.ts`, an OLS regression slope normalized by mean price) are filtered out entirely — only sideways-or-up candidates qualify — and `liquidityWeight` (0..1, saturating at `liquidityFullWeightBrl`) dampens thin markets beyond the hard `minVolumeBrl` floor.

For an instance with `bootstrapViaScan: true` (e.g. `coinbase-shannon-1`'s config, though that instance is currently deprecated/stopped — see Instances table), `RebalancerBot` triggers a scan itself on its very first cycle instead of trading its YAML-default `symbol` immediately. With `autonomousWeeklyRotation: true` also set, there is **no Telegram approval step at all** for that instance: `checkAndRunAutonomousRotationDecision()` (`core/rebalancer.ts`) picks the first asset immediately on bootstrap, then re-evaluates once a week (right after midnight Sunday→Monday BRT) and switches only if a new top candidate beats the current asset's score by `autonomousRotationMinMarginPct` — inserting an already-`APPROVED` `pending_rotation` row that the existing (Telegram-approval-agnostic) execution path then runs the same cycle. `hype-mb` keeps the original manual Telegram approve/reject flow (`scan-reporter.ts`'s buttons) — autonomous mode is opt-in per instance. See "`config`, `scans`, `pending_rotation` — asset rotation" below and `docs/dynamic-asset-rotation-plan.md`, "Autonomous weekly rotation".

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

### Fund-Share (NAV-per-share) Ledger
**File:** `core/tracker/shares.ts` (`ShareLedgerService`)

Lets an instance's `total_value_brl` grow or shrink from external BRL deposits/withdrawals without those flows being misread as trading performance — the problem otherwise afflicting every return/CAGR/drawdown/Sharpe/benchmark calculation in `metrics.ts`, `pnl.ts`, `dashboard.ts`, and `reporting/report-builder.ts`, all of which derive "return" from raw `total_value_brl` deltas. Single-owner design (no per-investor ledger) — one share count per instance:

- Every `PortfolioSnapshot` (written by `RebalancerBot.persistSnapshot()` every poll cycle) carries `sharesOutstanding`/`navPerShare` alongside `totalValueBrl`. `navPerShare = totalValueBrl / sharesOutstanding` moves purely with trading performance between flows.
- **Deposit/withdrawal:** `npm run record-flow -- --config <path> --type deposit|withdrawal --brl <amount>` (script: `scripts/record-capital-flow.ts`). Issues/redeems shares at the nav/share prevailing **just before** the flow, so nav/share itself is unaffected by the flow's size — a standard unitization technique. **Run the script before actually moving the money** (it reads the live pre-flow balance as the strike price); pass `--already-moved` if the transfer already happened and the live balance already reflects it. `hype-mb` also auto-records flows via `capital-flow-sync.ts` (see "Mercado Bitcoin Adapter" below) — the CLI there is a fallback, not the primary path. Every other instance, including `coinbase-shannon-1`, is CLI-only by deliberate choice (Coinbase has no usable deposit/withdrawal-listing API — see `docs/capital-flow-recording-guide.md` for why, and for full step-by-step usage instructions for both scenarios).
- **Bootstrap:** a genuinely fresh instance (no snapshot history, zero value) seeds nav/share at an arbitrary 1.00 baseline on its first-ever snapshot (only the ratio to later nav/share values — i.e. returns — is ever meaningful).
- **Backfill:** an *existing* instance's pre-feature snapshot history isn't left blank — `backfillShares()` (`db.ts`, called on every startup, idempotent via `WHERE nav_per_share IS NULL`) anchors the instance at a fixed `DEFAULT_INITIAL_SHARES` (100, `constants.ts`) shares as of the first snapshot with positive `total_value_brl`, and rescales every other un-backfilled row against that same (constant, since no flows existed yet) share count — nav/share = `total_value_brl ÷ 100` throughout the backfilled span. This reproduces the instance's existing `total_value_brl` return shape in nav/share terms rather than discarding its history the moment this feature ships — important for `hype-mb`, which already has ~2 months of real trading history before this feature existed. The first time it runs for an instance (`capital_flows` still empty), it also inserts a genesis `DEPOSIT` row into `capital_flows` for the anchor's `total_value_brl` — the instance's original funding becomes a real ledger entry (100 shares issued at nav/share = anchor value ÷ 100), not just something implicit in the snapshot columns. `ShareLedgerService`'s own live bootstrap (`resolveShareBasis()`) uses the same `DEFAULT_INITIAL_SHARES` convention for the equivalent live case — a fresh instance whose exchange account already held a balance before its first cycle ran.
- `metrics.ts` (`computeMetrics()`) and `pnl.ts` (`printReport()`) compute return/CAGR/drawdown/Sharpe from the `navPerShare` series (filtered to `navPerShare > 0`), not raw `total_value_brl` — a deposit/withdrawal no longer shows up as a performance swing in `--report` output.
- `publishers/dashboard.ts`'s `RETURN`/`NET GAIN` KPIs, the client-side 30s live-refresh script, and the "Shannon's Demon" line in the STRATEGY SCOREBOARD chart/table are all nav/share-based too — the passive 50/50 and all-in benchmarks are unaffected (they're synthetic, price-only, and never experience a flow). `netGain` is `initialTotal × navReturn`, i.e. the flow-adjusted % return re-expressed in BRL scaled to the original starting AUM, not a raw AUM delta. All of it falls back to the pre-fund-share raw `total_value_brl` delta if `nav_per_share` isn't populated yet for that instance (dashboard.ts is a read-only renderer — `backfillShares()` runs as part of the bot's own startup in `index.ts`, not here, so a dashboard generated before the bot's first post-deploy cycle degrades gracefully instead of showing nonsense).
- The dashboard's score bar also has dedicated `SHARE PRICE` (live nav/share, updates every 30s) and `OUTSTANDING SHARES` (static per page load — only changes when a flow is recorded, so regenerate the dashboard after `record-flow` to see the new count) tiles. The TRADE HISTORY table has matching `SHARE PRICE`/`SHARES O/S` reference columns per trade, sourced from `trades.nav_per_share_before`/`shares_outstanding` (see "Database Architecture" → `trades` table) — populated by `RebalancerBot.stampShareState()` on every trade going forward, shown as `—` for trades that predate the feature (not backfilled, unlike `portfolio_snapshots`, since nothing downstream depends on historical trades having it — it's a reference field, not an input to any return/CAGR/Sharpe calculation).
- `reporting/report-builder.ts`'s `monthly.monthlyReturnPct` and `monthly.maxDrawdownPct` (the per-month figures — `cumulative.*` already goes through `MetricsService`, so it inherited the phase-2 fix for free) are nav/share-based with the same total_value_brl fallback. `monthly.startValueBrl`/`endValueBrl` are deliberately left as raw AUM — they're rendered as "Portfolio Start/End", not "Return", so a dollar jump from a deposit next to an unmoved return % is expected and correct, the same AUM-vs-return split used everywhere else in this feature.

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

The bot's primary datastore is a SQLite database (`bot/data/shannonfi.db`) managed by `better-sqlite3`. All tracker services (`TradeHistoryService`, `CostBasisService`, `TaxService`, `ShareLedgerService`) obtain a shared connection through the `getDb()` singleton.

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
| `direction` | TEXT | `'BUY_BASE'` or `'SELL_BASE'` |
| `brl_amount_target` | REAL | BRL amount computed by `computeRebalanceTrade()` before order |
| `base_amount_filled` | REAL | Actual SOL quantity exchanged |
| `brl_amount_filled` | REAL | Actual BRL quantity exchanged |
| `fill_price` | REAL | Execution price (BRL/SOL) |
| `fee_brl` | REAL | MB taker fee |
| `status` | TEXT | `FILLED` / `DRY_RUN` / `PENDING` / `FAILED` |
| `dry_run` | INTEGER | Boolean `0`/`1` |
| `realized_gain_brl` | REAL | SELL only: gross proceeds − AVCO cost basis |
| `trade_date_brt` | TEXT | `YYYY-MM-DD` in Brasília timezone |
| `before_base_balance` | REAL | SOL holdings before trade |
| `before_brl_balance` | REAL | BRL cash before trade |
| `before_base_price` | REAL | SOL/BRL spot price before trade |
| `before_base_value` | REAL | `before_base_balance × before_base_price` |
| `before_total_value` | REAL | `before_base_value + before_brl_balance` |
| `before_base_ratio_bps` | INTEGER | SOL weight in BPS (0–10,000) before trade |
| `before_deviation_bps` | INTEGER | `|before_base_ratio_bps − 5,000|` |
| `before_timestamp` | TEXT | ISO 8601 time of before-snapshot |
| `after_base_balance` | REAL | SOL holdings after fill (null if pending/failed) |
| `after_brl_balance` | REAL | BRL cash after fill |
| `after_base_price` | REAL | SOL/BRL price at fill confirmation |
| `after_base_value` | REAL | `after_base_balance × after_base_price` |
| `after_total_value` | REAL | `after_base_value + after_brl_balance` |
| `after_base_ratio_bps` | INTEGER | SOL weight post-trade |
| `after_deviation_bps` | INTEGER | Residual deviation post-trade |
| `after_timestamp` | TEXT | ISO 8601 fill confirmation time |
| `shares_outstanding` | REAL | Fund-share accounting — shares outstanding at trade time; a trade itself never changes this (only a recorded capital flow does). Nullable, not backfilled for pre-existing trades — see `ShareLedgerService.stampShareState()` in `rebalancer.ts` |
| `nav_per_share_before` | REAL | nav/share computed from `before_total_value` |
| `nav_per_share_after` | REAL | nav/share computed from `after_total_value`; null if `after_total_value` is null |

**Indexes:** `idx_trades_date (trade_date_brt)`, `idx_trades_status (status)`

---

#### `portfolio_snapshots`

One row per calendar day (BRT). The primary key is `date_brt`, so `INSERT OR REPLACE` updates the row in-place if the bot runs multiple cycles on the same day.

| Column | Type | Notes |
|--------|------|-------|
| `date_brt` | TEXT PK | `YYYY-MM-DD` in Brasília timezone |
| `timestamp` | TEXT | ISO 8601 snapshot time |
| `total_value_brl` | REAL | SOL value + BRL balance |
| `base_balance` | REAL | SOL holdings |
| `brl_balance` | REAL | BRL balance |
| `base_price` | REAL | Base-asset/BRL price |
| `base_ratio_bps` | INTEGER | SOL weight in BPS |
| `effective_threshold_bps` | INTEGER | Adaptive or static threshold active that day |
| `rebalanced_today` | INTEGER | `1` if at least one trade executed today |
| `exchange` | TEXT | Default `'mercadobitcoin'` |
| `total_shares_outstanding` | REAL | Fund-share accounting — nullable; `backfillShares()` fills pre-existing rows on next startup, see below |
| `nav_per_share` | REAL | `total_value_brl / total_shares_outstanding` — nullable, same as above |

**Index:** `idx_snapshots_date (date_brt)`

---

#### `tax_events`

One row per trade. Foreign key links back to `trades(id)`. Tracks Brazilian capital-gains exemption status under Lei 9.250/1995 Art. 21.

| Column | Type | Notes |
|--------|------|-------|
| `trade_id` | TEXT PK → `trades(id)` | One-to-one with trade record |
| `trade_date_brt` | TEXT | `YYYY-MM-DD` |
| `month_brt` | TEXT | `YYYY-MM` — used for monthly aggregation queries |
| `direction` | TEXT | `'BUY_BASE'` or `'SELL_BASE'` |
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

#### `capital_flows`

One row per deposit/withdrawal, written by `ShareLedgerService.recordCapitalFlow()` (see "Fund-Share (NAV-per-share) Ledger" above). Three writers: the manual `record-flow` CLI (every instance), `capital-flow-sync.ts`'s automatic polling (`hype-mb`/Mercado Bitcoin only — see "Mercado Bitcoin Adapter"), and `backfillShares()`'s one-time genesis `DEPOSIT` row for an instance's pre-existing history (see "Backfill" above). Both `hype-mb` and `coinbase-shannon-1` have exactly one row (the genesis backfill) as of this writing — no real deposit/withdrawal has happened on either since this feature shipped.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `timestamp` / `date_brt` | TEXT | ISO 8601 / `YYYY-MM-DD` BRT |
| `type` | TEXT | `'DEPOSIT'` or `'WITHDRAWAL'` |
| `brl_amount` | REAL | Flow size |
| `nav_per_share_before` | REAL | Nav/share used to price the shares issued/redeemed |
| `shares_delta` | REAL | Positive for deposit, negative for withdrawal |
| `total_shares_after` | REAL | Running total, avoids recomputation drift |
| `total_value_brl_before` / `total_value_brl_after` | REAL | Portfolio value immediately either side of the flow (audit trail) |
| `exchange` | TEXT | |
| `note` | TEXT | Optional free text |

**Index:** `idx_capital_flows_date (date_brt)`

#### `trades` / `portfolio_snapshots` — `base_asset` column

Both tables also carry a `base_asset TEXT` column (additive migration), recording which asset each row belongs to. Needed because an instance's active symbol can change over time via asset rotation (see `docs/dynamic-asset-rotation-plan.md`) — without this, historical rows would be ambiguous about which asset's price/quantity they're recording. Legacy rows are backfilled with the instance's pre-rotation asset via `backfillBaseAsset()`, called on every startup (no-op once already populated).

#### `config`, `scans`, `pending_rotation` — asset rotation

- `config` — generic key/value store (`getDbConfig`/`setDbConfig` in `db.ts`). `current_symbol` is the DB (not the YAML file) as the source of truth for which symbol an instance is currently trading once rotation is in play. `mb_last_synced_deposit_id`/`mb_last_synced_withdrawal_id` are the capital-flow auto-detection checkpoints (Mercado Bitcoin only — see "Mercado Bitcoin Adapter" above).
- `scans` — one row per daily scanner run, full ranked candidate list as a JSON blob (`scan_data`), plus `status` (`COMPLETED` → `APPROVED` once a human picks a candidate via Telegram).
- `pending_rotation` — one row per rotation request/execution: `from_symbol`, `to_symbol`, `status` (`APPROVED` → `COMPLETED`/`FAILED`), `scan_id`, `liquidation_trade_id`, `reacquisition_trade_id` (links back to the two `trades` rows a rotation produces), `requested_by`.

Full design rationale, the blind spots this surfaced, and what's still manual (approval is always a human tapping a Telegram button — nothing auto-approves) are in `docs/dynamic-asset-rotation-plan.md`.

---

### Dual-Write Strategy

All tracker services write to SQLite as the primary store, then append to rolling JSON files as a human-readable backup:

| Service | SQLite table(s) | JSON file(s) | JSON retention |
|---------|----------------|--------------|----------------|
| `TradeHistoryService` | `trades`, `portfolio_snapshots` | `trade_history.json`, `portfolio_snapshots.json` | 15 days (configurable via `jsonRetentionDays`) |
| `CostBasisService` | `cost_basis` | `cost_basis.json` | Full history (small file) |
| `TaxService` | `tax_events` | `tax_events.json` | 15 days |
| `ShareLedgerService` | `capital_flows` | `capital_flows.json` | 15 days |

JSON files are a failsafe and audit trail. If `shannonfi.db` is lost or corrupted, the last 15 days of state can be reconstructed from the JSON backups. Records older than the retention window exist only in SQLite.

---

### Test Isolation

Tests pass `:memory:` as `dbPath`. `closeDb()` / `resetDb()` drop the singleton so each test suite starts from a clean schema. The singleton tracks `lastPath` and automatically closes the previous connection when the path changes, so test teardown is explicit rather than leaky.

---

## Configuration

**One file per instance**, under `bot/configs/` (e.g. `hype-mb.yaml`). No global/default config — `--config <path>` is required. Credentials are **not** stored in the YAML; they're loaded at runtime from GNOME Keyring (local) or environment variables (GitHub Actions) via `core/keyring.ts`.

```yaml
exchange: mercadobitcoin
symbol: HYPE-BRL

rebalanceThresholdBps: 100      # 1% drift default
maxSlippageBps: 100             # 1% fill tolerance
minPortfolioValueBrl: 10        # Skip if below this BRL balance
minTradeSizeBrl: 1              # Skip tiny trades

useAdaptiveThreshold: true      # Use volatility-based threshold
thresholdVolatilityMultiplier: 1.25
volatilityWindowDays: 30

enableDayTradeSafeguard: true     # Block same-day opposite-direction trades (BRT)
neverExceedExemptionLimit: true   # Enforce Lei 9.250 R$35k monthly limit (mercadobitcoin only)
dryRun: false                     # Simulation mode (no real orders)
logLevel: info

dbPath: ./data/hype-mb/shannonfi.db   # Per-instance SQLite path; JSON backups live alongside it
jsonRetentionDays: 15

telegram:
  chatId: "..."                  # Optional; bot token comes from keyring/env, not config
```

**Via Environment:**
- `DRY_RUN=true node dist/index.js --config <path> --once` — test without orders
- `--config <path>` — required; selects which instance to run
- `--once` — run single cycle then exit (used by GitHub Actions; local PM2 runs the continuous poll loop)

---

## Credentials Management

### Local (PM2)

Uses **GNOME Keyring** (`secret-tool`), loaded directly by `core/keyring.ts` — never written to disk or passed through config files:
```bash
secret-tool store --label="..." service mercadobitcoin key clientId
secret-tool store --label="..." service mercadobitcoin key clientSecret
secret-tool store --label="..." service coinbase key keyName
secret-tool store --label="..." service coinbase key privateKeyPem
secret-tool store --label="..." service telegram key botToken
```

`bot/start-instance.sh <instance-name> [args...]` launches one PM2-managed instance; `ecosystem.config.cjs` (repo root) defines all local instances.

### GitHub Actions (Scheduled)

Secrets stored in GitHub repo settings:
- `MB_CLIENT_ID`, `MB_CLIENT_SECRET`
- `COINBASE_API_KEY_NAME`, `COINBASE_API_KEY_SECRET` (unused today — `hype-mb` is the only instance on GitHub Actions, and it's Mercado Bitcoin; wired into the workflows for whenever a Coinbase instance is mirrored there)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional)

`core/keyring.ts`'s `getTelegramCredentials()` checks `process.env.TELEGRAM_BOT_TOKEN` first, falling back to keyring — so the same code path works in both environments. Each workflow step passes the relevant secrets as env vars (see `.github/workflows/rebalancer.yml`, `scan.yml`).

---

## Testing

**File:** `bot/tests/`, 158 unit tests (vitest)

**Test Categories (partial list):**
- `math.test.ts` — ratio, threshold, trade calc
- `config.test.ts` — schema validation
- `tax.test.ts` — exemption logic, deadlines
- `cost-basis.test.ts` — AVCO tracking
- `history.test.ts` — trade persistence
- `adapter.test.ts` — mocked MB API responses
- `db.test.ts` — schema migrations, `backfillBaseAsset()`, `backfillShares()`
- `shares.test.ts` — `ShareLedgerService` nav/share bootstrap, deposits, withdrawals
- `capital-flow-sync.test.ts` — MB deposit/withdrawal auto-detection, checkpoints, malformed-entry handling
- `metrics.test.ts` / `pnl.test.ts` — nav/share-based return, unaffected by capital flows
- `rebalancer.test.ts` — full cycle logic, including asset rotation

**Run:**
```bash
cd bot
npm test                    # vitest
npm run build               # tsc
npm run setup-check         # validate exchange credentials (mercadobitcoin or coinbase)
```

---

## Weight Drift Trigger: Mathematical Derivation

### 1. Setup

Define the portfolio at any moment after the last rebalance:

| Symbol | Meaning |
|--------|---------|
| `V_s` | Base-asset value in BRL (`base_balance × base_price`); shown here as SOL for illustration |
| `V_b` | BRL cash balance |
| `V = V_s + V_b` | Total portfolio value |
| `w = V_s / V` | SOL weight (fraction, 0–1) |
| `w* = 0.5` | Target weight (50/50) |
| `δ = \|w − w*\|` | Absolute deviation from target |
| `τ = threshold_bps / 10,000` | Rebalance threshold as a fraction |

**Rebalance trigger fires when:** `δ > τ`

In integer basis-point arithmetic (as implemented in `math.ts`'s `computeBaseRatioBps()` / `computeDeviationBps()` / `shouldRebalance()`):
```
baseRatioBps = round(V_s / V × 10,000)
deviationBps = |baseRatioBps − 5,000|
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

SELL_BASE (w > 0.5):  brlAmount = V_s − target = V × (w − 0.5) = V × δ
BUY_BASE  (w < 0.5):  brlAmount = target − V_s = V × (0.5 − w) = V × δ
```

Both cases: **trade size = total portfolio value × drift from target (as a fraction).**

**Example** (threshold 100 BPS, triggered at w = 0.51):
```
V = R$10,000   V_s = R$5,100   V_b = R$4,900
δ = 0.51 − 0.50 = 0.01
brlAmount = R$10,000 × 0.01 = R$100    direction = SELL_BASE
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
- Currently unused: `ecosystem.config.cjs` has no active `apps` entries — `hype-mb` deliberately excludes it (GitHub Actions only) and `coinbase-shannon-1`'s entry was removed when that instance was deprecated. Kept ready for a future local instance.

### 2. GitHub Actions (hype-mb instance only)
- `rebalancer.yml` — hourly (`0 * * * *`), single cycle (`--once`) then exits; plus an extra `30 3 * * *` tick so one run lands in the daily-digest's 00:30–00:35 BRT send window (see `daily-digest.ts` above)
- `scan.yml` — scheduled trigger disabled (`workflow_dispatch`-only); `hype-mb` is kept deliberately single-asset on HYPE-BRL, so the daily volatility scan and its Telegram approve/reject push aren't wanted
- `dashboard.yml` — after each rebalancer run + every 6h fallback; deploys to GitHub Pages
- `monthly-db-backup.yml` — 1st of each month; archives the SQLite DB as a GitHub Release
- Credentials from GitHub Secrets; the SQLite DB persists between runs as a GitHub Actions artifact (`hype-mb-database`), downloaded/re-uploaded each run — see "Database Architecture" → artifact-sharing caveats in git history if debugging data loss
- Telegram notifications on failure (`appleboy/telegram-action`)
- `coinbase-shannon-1` is **not** mirrored to GitHub Actions (deprecated/stopped — see Instances table)

### 3. Backtest (Python, offline)
- `shannon_backtest_real.py` — uses public exchange candle API
- No OAuth needed, no live trading
- Validates strategy parameters before deploying

### 4. Reporting (manual, offline)
- `reporting/` — generates monthly Markdown (`npm run report`) and an investor-facing dark-theme PDF
  (`npm run report:pdf`) against an instance's SQLite DB
- PDF pipeline: `report-builder.ts` assembles a `ReportPayload` → `claude-commentary.ts` asks Claude
  (Anthropic Messages API, model `claude-sonnet-4-6`) to write the executive-summary prose from that
  payload, falling back to the rule-based `generateCommentary()` on any API error or missing
  `ANTHROPIC_API_KEY` → `html-report.ts` renders the dashboard's dark theme (palette/fonts shared via
  `bot/src/publishers/theme.ts`, so the two never drift) as a static HTML document → `pdf-report.ts`
  rasterizes it with Playwright (`page.pdf()`) to `bot/data/reports/<YYYY-MM>.pdf`
- One-time setup: `cd reporting && npm run playwright:install` (downloads the Chromium binary)
- Not wired into any workflow; run by hand. `strategy-deck.ts`/`latex-strategy.ts` (a separate,
  occasional investor pitch-deck PDF, not the monthly cycle) still use LaTeX/Beamer and are untouched

---

## Known Limitations & Quirks

1. **Order Fill Transience:** Polling order status from MB can return transient 400 errors. Fixed with per-attempt try-catch; only re-throws on final retry.

2. **Cost Basis Orphaning:** If bot crashes after order executes but before recording, trade is orphaned. Mitigated by `recover-orders.ts` helper (lists known trades, guides manual repair).

3. **Tax Threshold Boundary:** `neverExceedExemptionLimit: true` will skip a SELL if it would push monthly total over R$35,000. This may leave you with 51% SOL allocation; next cycle will rebalance when threshold permits.

4. **API Rate Limit:** MB allows 60 req/60s per token. Bot uses ~1 req/poll cycle; the GitHub Actions hourly schedule and local 5-min poll interval are both well within limits.

5. **Slippage on Market Orders:** Real market orders fill at slightly worse prices than displayed price. `maxSlippageBps` is checked post-fill; if exceeded, trade is recorded but flagged as risky in logs.

---

## Troubleshooting Checklist

| Symptom | Check |
|---------|-------|
| 401 Unauthorized | Credentials expired? Revoke/regenerate on MB, update keyring |
| 400 Bad Request | Order status poll error? Logs show attempt count; usually transient |
| Threshold not triggering | Is volatility very low? Check `volatilityWindowDays` and `thresholdVolatilityMultiplier` |
| Trade recorded as pending | Bot crashed during polling? Run `recover-orders.ts` to inspect |
| Tax events empty | No SELL trades yet? Tax events only on SELL_BASE direction |
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
- **Backtest Results:** See `backtest/README.md`
- **Deployment:** See root `README.md` for full setup guide

---

**Last Updated:** 2026-08-19
