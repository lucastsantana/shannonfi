# Coinbase Adapter — Implementation Plan

**Branch:** `feature/coinbase-adapter` (branched from `feature/dynamic-base-asset-rotation`)
**Status:** Implemented (USD quote currency, GitHub Actions generalized from day
one — both confirmed). See "Implementation Notes" at the end for what was built,
what's verified vs. not, and what's still required before going live.

## Context

Binance's API blocks GitHub Actions runners with an HTTP 451 ("Restricted Location")
— GitHub-hosted runners run in US Azure datacenters, and Binance.com blocks US-origin
traffic by policy. That's why `btc-binance` today is local-PM2-only and never mirrored
to GitHub Actions (per `CLAUDE.md`). Coinbase is a US-domiciled, US-regulated exchange
— serving US-origin traffic is its core business, not something it blocks — so its API
should work from GitHub Actions runners with no equivalent restriction. That part of
the premise checks out.

**The part that doesn't check out as originally framed:** Coinbase has no BRL trading
pairs. I queried Coinbase's live public products endpoint directly; the full set of
quote currencies across every Coinbase trading pair is `USD, EUR, GBP, BTC, ETH, USDT,
USDC, INR, AUD` — no BRL. Coinbase's Pix integration in Brazil is a funding rail only
(deposit/withdraw BRL via Pix, converted to/from USD by Coinbase), not an order book.
This matters because the bot is BRL-native by design end to end —
`rebalancer.ts`'s own docstring states *"this class never touches USD, FX rates, or
exchange credentials."* You confirmed (over Binance-workaround or other-exchange
alternatives) that you want to proceed with Coinbase quoted in USD or USDC anyway,
accepting the new machinery that requires. This plan is for that path.

## Architectural decision: convert at the adapter boundary, not throughout the engine

There are two ways to make a USD/USDC-quoted exchange work inside a BRL-native engine:

1. **Generalize the engine** — rename every `brl_*` column/field/variable across
   `math.ts`, `costbasis.ts`, `tax.ts`, `history.ts`, `dashboard.ts`,
   `report-builder.ts` to a generic "quote currency," threading a currency code
   through every layer.
2. **Convert at the adapter boundary** — `CoinbaseAdapter` internally converts
   BRL↔USD(C) using a daily official FX rate, so `getPrice()` returns a BRL price,
   `getPortfolio()` returns BRL balances, and `executeTrade()` takes a BRL amount —
   every other layer (math, cost basis, tax, dashboard, reporting) needs **zero
   changes** and keeps working exactly as it does today.

**Recommendation: (2).** It's a fraction of the work, and it's exactly what the
existing architecture already declares as the adapter's job — `rebalancer.ts`'s
docstring isn't just descriptive, it's the design boundary this plan should respect.
The cost is an FX-conversion risk that's worth stating plainly up front (see Risks).

### FX rate source: BACEN PTAX

Brazilian tax law expects foreign-currency transactions to be converted to BRL using
the Central Bank's official PTAX rate for capital-gains reporting purposes — this
isn't just convenient, it's the methodologically correct choice for Lei 9.250
tracking, not only a engineering shortcut. `reporting/src/report-builder.ts` already
fetches BACEN SGS series data (for CDI) via `BenchmarksService`, so the pattern of
hitting `api.bcb.gov.br/dados/serie/...` is already proven in this codebase — a new
`FxRateService` (in `bot/src/core/tracker/`, alongside `VolatilityService`) would
follow the same shape: fetch once per BRT calendar day, cache it (identical pattern to
`VolatilityService`'s daily cache), expose `getUsdBrlRate(): Promise<number>`.

**Needs verification before coding, not assumed:** the exact BACEN SGS series ID for
the PTAX commercial dollar rate, and whether Brazilian tax guidance specifies "compra"
(buy) or "venda" (sell) rate for this direction of conversion — I'm not confident
enough in either to assert them here without checking BACEN's series catalog
directly, and getting this wrong has real tax consequences. Flagged as the first
implementation step, not a footnote.

## Coinbase Advanced Trade API surface (verified against live docs/endpoints)

| Concern | Endpoint | Notes |
|---|---|---|
| Auth | N/A — JWT per request | CDP API keys (not simple key/secret pairs). JWT signed with ES256 (ECDSA) or EdDSA (Ed25519) depending on key type, ~120s expiry, claims include `sub` (key name), `iss: "cdp"`, `uri` (method+path being called), `kid`, `nonce`. Sent as `Authorization: Bearer <jwt>`. Structurally different from MB's OAuth2 client-credentials and Binance's HMAC query-signing — needs a real JWT library (recommend `jose`: supports both ES256 and EdDSA cleanly), not a hand-rolled signer. |
| Price/candles | `GET /api/v3/brokerage/products/{product_id}/candles` | `start`/`end` (Unix), `granularity` (`ONE_DAY`, etc.), max 350 candles/call — same shape as `getCandles(countback, resolution)` already on the `ExchangeAdapter` interface. |
| Balances | `GET /api/v3/brokerage/accounts` | Paginated (`cursor`/`has_next`, limit ≤250); each account has `available_balance: { value, currency }` — maps directly onto `getPortfolio()`. |
| Place order | `POST /api/v3/brokerage/orders` | `order_configuration.market_market_ioc.quote_size` for BUY (spend a quote-currency amount — same shape as MB/Binance's BRL-amount buy), `.base_size` for SELL (sell a base-asset quantity — same shape as the existing `brlToBase()` conversion already used before MB/Binance SELL calls). |
| Order status | `GET /api/v3/brokerage/orders/historical/{order_id}` | `status`, `filled_size`, `average_filled_price`, `total_fees` — same poll-for-fill shape as the MB adapter's `MB_FILL_POLL_INTERVAL_MS`/`MAX_ATTEMPTS` pattern (don't assume synchronous fill the way the Binance adapter does; market orders settling instantly isn't guaranteed here). |

Per-product minimums (`base_min_size`, `quote_min_size`, increment/precision rules)
come from `GET /api/v3/brokerage/products/{product_id}` — same role as the Binance
adapter's cached `LOT_SIZE` step handling (`cachedLotStepSize`).

## New files (mirroring the existing adapter structure exactly)

```
bot/src/adapters/coinbase/
  adapter.ts      # implements ExchangeAdapter, owns FX conversion at the boundary
  client.ts       # JWT generation + signed HTTP client (mirrors MbClient/BinanceClient)
  endpoints.ts    # thin wrappers over the 5 endpoints above (mirrors MbEndpoints/BinanceEndpoints)
```

`adapter.ts`'s `getPrice()`/`getPortfolio()`/`executeTrade()` each multiply or divide
through the cached PTAX rate at the boundary — e.g. `getPrice()` calls the real
`BTC-USD` (or `BTC-USDC`) product candle endpoint, then returns `usdPrice *
ptaxRate` so the rest of the engine sees a "BRL" price exactly like the MB/Binance
adapters already provide.

## Config & credentials

- `config.ts`: add a third branch to the discriminated union —
  `exchange: 'coinbase'`, with a `coinbase: CoinbaseSchema` sub-object (parallel to
  `mercadobitcoin`/`binance`). **The shared `symbol` regex
  (`^[A-Z]+-BRL$`) needs to become exchange-aware** — it's currently hardcoded to
  require a `-BRL` suffix for every exchange, which is correct for MB/Binance but
  wrong for Coinbase. Cleanest fix: move the regex into each per-exchange schema
  branch instead of `CommonConfigSchema`, so Coinbase's branch can accept
  `^[A-Z]+-(USD|USDC)$` instead.
- New config field: `coinbase.quoteCurrency: 'USD' | 'USDC'` (see Open Questions —
  this needs your decision, it changes which Coinbase product IDs get traded).
- `keyring.ts`: new `getCoinbaseCredentials()` returning `{ keyName: string,
  privateKeyPem: string }`, following the existing `getXCredentials()` pattern —
  local via `secret-tool lookup service coinbase key keyName` /
  `key privateKeyPem`, falling back to `COINBASE_API_KEY_NAME` /
  `COINBASE_API_KEY_SECRET` env vars for GitHub Actions (the PEM is multi-line; GitHub
  Secrets handle multi-line values fine, same mechanism already used for the existing
  secrets).
- New dependency: `jose` (JWT signing) in `bot/package.json`.

## Scanner generalization

`bot/src/scanner/scanner.ts` hardcodes its 15-candidate universe as literal
`'BTC-BRL'`/`'ETH-BRL'`/etc. strings (confirmed by reading the file directly), and
comments throughout assume "BRL volume." A Coinbase instance scanning `BTC-USD`-style
pairs needs this list to be quote-currency-aware. Smallest correct fix: derive the
candidate list from a `baseAssets: string[]` constant plus the **active instance's own
quote currency** (`BRL` for MB/Binance instances, `USD`/`USDC` for Coinbase ones)
instead of hardcoding the suffix — `${base}-${quoteCurrency}` — rather than
maintaining two separate hardcoded lists that will drift.

## Rotation compatibility — already works, by construction

The asset-rotation feature just built (`feature/dynamic-base-asset-rotation`) is
adapter-agnostic: `RebalancerBot` takes an `adapterFactory: (symbol: string) =>
ExchangeAdapter` injected from `index.ts`, and `index.ts` already branches on
`config.exchange` to decide which adapter class to build. Adding a third branch for
`'coinbase'` there is the only change needed — once `CoinbaseAdapter` correctly
implements `ExchangeAdapter`, `checkAndExecuteRotation()`, the `pending_rotation`
table, and the Telegram approve/reject flow all work for a Coinbase instance
identically to `hype-mb`, with no Coinbase-specific rotation code required.

## New instance wiring

- `bot/configs/coinbase-<symbol>.yaml` (e.g. `coinbase-btc.yaml`), following the
  existing per-instance config convention.
- `bot/data/coinbase-<symbol>/` for its isolated SQLite DB + JSON backups.
- `ecosystem.config.cjs`: new PM2 entry, same pattern as `btc-binance`.
- GitHub Actions: since the whole point is GH-Actions compatibility, this instance
  *should* get `rebalancer.yml`/`dashboard.yml`/`scan.yml`-equivalent workflows — but
  those three workflows are currently hardcoded to the `hype-mb` instance (per
  `CLAUDE.md`: *"all four currently target the hype-mb instance only"*). Generalizing
  them to take an instance/config-path parameter (a workflow matrix or a reusable
  workflow) is a real piece of scope here, not a copy-paste — otherwise you'd end up
  hand-maintaining near-duplicate YAML per instance.

## Risks worth naming plainly

1. **FX timing mismatch.** The real trade executes against a live USD/BTC price; the
   "BRL price" the bot computes uses a once-daily PTAX rate. Intraday USD/BRL moves
   aren't reflected, so the bot's internal "BRL value" of the position will drift from
   the *true* real-time BRL value between PTAX publications (~1pm BRT). This is the
   tax-correct methodology, but it means the bot's own 50/50 rebalancing decisions are
   made against a slightly-stale BRL view of a USD-denominated position — a new kind
   of basis risk that doesn't exist for the BRL-native MB/Binance instances.
2. **Stablecoin de-peg risk** if `USDC` is chosen over `USD` (small, but real, and
   worth being explicit about since it's a new risk category for this bot).
3. **JWT auth is a new credential shape and a new dependency** (`jose`) — more attack
   surface / operational complexity than the existing OAuth2/HMAC adapters, and a PEM
   private key is less forgiving of copy-paste errors than a plain string secret.
4. **Workflow generalization is real scope**, not incidental — see above.

## Open questions (need your decision before implementation starts)

1. **USD or USDC as the quote currency?** Affects which Coinbase product IDs get
   traded (`BTC-USD` vs `BTC-USDC`), funding mechanics (Pix→BRL→USD is Coinbase's
   built-in path; USDC would mean holding a stablecoin between trades), and adds the
   de-peg risk above if USDC. Recommend USD unless you have a specific reason to want
   USDC (e.g. avoiding fiat-wire mechanics, or fee-tier differences I haven't
   verified).
2. **PTAX rate accounting convention (compra vs. venda)** — I flagged this as needing
   verification rather than asserting an answer. Do you want me to research the
   correct BACEN series/convention as the first implementation step, or do you
   already have a position on this from your accountant?
3. **GitHub Actions from day one, or local-PM2 first?** Given the stated goal is
   specifically GH-Actions compatibility, I'd assume day one, but that means
   generalizing the three hardcoded workflows as part of this same effort rather than
   deferring it — confirming that's in scope now, not a later follow-up.
4. **Funding** — is there already USD/USDC in a Coinbase account ready to trade, or
   does "ready to run" include the Pix→BRL→USD funding step as part of this plan's
   scope (it can't be automated — it's a one-time manual deposit — but worth
   confirming it's not blocking)?
5. **Tax-exemption guard scope.** `neverExceedExemptionLimit` currently only applies
   to `mercadobitcoin` (commented as "domestic exchange" in `rebalancer.ts`). Should a
   Coinbase instance's SELLs be subject to the same R$35k/month exemption-cap guard
   (Lei 9.250 applies to a BR tax resident's aggregate crypto sales regardless of
   exchange, not just domestic ones — this existing comment may itself be
   under-scoped, which is worth a real answer from you/your accountant, not an
   assumption from me).

## Verification plan (once implementation starts)

- Unit tests for `CoinbaseAdapter` (mocked HTTP client) mirroring the existing
  `adapter.test.ts` coverage for MB.
- Unit tests for the JWT signing helper against Coinbase's own published test
  vectors if available, or at minimum structural assertions (correct claims, correct
  header `kid`).
- Unit tests for `FxRateService`'s daily cache behavior (same shape as
  `VolatilityService`'s existing cache tests).
- `setup-check.ts` extended to validate Coinbase credentials, matching the existing
  per-exchange credential check.
- Dry-run (`DRY_RUN=true --once`) against a scratch config before any real funds are
  involved, exactly like every other instance's bring-up.

## Implementation Notes (post-build)

**Research resolved, not left as an open guess:** BACEN SGS série 1 ("Dólar
americano - venda") is the PTAX rate Receita Federal guidance points to for
converting foreign-currency gains to BRL, and was verified live against the real
BACEN endpoint. Separately — and this changes open question 5's framing — Receita
Federal's own guidance states the R$35k Lei 9.250 exemption covers crypto sales
"no Brasil ou no exterior," i.e. it is **not** domestic-exchange-only as the
existing `rebalancer.ts` comment implied. `neverExceedExemptionLimit` now also
exists on Coinbase's config branch (defaulted `true`, unlike `mercadobitcoin`'s
`false` default) and is honored in `rebalancer.ts`'s guard check. **Binance's
behavior was deliberately left unchanged** — it's a real-money instance already
running, and extending this guard to it is a separate decision for you/your
accountant, not something to bundle into this change.

**What was built:** `FxRateService` (BACEN PTAX daily cache, mirroring
`VolatilityService`'s shape); the `coinbase` config branch (symbol regex moved
per-exchange so Coinbase can accept `BASE-USD` while MB/Binance keep `BASE-BRL`);
`getCoinbaseCredentials()` in `keyring.ts` (a `{keyName, privateKeyPem}` pair, not
a simple key/secret — a genuinely different credential shape than the other two
exchanges); `adapters/coinbase/{jwt,client,endpoints,adapter,raw-types}.ts`
implementing the real Advanced Trade API surface (JWT/CDP-key auth, candles,
accounts, create/get order); wiring into `index.ts`, `scan.ts`, `liquidate.ts`,
`setup-check.ts`; `scanner.ts` generalized from a hardcoded BRL-suffixed candidate
list to base-asset-list + quote-currency (`ScanOptions.quoteCurrency`); a
`coinbase-btc.yaml.template` instance config; an `ecosystem.config.cjs` entry
(commented out, pending real credentials); and all four GitHub Actions workflows
(`rebalancer.yml`, `scan.yml` — renamed from `mercado-bitcoin-scan.yml`,
`dashboard.yml`, `monthly-db-backup.yml`) generalized to matrix/loop over
instances, with `coinbase-btc` present but commented out in every one so CI
behavior is unchanged until real secrets exist.

**Verified:** `tsc --noEmit` and `npm run build` clean; full test suite passing
(85/85, up from 70 — 15 new tests: JWT signing structure/claims against
locally-generated EC/Ed25519/RSA test keys, `FxRateService`'s cache/fallback/error
paths against a mocked BACEN response, and `CoinbaseAdapter`'s BRL<->USD
conversion math in `getPrice`/`getPortfolio`/`executeTrade` BUY and SELL against
mocked endpoints — these last ones exercise the actual conversion arithmetic with
concrete numbers, not just "does it compile"); the `coinbase-btc.yaml.template`
parses and validates against the real Zod schema; the live BACEN PTAX endpoint
was queried directly during research and returns sensible values.

**Not verified, and cannot be from this environment:** any real HTTP call to
Coinbase itself — there are no credentials available here, sandboxed or
otherwise. The JWT auth scheme (header `kid`/`nonce`, claims `sub`/`iss`/`uri`,
~120s expiry) was written from Coinbase's published docs and is structurally
tested, but the actual signature has never been validated against Coinbase's
server. **Run `npm run setup-check` against a real Coinbase CDP key — read-only
account/balance/candle checks — before ever enabling live trading or even
`DRY_RUN` cycles that place real (test-mode) orders.** The GitHub Actions
matrix/loop changes are YAML I could not execute in this environment either
(no Actions runner here); double-check a `workflow_dispatch` run of each
generalized workflow against `hype-mb` (the one instance with real secrets
already configured) before relying on them, to catch any YAML or matrix-syntax
mistake before it matters for a second instance.
