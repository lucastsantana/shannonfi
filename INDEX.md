# Shannon's Demon — Project Index

Quick navigation for all documentation and code.

This repository contains **two implementations** of the Shannon's Demon volatility-harvesting strategy. Choose your path:

| Path | Custody | Cost | Status | Start here |
|------|---------|------|--------|------------|
| **On-Chain Vault (Solana)** | Self-custodial PDA | ~$263 one-time | Core complete | [README.md](./README.md) → [QUICKSTART.md](./QUICKSTART.md) |
| **CEX Bot (Coinbase)** | Coinbase account | Free | Production-ready ✅ | [cex/README.md](./cex/README.md) |

---

## 📖 Documentation (Start Here)

| Document | Purpose | Read Time |
|----------|---------|-----------|
| **[README.md](./README.md)** | Project overview + both paths compared | 5 min |
| **[FINAL_STATUS.md](./FINAL_STATUS.md)** | Implementation summary + next steps | 5 min |
| **[QUICKSTART.md](./QUICKSTART.md)** | On-chain vault: get running in 5 minutes | 5 min |
| **[cex/README.md](./cex/README.md)** | CEX bot: full setup guide | 10 min |
| **[PLAN.md](./PLAN.md)** | On-chain design, costs, safeguards | 20 min |
| **[KEEPER_SETUP.md](./KEEPER_SETUP.md)** | On-chain keeper deployment options | 10 min |
| **[IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)** | On-chain: what's done, what needs work | 5 min |

**Recommended reading order:** README → (pick a path) → QUICKSTART *or* cex/README.md

---

## 📁 Program Code

### Core
- **[lib.rs](./programs/shannonfi/src/lib.rs)** — Program entrypoint, instruction dispatcher
- **[state.rs](./programs/shannonfi/src/state.rs)** — VaultState struct (198 bytes)
- **[errors.rs](./programs/shannonfi/src/errors.rs)** — 17 error codes
- **[events.rs](./programs/shannonfi/src/events.rs)** — Event structs for indexing

### Math & Constants
- **[math.rs](./programs/shannonfi/src/math.rs)** — Core functions: isqrt, price conversion, NAV, shares
- **[constants.rs](./programs/shannonfi/src/constants.rs)** — Hardcoded feed ID, min deposits, max fees

### Instructions
- **[initialize.rs](./programs/shannonfi/src/instructions/initialize.rs)** — Create vault ✅
- **[deposit.rs](./programs/shannonfi/src/instructions/deposit.rs)** — Accept SOL+USDC, mint shares ⚠️
- **[withdraw.rs](./programs/shannonfi/src/instructions/withdraw.rs)** — Burn shares, return assets ✅
- **[set_keeper.rs](./programs/shannonfi/src/instructions/set_keeper.rs)** — Rotate keeper wallet ✅
- **[rebalance.rs](./programs/shannonfi/src/instructions/rebalance.rs)** — Trigger rebalancing ⚠️

---

## 🧪 Tests & Helpers

- **[tests/shannonfi.ts](./tests/shannonfi.ts)** — Integration tests (stubs) 🔴
- **[tests/helpers/setup.ts](./tests/helpers/setup.ts)** — PDA utilities ✅
- **[tests/helpers/oracle.ts](./tests/helpers/oracle.ts)** — Pyth mock helpers ✅
- **[tests/helpers/jupiter.ts](./tests/helpers/jupiter.ts)** — Jupiter API wrappers ✅

---

## 🤖 Keeper Bot (On-Chain)

- **[app/src/keeper.ts](./app/src/keeper.ts)** — Main keeper loop (skeleton) 🔴
- **[app/src/utils.ts](./app/src/utils.ts)** — Jupiter quote fetcher, utilities ✅

---

## 🏦 CEX Bot (Coinbase)

Full documentation: **[cex/README.md](./cex/README.md)**

- **[cex/src/index.ts](./cex/src/index.ts)** — Entry point (`--once` flag for GitHub Actions)
- **[cex/src/bot/rebalancer.ts](./cex/src/bot/rebalancer.ts)** — Core loop (port of rebalance.rs)
- **[cex/src/bot/portfolio.ts](./cex/src/bot/portfolio.ts)** — Balance fetch + NAV snapshot
- **[cex/src/bot/trader.ts](./cex/src/bot/trader.ts)** — Order placement, fill polling, dry-run
- **[cex/src/coinbase/](./cex/src/coinbase/)** — Auth (JWT ES256), rate-limited client, API types
- **[cex/src/math.ts](./cex/src/math.ts)** — TypeScript port of math.rs
- **[cex/src/scripts/setup-check.ts](./cex/src/scripts/setup-check.ts)** — Pre-flight validator
- **[cex/src/scripts/backtest.ts](./cex/src/scripts/backtest.ts)** — Historical replay via Coinbase candles
- **[cex/.github/workflows/cex-rebalancer.yml](./cex/.github/workflows/cex-rebalancer.yml)** — Cron every 5 min ✅

---

## ⚙️ Configuration

- **[Anchor.toml](./Anchor.toml)** — Solana cluster config
- **[Cargo.toml](./Cargo.toml)** — Rust workspace
- **[programs/shannonfi/Cargo.toml](./programs/shannonfi/Cargo.toml)** — Program dependencies
- **[package.json](./package.json)** — TypeScript dependencies
- **[tsconfig.json](./tsconfig.json)** — TypeScript config

---

## 🚀 GitHub Actions

- **[.github/workflows/keeper.yml](./.github/workflows/keeper.yml)** — Hourly keeper (scheduled action)
- **[.github/workflows/keeper-long-running.yml](./.github/workflows/keeper-long-running.yml)** — Self-hosted runner option

---

## 📊 Quick Stats

| Metric | On-Chain Vault | CEX Bot |
|--------|---------------|---------|
| **Deployment Cost** | ~1.75 SOL (~$263) | Free |
| **Per-tx Fee** | ~0.0002–0.0005 SOL | ~0.4% taker fee |
| **Rebalance Trigger** | 432,000 slots (~2 days) | Drift > 1% + 2h cooldown |
| **Check Interval** | 1 hour (GitHub Actions) | 5 minutes (GitHub Actions) |
| **Max Slippage** | 1% | 1% (warning only) |
| **Keeper Fee** | 0.1% vault AUM (max 0.5%) | None |
| **Vault State** | 198 bytes (on-chain PDA) | `data/trade_history.json` |
| **Tests** | Rust unit tests (partial) | 48 TypeScript tests ✅ |
| **Status** | Core complete ⚠️ | Production-ready ✅ |

---

## 🎯 Next Steps

### Immediate (2–3 hours)
1. ✅ Review **[FINAL_STATUS.md](./FINAL_STATUS.md)**
2. ✅ Run **[QUICKSTART.md](./QUICKSTART.md)** — Local build & test
3. ⚠️ Fix deposit NAV logic in `deposit.rs`
4. ⚠️ Add Jupiter CPI to `rebalance.rs`
5. 🔴 Write integration tests in `tests/shannonfi.ts`
6. 🔴 Complete keeper bot in `app/src/keeper.ts`

### Short-term (1 week)
7. Deploy to devnet
8. Test end-to-end with keeper
9. Audit security

### Long-term (Production)
10. Deploy to mainnet
11. Set up monitoring/alerting
12. Add governance features

---

## ✅ Status Legend

- ✅ **Complete** — Production-ready
- ⚠️ **Partial** — Needs refinement
- 🔴 **Stub** — Skeleton/incomplete

---

## 💡 Key Concepts

**50/50 Rebalancing:**  
Hold exactly 50% SOL / 50% USDC by value. Rebalance every ~2 days by swapping to restore balance.

**Volatility Harvesting:**  
In a rising market, sell the appreciating asset (SOL). In a falling market, buy it back at a discount. Over time, this generates alpha.

**NAV-Based Shares:**  
Shares are priced by net asset value (vault total / shares outstanding). First deposit uses geometric mean initialization.

**Keeper-Gated Rebalancing:**  
Only a designated keeper wallet can trigger rebalances. Prevents MEV attacks. Keeper receives a fee (0.1% default).

**On-Chain Timing:**  
Rebalancing is triggered by slot height (`432,000` slot intervals ≈ 2 days), not by a central scheduler.

---

## 🔒 Security Highlights

- Keeper wallet stored on-chain, rotatable by authority
- Pyth feed ID hardcoded (prevents substitution)
- Oracle staleness check (60s max)
- Slippage capped (1% max)
- Keeper fee capped (0.5% max)
- All arithmetic overflow-protected
- 17 explicit error codes

---

## 📞 Support

**For setup help:** See **[QUICKSTART.md](./QUICKSTART.md)**  
**For keeper deployment:** See **[KEEPER_SETUP.md](./KEEPER_SETUP.md)**  
**For architecture details:** See **[PLAN.md](./PLAN.md)**  
**For current status:** See **[FINAL_STATUS.md](./FINAL_STATUS.md)**

---

**Last updated:** 2026-05-24  
**Status:** Implementation complete, ready for refinement and testing  
**Next:** Follow [FINAL_STATUS.md](./FINAL_STATUS.md) → [QUICKSTART.md](./QUICKSTART.md)
