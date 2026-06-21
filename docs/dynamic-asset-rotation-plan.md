# Dynamic Base-Asset Rotation — Implementation Plan

**Branch:** `feature/dynamic-base-asset-rotation`
**Status:** Implemented (decisions below were confirmed; see "Implementation Notes" at
the end for what was built, one real bug the test suite caught, and what's still
manual/out of scope).

## Context

Today, each bot instance (`hype-mb`, `btc-binance`, ...) is permanently bound to one
`(exchange, symbol)` pair for its entire lifetime — fixed in its YAML config, fixed in
its SQLite DB, fixed in its adapter/service wiring at process startup. The daily
volatility scanner (`bot/src/scanner/`) already ranks candidate symbols and posts the
results to Telegram, but today that's purely informational — a human reads the message
and would have to manually edit a YAML file and redeploy to actually switch assets.

The goal: let **one running instance** (starting with `hype-mb`) rotate which base
asset it trades over time, driven by the daily scanner, with the same 50/50 Shannon's
Demon mechanics applied to whichever asset is currently active — without spinning up a
new instance/config/DB per asset.

## Important discovery: this was already half-built, then deleted

Before designing anything new, I found that **a working version of most of this
already existed** and was removed, apparently as collateral damage during an unrelated
"clean up documentation" commit (`9a4e569`, 2026-06-01) — the same commit that also
wrongly deleted `bot/src/core/benchmarks.ts` (restored earlier this session). Specifically:

- **`bot/src/core/tracker/db.ts` still has the full schema for this feature, unused:**
  a generic `config` key/value table (`getDbConfig`/`setDbConfig`, already exported and
  still called by `bot/src/scanner/scan.ts`), a `scans` table (full scan history, JSON
  blob per scan, already populated daily), and a `pending_rotation` table
  (`from_symbol`, `to_symbol`, `approved_at`, `executed_at`, `status`,
  `execution_error`). None of this needs to be designed — it's live schema, just not
  fully consumed.
- **`bot/src/scanner/scan.ts`** already resolves the active symbol via
  `getDbConfig('current_symbol', config.symbol, dbPath)` (falling back to YAML) and
  seeds it on first run. So "the DB, not the YAML, is the source of truth for the
  active symbol" is already half-true for the scanner path.
- **`bot/src/publishers/scan-reporter.ts`** already has a *complete* Telegram
  approve/reject flow wired to real handlers: `onCandidateSelected` →
  `onConfirmYes`/`onConfirmNo`, and `onConfirmYes` already does
  `INSERT INTO pending_rotation (...) VALUES (..., 'APPROVED')`. This is not a stub —
  it's functioning code.
- **The one broken link:** `sendTelegramReport()` (scan-reporter.ts:108) sends the
  initial scan message as **plain text with no buttons attached** — there's a literal
  comment "*Send message as text (no interactive buttons for now)*". Since nothing
  ever attaches the per-candidate buttons to the *first* message, `onCandidateSelected`
  can never fire, so the whole downstream approve/reject flow is currently dead code.
- **`bot/src/core/rotation-executor.ts`** (deleted, full source recovered from git
  history at `9a4e569~1`) was the consumer that watched `pending_rotation` for
  `APPROVED` rows and executed the liquidation leg: sell 100% of the current base
  asset to BRL, record the trade/tax/cost-basis exactly like a normal trade, call
  `setDbConfig('current_symbol', toSymbol)`, mark the rotation `COMPLETED`, and notify
  Telegram. It deliberately does **not** also execute the acquisition leg — the
  comment block explains the design: once the portfolio is 100% BRL / 0% target asset,
  it's ~100% off the 50/50 target, so the bot's *existing* drift-threshold check will
  fire a `BUY_BASE` into the new asset on its own on the very next cycle. That's a
  genuinely good design and worth keeping.
- This file was never actually wired into `index.ts`'s poll loop (no commit ever adds
  a call site for `checkAndExecutePendingRotation()`), and it imports
  `../notifier/telegram` — the pre-reorg path, since deleted (now `../publishers/telegram`).
  So even before it was deleted, it was unfinished/unintegrated, not a regression.

**Implication for this plan:** this is much closer to "finish and harden a
half-built feature" than "build from scratch." The plan below restores and adapts
`rotation-executor.ts`'s logic (rather than reinventing it), reuses the existing
`config`/`scans`/`pending_rotation` tables as-is, and fixes the one missing wire in
`scan-reporter.ts`. New work is concentrated on the parts that were never actually
attempted: live in-process symbol swapping, and making every other long-lived
per-symbol service (adapter, cost basis, volatility cache) consistent with a
DB-resolved "current symbol" instead of a YAML-frozen one.

## Blind spots in the current implementation (would silently misbehave today)

1. **Every per-symbol service is constructed once at process startup from the static
   YAML `symbol` field and never revisited** (`bot/src/index.ts`): the exchange
   adapter, `CostBasisService`, and (indirectly, via the adapter) `VolatilityService`
   are all built from `config.symbol`/`config.symbol.split('-')[0]`, not from
   `getDbConfig('current_symbol', ...)`. So even with `pending_rotation` populated and
   approved, nothing in the live bot process currently reads it or reacts to it — this
   is the central gap, not a side detail.
2. **`VolatilityService`'s daily threshold cache is keyed by calendar day only**
   (`bot/src/core/tracker/volatility.ts`), not `(day, symbol)`. If a rotation happens
   mid-day, the cached MAD-based threshold — computed from the *old* asset's 30-day
   candles — would incorrectly keep being applied to the *new* asset for the rest of
   that day.
3. **Cooldown/day-trade-guard state is in-memory on `RebalancerBot`**
   (`lastRebalanceTime`, `lastRebalanceDateBRT`, `lastRebalanceDirection`) and is never
   reset on a rotation. Immediately after rotating, the bot should be allowed to
   rebalance into the new asset right away — it shouldn't inherit a cooldown that was
   measuring time since the *old* asset's last trade.
4. **`trades` and `portfolio_snapshots` have no column identifying which asset a row
   belongs to** — confirmed by reading the exact `CREATE TABLE` statements in `db.ts`.
   Only `cost_basis` is asset-keyed (`asset TEXT PRIMARY KEY`). Every historical row
   implicitly assumes "whatever this instance's one fixed asset is," which becomes
   false the moment rotation happens even once.
5. **Two consumers of `basePrice`/`baseAsset` assume one continuous price series for
   the entire instance history** and would produce *wrong, not just missing* numbers
   after a rotation, not just cosmetic issues:
   - `reporting/src/report-builder.ts` — `baseOnlyReturnPct` and
     `baseOnlyCumulativeReturnPct` directly diff `firstSnap.basePrice` vs
     `lastSnap.basePrice` across the whole window. After a rotation this silently
     computes "asset A's price at the start vs. asset B's price at the end" as if it
     were one asset's return.
   - `bot/src/publishers/dashboard.ts` — the "ALL-IN `${baseAsset}`" and 50/50
     buy-and-hold benchmark series (`bhHalfValue`, `bhAllInValue`) multiply a single
     `initialPrice`/`initialHype` quantity through every snapshot's `base_price`,
     which mixes assets across a rotation boundary while the chart legend keeps
     calling it one fixed asset's name.
   - By contrast, `bot/src/core/tracker/metrics.ts` (CAGR/Sharpe/max drawdown) only
     looks at `totalValueBrl`, which stays valid across a rotation — **no fix needed
     there**, worth confirming explicitly so it's not "fixed" unnecessarily.
6. **Tax exemption interacts badly with a forced full-liquidation.** A rotation's
   liquidation leg is a single SELL of the *entire* position, which behaves completely
   differently from the small partial-rebalance SELLs the exemption-cap guard
   (`neverExceedExemptionLimit`) was designed for. If that guard is applied unmodified
   to a rotation liquidation, a large enough position simply could never finish
   rotating in a calendar month with room left under the R$35k exemption, with no
   natural retry mechanism — the rotation would silently stall. This needs an explicit
   policy decision (see Open Questions), not a silent reuse of the existing guard.
7. **`hype-mb` is the only instance mirrored to GitHub Actions**, which runs `--once`
   and exits — a fresh process every hour. If the live PM2 process resolves
   `current_symbol` from the DB but the GitHub Actions workflow path doesn't (or vice
   versa), the two environments could trade *different* assets against the *same*
   shared DB artifact within the same day. Both paths must resolve the active symbol
   the same way (DB-first, YAML-fallback) or this instance's dual-deployment model
   actively works against the feature.
8. **Adapters bake the symbol in at construction** (`MercadoBitcoinAdapter`,
   `BinanceAdapter` both take `symbol` as a constructor argument and use it internally
   for every method) — confirmed there's no per-call symbol override on the
   `ExchangeAdapter` interface. A rotation must construct a *new* adapter instance, not
   mutate an existing one. This is a one-line cost, not a redesign, given the
   constructors are already symbol-parameterized — but it has to be done deliberately
   inside whatever does the live swap.
9. **The scanner's 15-symbol candidate universe is hardcoded** in `scanner.ts`
   (`BTC, ETH, SOL, HYPE, XRP, ADA, DOGE, LINK, LTC, BCH, AVAX, ARB, OP, PEPE, SHIB`).
   Rotating into a symbol outside that list isn't possible via the automated path
   today — worth deciding whether the candidate universe should be config-driven
   per instance (e.g. liquidity/listing constraints differ between MB and Binance).

## Proposed architecture

### 1. Database — additive only, reuse what exists

No table needs to be redesigned. Changes:

- **`trades` and `portfolio_snapshots`: add `base_asset TEXT` (nullable, additive
  `ALTER TABLE ... ADD COLUMN`, following the existing `renameColumnIfExists`-style
  idempotent-migration pattern already in `db.ts`).** Backfill existing rows with the
  instance's current single historical asset (one `UPDATE ... WHERE base_asset IS
  NULL` per instance, run once). All new rows always set it going forward. This is
  what lets the dashboard/report distinguish asset-epochs instead of assuming one
  asset for the whole table.
- **`pending_rotation`: add `scan_id INTEGER REFERENCES scans(id)`,
  `liquidation_trade_id TEXT REFERENCES trades(id)`,
  `reacquisition_trade_id TEXT REFERENCES trades(id)`, `requested_by TEXT NOT NULL
  DEFAULT 'telegram_manual'`.** Keeps a full audit trail: which scan triggered the
  proposal, which specific trade liquidated the old asset, which specific trade
  re-established the new position. `requested_by` future-proofs for an eventual
  fully-automated trigger path without a schema change.
- **`config` (key/value) and `scans`: used as-is, no changes.** `current_symbol` stays
  the single source of truth for "what is this instance trading right now," exactly as
  `scan.ts` already treats it.

### 2. Restore and adapt the rotation executor

Bring back `rotation-executor.ts`'s liquidation logic (recovered from `9a4e569~1`),
adapted to:
- Import from `../publishers/telegram` (current path) instead of the deleted
  `../notifier/telegram`.
- Take a **mutable reference** to (or live inside) `RebalancerBot`, since the
  liquidation must use the *current* adapter/cost-basis/tax services (old asset),
  while the swap afterward must replace them with *new* instances (new asset) inside
  the same long-lived process — not a separate one-shot script.
- Reuse the existing trade/tax/cost-basis recording calls exactly as before (this part
  was already correct).
- Decide explicitly (see Open Questions) how `neverExceedExemptionLimit` applies to
  the liquidation leg, rather than silently inheriting the partial-rebalance guard.

### 3. `RebalancerBot` — add a rotation check + live symbol swap

In `bot/src/core/rebalancer.ts`, add a `checkAndExecuteRotation()` step at the top of
the poll cycle (before the existing price-drift check, since it's cheap — one indexed
`SELECT ... WHERE status = 'APPROVED' LIMIT 1`):
- If an approved rotation is pending: execute the liquidation (current services), then
  **rebuild** `this.adapter`, `this.costBasis`, `this.volatility` for the new symbol,
  and update the mutable `this.config.symbol` field that every `config.symbol.split('-')[0]`
  call site already reads. None of `RebalancerBot`'s constructor-injected fields are
  `readonly`, so this is a reassignment, not a structural change.
- Reset cooldown/day-trade-guard in-memory state (blind spot #3) so the bot can
  rebalance into the new asset immediately.
- Mark `pending_rotation` `COMPLETED`, `setDbConfig('current_symbol', toSymbol)`,
  send the Telegram completion notice (adapted from the recovered
  `notifyRotationComplete`).
- Fall through to the normal rebalance check in the *same* cycle — 100% BRL / 0%
  target asset is far outside any threshold, so the existing `shouldRebalance()` logic
  naturally fires the `BUY_BASE` acquisition leg without new code.

### 4. `index.ts` and `scan.ts` — resolve the active symbol consistently

Both the long-running PM2 process and the `--once` GitHub Actions invocation must
construct their adapter/cost-basis/volatility services from
`getDbConfig('current_symbol', config.symbol, config.dbPath)`, never from
`config.symbol` directly (blind spot #1 and #7). `scan.ts` already does this — bring
`index.ts` in line with the same pattern so a rotation approved via Telegram is picked
up by *every* process that touches this instance's DB, regardless of which one
actually executes the liquidation.

### 5. Fix the one broken wire in `scan-reporter.ts`

`sendTelegramReport()` needs the same per-candidate button list that
`onConfirmNo`'s "back to list" view already builds (lines ~250–255) attached to the
*initial* message, using `sendMessageWithButtons()` instead of `sendMessage()`. This
single change reconnects the already-correct `onCandidateSelected` →
`onConfirmYes`/`onConfirmNo` handlers that currently can never be reached.

### 6. `VolatilityService` cache key

Key the daily threshold cache by `(day, symbol)` instead of `day` alone (blind spot #2)
— smallest possible fix, just widen the cache key.

### 7. Dashboard & reporting — segment by asset-epoch

Once `trades`/`portfolio_snapshots` carry `base_asset`:
- `report-builder.ts`'s `baseOnlyReturnPct`/`baseOnlyCumulativeReturnPct` should only
  diff `basePrice` within a single contiguous `base_asset` run, not across the whole
  window. Decide the cross-rotation framing — e.g. report each asset-epoch's own
  buy-and-hold return separately, rather than trying to force one number across a
  rotation boundary.
- `dashboard.ts`'s benchmark chart needs an explicit "rotation" marker/annotation on
  the date a rotation occurred, and the "ALL-IN `${baseAsset}`" series needs to either
  (a) be redefined as "ALL-IN, rolled forward through every rotation" (a real,
  computable benchmark — what a fully passive momentum-following holder would have
  gotten) or (b) be chopped into per-epoch segments. (a) is more interesting
  analytically and not much extra work given `base_asset` is now on every row.
- `MetricsService` needs no changes (blind spot #5) — explicitly confirmed safe.

## Open questions (need your decision before implementation starts)

1. **Tax policy for the liquidation leg.** Should a rotation's full-position SELL
   always proceed regardless of `neverExceedExemptionLimit` (accepting whatever tax
   event results, clearly surfaced in the tax ledger/Telegram), or should large
   positions be split across multiple calendar months to stay under the R$35k
   exemption (delays the rotation by potentially weeks)? I'd recommend the former as
   the default, with the latter as an opt-in config flag — happy to go the other way
   if you'd rather default to tax-conservative.
2. **Approval model.** Keep the existing manual Telegram approve/reject flow (closest
   to what's already built, and matches this strategy's "Order from Entropy, not
   blind automation" framing), or do you want a fully autonomous path too (e.g.
   auto-approve if the top candidate's score exceeds the current asset's by some
   margin for N consecutive days)? I'd plan for manual-approval-first and leave
   `requested_by` in the schema as the hook for adding autonomous triggers later
   without another migration.
3. **Candidate universe.** Should the scanner's hardcoded 15-symbol list become
   per-instance config (so e.g. `btc-binance` isn't limited to Mercado-Bitcoin-style
   liquidity assumptions), or is the shared hardcoded list fine for now since rotation
   is launching on `hype-mb` only?
4. **Scope: `hype-mb` only, or also build the Binance path?** The recovered
   `rotation-executor.ts` is exchange-agnostic by construction (works through
   `ExchangeAdapter`), so there's no extra design cost either way — just confirming
   whether `btc-binance` should get this too or stay single-asset for now.

## Verification plan (once implementation starts)

- New unit tests for: rotation-cache-key isolation in `VolatilityService`, the
  liquidation→swap→re-acquisition sequence in `RebalancerBot` (mocked adapter,
  asserting the second adapter instance is used post-rotation), and the
  `pending_rotation` state machine (`APPROVED` → `COMPLETED`/`FAILED`).
- Migration test: run the additive `base_asset` column migration against a copy of
  the real `hype-mb` DB, confirm idempotency (matches the existing
  `renameColumnIfExists` test pattern) and correct backfill.
- End-to-end dry run: `DRY_RUN=true`, manually `INSERT` an `APPROVED` row into
  `pending_rotation` against a scratch copy of the `hype-mb` DB, run one `--once`
  cycle, confirm the liquidation trade, the `current_symbol` update, and the
  following cycle's acquisition trade all land correctly — before ever touching the
  real `hype-mb` instance.
- Re-wire and manually exercise the Telegram approve/reject flow end-to-end against a
  test chat before enabling it against the production Telegram chat.

## Implementation Notes (post-build)

All four open questions above were confirmed as the recommended defaults: liquidation
always proceeds in full regardless of the monthly exemption cap; approval stays
manual-only via Telegram (no autonomous auto-approve); the scanner's hardcoded
15-symbol candidate list is unchanged; scope is `hype-mb` only for this pass.

**A real bug was found and fixed via testing, not just a design walkthrough.** The
original plan (and the recovered `rotation-executor.ts` it was based on) assumed that
once a rotation lands the portfolio at 100% BRL / 0% target asset, the *existing*
drift-threshold check would naturally fire a `BUY_BASE` into the new asset on the next
cycle — "no restart required." Writing an actual integration test against a real
in-memory DB caught that this is false: `computeDeviationBps()` in `math.ts` treats
either side being exactly zero as "no drift" (a sensible existing guard for a
brand-new, never-yet-funded instance), which means a rotation's exact zero-base-balance
moment is invisible to the normal rebalance trigger. **`rotation-executor.ts`'s
liquidation-only design was deleted before ever being wired up or tested, so this gap
was never caught.** Fixed by having `RebalancerBot.executeLiquidationAndSwap()`
execute the re-acquisition leg explicitly and immediately (50% of the freed BRL into
the new asset) rather than depending on the generic drift check — both legs of a
rotation are now fully deterministic and self-contained in one method, recorded as two
separate trades (`liquidation_trade_id` / `reacquisition_trade_id` on `pending_rotation`).

**What was built:**
- DB: additive `base_asset` column on `trades`/`portfolio_snapshots`
  (`addColumnIfMissing`, idempotent); `pending_rotation` audit columns
  (`scan_id`, `liquidation_trade_id`, `reacquisition_trade_id`, `requested_by`);
  `backfillBaseAsset()` helper for pre-rotation legacy history.
- `RebalancerBot`: `checkAndExecuteRotation()` runs at the top of every cycle (one
  cheap indexed SELECT on the common no-op case); on an approved rotation, liquidates
  the full old position, swaps `adapter`/`volatility`/`costBasis` to fresh instances
  for the new symbol via an injected `adapterFactory`, mutates `config.symbol` in
  place (every existing `config.symbol.split('-')[0]` call site picks this up for
  free), resets cooldown/day-trade-guard state, executes the re-acquisition leg, and
  notifies Telegram.
- `index.ts` and `scan.ts`: both now resolve `current_symbol` from the DB (seeding
  from YAML on first run) before constructing any per-symbol service, so the local PM2
  process, the hourly GitHub Actions `--once` run, and the scanner never disagree on
  the active symbol. (`scan.ts` previously resolved `activeSymbol` for labeling but
  still built its own adapter from the stale YAML `config.symbol` — fixed as part of
  this same change.)
- `scan-reporter.ts`: `sendTelegramReport()` now attaches the per-candidate buttons
  (`sendMessageWithButtons` instead of `sendMessage`) — the existing
  `onCandidateSelected` → `onConfirmYes`/`onConfirmNo` handler chain was already
  correct but unreachable until this one-line fix.
- `dashboard.ts` / `report-builder.ts`: benchmark/return calculations are now
  asset-epoch aware — `findAssetEpochStart()` (report-builder) and a forward-walking
  re-basing loop (dashboard's chart series) ensure a rotation boundary never diffs or
  multiplies two different assets' prices together. Both are no-ops for an instance
  that has never rotated (verified: regenerating the live `hype-mb` dashboard/report
  produced byte-identical-in-substance output to before this change).
- `VolatilityService` needed no code change — rotation simply constructs a fresh
  instance for the new adapter, which trivially gives it a fresh per-day cache with no
  need for a `(day, symbol)` compound key.

**Verified:** `tsc --noEmit` clean on both `bot/` and `reporting/`; full test suite
70/70 passing (62 pre-existing + 4 new rotation-flow tests in `rebalancer.test.ts` + 4
new migration tests in `db.test.ts`); migration ran live against a copy of the real
`hype-mb.db` and added the new columns without error; dashboard and PDF report both
regenerate correctly against that same real DB. **Not verified:** a live credentialed
`--once` run end-to-end (this sandbox has no GNOME Keyring daemon, so credential
lookup hangs) — the rotation-flow integration test exercises the exact same code path
against real `TradeHistoryService`/`TaxService`/`CostBasisService` instances and a real
SQLite DB, with only the exchange adapters (the actual network boundary) mocked, which
is the most realistic verification possible without live exchange credentials.

**Still manual, by design (per the confirmed answers above):** approving a rotation is
a human action via Telegram buttons — nothing auto-approves. No code currently
*decides* to propose a rotation from scan results; that's the scanner's existing
top-candidate display plus a human's judgment, unchanged by this work.
