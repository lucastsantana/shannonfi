# Recording Capital Flows — Usage Guide

**Status:** `hype-mb` (Mercado Bitcoin) auto-detects deposits/withdrawals; every other
instance, including `coinbase-shannon-1`, is manual-only via the `record-flow` CLI —
this is a deliberate choice, not a gap to be filled later (see "Why Coinbase is
manual-only" below).

## What this is, and why it matters

Every instance maintains a NAV-per-share ledger (`ShareLedgerService`, see `CLAUDE.md`
→ "Fund-Share (NAV-per-share) Ledger") so that adding or removing capital doesn't get
misread as trading gain or loss. Every `RETURN`/`NET GAIN`/`CAGR`/`Sharpe` figure the bot
computes — CLI reports, the dashboard, the monthly report — depends on the
`capital_flows` table being complete. If a deposit or withdrawal happens and is never
recorded there, every performance number computed afterward is silently wrong (it will
count that money as if the strategy earned or lost it). **Recording a flow is not
optional bookkeeping — skipping it corrupts the instance's entire performance record
until you go back and add it.**

## Which instances are automatic vs. manual

| Instance | Exchange | Detection |
|---|---|---|
| `hype-mb` | Mercado Bitcoin | **Automatic** — every cycle, `core/capital-flow-sync.ts` polls MB's real deposit/withdrawal listing endpoints and records new ones itself. See `CLAUDE.md` → "Mercado Bitcoin Adapter". |
| `coinbase-shannon-1` | Coinbase | **Manual only** — you must run `record-flow` yourself, every time. |

### Why Coinbase is manual-only

This isn't a "not built yet" — it's a real API limitation, researched and confirmed:

- Coinbase's **Advanced Trade API v3** (`api.coinbase.com/api/v3/brokerage/*` — what
  `CoinbaseAdapter` uses, CDP-key JWT auth) has **no endpoint that lists deposits or
  withdrawals at all.** The complete private-endpoint surface is accounts, orders,
  products, `transaction_summary` (fee/volume aggregates, not a ledger), portfolios,
  futures, and payment methods — confirmed against Coinbase's own API reference, not
  guessed.
- The **Coinbase Exchange API** (the older institutional API) does have a `GET
  /transfers` endpoint that would work — but it requires legacy HMAC auth (API key +
  secret + **passphrase**), a completely different credential format from the CDP keys
  this instance uses. Coinbase stopped letting anyone create new legacy passphrase
  keys on **2024-05-31** and expired every remaining legacy key on **2025-02-05**.
  There is no way to obtain a working credential for that endpoint today.
- The only remaining option would be *inferring* a flow from an unexplained USDC
  balance change (comparing actual balance against what the bot's own trades predict)
  rather than reading an authoritative record — considered and deliberately rejected:
  it's fuzzier than a real ledger (vulnerable to rounding/fee edge cases producing a
  false positive) and risks silently corrupting NAV data if auto-recorded on a bad
  inference. Manual entry, where a human confirms the real amount, is safer.

If Coinbase ever ships a transfer-listing endpoint under CDP auth, this is worth
revisiting — check `docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api`
for an updated endpoint list before assuming this is still true.

## Prerequisites

- You're in the `bot/` directory, dependencies installed (`npm install`), and you have
  working credentials for the instance (keyring locally, or the relevant env vars).
- You know the instance's config path (e.g. `configs/hype-mb.yaml`,
  `configs/coinbase-shannon-1.yaml`) — this determines which instance's database gets
  the flow recorded against. **Double-check this every time** — recording against the
  wrong instance's `--config` silently pollutes the wrong ledger with no error.

## Recording a deposit

**Recommended: run this *before* you actually move the money.** The script reads the
account's current live value as the pre-flow baseline — if you run it first, that
reading is correct by construction.

```bash
cd bot
npm run record-flow -- --config configs/hype-mb.yaml --type deposit --brl 500
```

It prints the live pre-flow value, the NAV/share it's issuing shares at, how many
shares get issued, and the new total share count — then tells you to go move the money.
Do that next.

**If you already moved the money first** (forgot, or it happened automatically), add
`--already-moved` — the live value the script reads already includes the deposit, so it
backs the amount out to reconstruct the pre-flow baseline instead:

```bash
npm run record-flow -- --config configs/hype-mb.yaml --type deposit --brl 500 --already-moved
```

Add `--note "..."` on either form for your own future reference (e.g. `--note "PIX from personal account"`).

## Recording a withdrawal

Identical shape, `--type withdrawal`. Same recommendation: run it before you actually
withdraw, and add `--already-moved` if you've already pulled the money out.

```bash
npm run record-flow -- --config configs/coinbase-shannon-1.yaml --type withdrawal --brl 200 --note "profit take"
```

## Coinbase-specific: converting USDC to BRL first

`coinbase-shannon-1` trades in USDC, not BRL — but `record-flow`'s `--brl` flag always
expects a BRL amount, matching how every other value in this engine is BRL-denominated
(`CoinbaseAdapter` converts at its own boundary using the daily BACEN PTAX rate; see
`CLAUDE.md`). If you deposit or withdraw USDC directly, convert it to BRL first using
**that same day's PTAX rate**, reusing the exact service the adapter itself uses (no
new code needed — this is read-only and safe to run any time):

```bash
cd bot
npx ts-node -e "
import { FxRateService } from './src/core/tracker/fxrate';
new FxRateService().getUsdBrlRate().then(r => console.log('Today\'s PTAX (USD/BRL):', r));
"
```

Multiply your USDC amount by that rate, then pass the result to `--brl`. Example: you
deposited 100 USDC and the printed rate is 5.10 → `--brl 510`.

(If you've generated the dashboard today, the same rate is also baked into
`dashboard.html` as the `PTAX` JS constant — view source and search for `var PTAX` — but
the command above is more direct and doesn't depend on when the dashboard was last
generated.)

## Verifying it worked

1. The command's own output already shows the result (NAV/share, shares issued/redeemed, new total).
2. Regenerate the dashboard and check the `OUTSTANDING SHARES` tile reflects the new total, and `SHARE PRICE` is unchanged from just before the flow (that's the whole point — a flow shouldn't move nav/share):
   ```bash
   npm run dashboard -- --config configs/<instance>.yaml
   ```
3. If you want to inspect the raw row:
   ```bash
   sqlite3 data/<instance>/shannonfi.db "SELECT * FROM capital_flows ORDER BY timestamp DESC LIMIT 1;"
   ```

## Common mistakes

- **Wrong `--config`.** Recording against `hype-mb`'s config when you meant
  `coinbase-shannon-1` (or vice versa) silently writes to the wrong database — there's
  no cross-check. Read the command back before running it.
- **Forgetting `--already-moved` after the money already moved.** Without it, the
  script treats the live (post-deposit) balance as the *pre-flow* baseline, which
  issues too many shares (or too few, for a withdrawal) — it double-counts the flow's
  effect on the balance. If you already moved the money, always add the flag.
- **Passing a raw USDC amount to `--brl` on Coinbase without converting.** This silently
  records the wrong flow size — 100 (USDC) treated as R$100 when it was actually
  ~R$510. Always convert first (see above).
- **Running it after a rebalance cycle already ran with the new, un-recorded balance.**
  Not harmful in itself — `ShareLedgerService` bootstraps from whatever
  `total_value_brl` it's given — but the sooner you record a flow after it happens, the
  less chance the price also moved in between and blurred the reconciliation. Record it
  same-day if at all possible.
