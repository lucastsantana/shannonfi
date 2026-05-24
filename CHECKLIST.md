# Implementation Checklist

Track progress from design → mainnet deployment.

---

## Phase 1: Local Development ✅ (Complete)

- [x] Design vault architecture (Shannon's Demon strategy)
- [x] Design keeper authorization model (keeper-gated, not permissionless)
- [x] Design share math (NAV model with geometric mean first deposit)
- [x] Design security model (17 error codes, overflow protection, oracle staleness)
- [x] Create Anchor program structure (5 instructions)
- [x] Implement VaultState PDA (198 bytes)
- [x] Implement initialize instruction
- [x] Implement deposit instruction
- [x] Implement withdraw instruction
- [x] Implement set_keeper instruction
- [x] Implement rebalance instruction (partial - Jupiter CPI stub)
- [x] Implement math functions (isqrt, price conversion, shares)
- [x] Define error codes (17 types)
- [x] Create event structs
- [x] Create test helpers (setup, oracle, Jupiter)
- [x] Create GitHub Actions workflows (hourly keeper)
- [x] Write comprehensive documentation (6 guides)

**Status:** Ready for next phase

---

## Phase 2: Refinement (2–3 hours) 🔴 (In Progress)

### High Priority (Blockers)
- [ ] **Fix deposit NAV calculation**
  - Current bug: NAV calculated incorrectly when vault has existing balance
  - Fix: Compute NEW deposit value only, not total vault value
  - Test: deposit → deposit → verify correct NAV
  
- [ ] **Implement Jupiter CPI in rebalance**
  - Current: Computes swap direction/amount but doesn't execute
  - Implement: Call `jupiter_cpi::cpi::shared_accounts_route` with vault PDA as signer
  - Test: Verify SOL-to-USDC and USDC-to-SOL swaps work
  
- [ ] **Write integration test suite**
  - Test: initialize
  - Test: deposit (first, geometric mean)
  - Test: deposit (second, NAV-proportional)
  - Test: withdraw (partial)
  - Test: withdraw (full)
  - Test: set_keeper
  - Test: rebalance (SOL-heavy path)
  - Test: rebalance (USDC-heavy path)
  - Test: error paths (unauthorized, stale oracle, slot not elapsed, wrong direction)

### Medium Priority
- [ ] Complete keeper bot main loop (`app/src/keeper.ts`)
  - Implement `checkAndRebalance()` method
  - Fetch vault state
  - Fetch Jupiter quote
  - Construct versioned transaction
  - Send and monitor transaction
  - Add retry logic

- [ ] Test on localnet end-to-end
  - Deploy program
  - Initialize vault
  - Deposit 1 SOL + 1000 USDC
  - Run keeper bot manually
  - Trigger rebalance (advance slots)
  - Verify swap occurred

---

## Phase 3: Devnet Testing (1 week) 🟡 (Next)

- [ ] Deploy program to devnet
- [ ] Create devnet vault (initialize)
- [ ] Request devnet USDC from faucet
- [ ] Deposit to vault (1 SOL + 1000 USDC)
- [ ] Set up keeper bot
- [ ] Configure GitHub Actions secrets (RPC_URL, VAULT_AUTHORITY, KEEPER_SECRET_KEY)
- [ ] Monitor hourly keeper runs
- [ ] Verify rebalance triggers correctly
- [ ] Check Pyth feed (is devnet feed available?)
- [ ] Check Jupiter routing (does SOL/USDC pair route correctly?)
- [ ] Test deposit/withdraw flows
- [ ] Verify event emissions
- [ ] Monitor transaction costs

---

## Phase 4: Security Review (1–2 weeks)

- [ ] Internal security audit (review all 5 instructions)
- [ ] Check arithmetic overflow in all paths
- [ ] Verify Pyth feed ID is correct
- [ ] Test error handling paths
- [ ] Verify PDA derivation uniqueness
- [ ] Check rent-exempt floor enforcement
- [ ] External audit (optional, recommended before mainnet)
- [ ] Testnet war games (simulate failures, edge cases)

---

## Phase 5: Mainnet Preparation (3–5 days)

- [ ] Generate production program keypair
- [ ] Update `declare_id!` in lib.rs
- [ ] Update Anchor.toml with production program ID
- [ ] Generate production keeper keypair
- [ ] Fund keeper wallet (0.5 SOL for initial tx fees)
- [ ] Review all fees (keeper_fee_bps, slippage_bps, thresholds)
- [ ] Review rebalance_interval (432,000 slots = ~2 days)
- [ ] Double-check Pyth SOL/USD mainnet feed ID
- [ ] Verify Jupiter routing on mainnet
- [ ] Create documentation for operators

---

## Phase 6: Mainnet Deployment

- [ ] Build program in release mode
- [ ] Deploy program (cost: ~1.74 SOL)
- [ ] Initialize vault with authority + keeper wallet
- [ ] Verify vault was created (check PDA)
- [ ] Fund vault with initial deposit (e.g., 100 SOL + 500k USDC)
- [ ] Verify shares minted
- [ ] Deploy keeper bot to GitHub Actions
- [ ] Configure secrets (RPC_URL, VAULT_AUTHORITY, KEEPER_SECRET_KEY)
- [ ] Monitor first rebalance (manually or wait 2 days)
- [ ] Verify rebalance executed correctly
- [ ] Monitor NAV over time

---

## Phase 7: Long-term Operations 🟢 (Ongoing)

- [ ] Monitor vault NAV daily
- [ ] Monitor keeper bot health (check GitHub Actions logs)
- [ ] Monitor Pyth feed (any staleness?)
- [ ] Monitor Jupiter routing (any price degradation?)
- [ ] Track keeper fees accrued
- [ ] Set up alerts (NAV deviation, keeper failure, rebalance timing)
- [ ] Add monitoring dashboard (optional)
- [ ] Plan governance updates (fee changes, threshold adjustments)

---

## Security Verification Checklist

### Authorize Checks
- [x] Deposit: authority-only ✅
- [x] Withdraw: authority-only ✅
- [x] Set_keeper: authority-only ✅
- [x] Rebalance: keeper-only ✅

### Oracle Safety
- [x] Pyth feed ID hardcoded ✅
- [x] Staleness check (60s max) ✅
- [x] Price validation (> 0) ✅
- [ ] Devnet feed ID verified
- [ ] Mainnet feed ID verified

### Arithmetic Safety
- [x] isqrt_u128 tested ✅
- [x] Price conversion tested ✅
- [x] Overflow checks in place ✅
- [x] u128 intermediates for multi-step math ✅
- [ ] Full integration test coverage

### Swap Safety
- [x] Slippage capped (1% max) ✅
- [x] Swap direction validated ✅
- [x] Swap authority checked ✅
- [ ] Jupiter CPI implemented
- [ ] Jupiter remaining accounts validated

### State Safety
- [x] Keeper stored on-chain ✅
- [x] Keeper rotatable ✅
- [x] Vault pauseable ✅
- [x] Rent-exempt floor enforced ✅

---

## Keeper Deployment Checklist

### GitHub Actions (Free, Hourly)
- [x] Workflow file created (.github/workflows/keeper.yml) ✅
- [ ] Secrets configured (RPC_URL, VAULT_AUTHORITY, KEEPER_SECRET_KEY)
- [ ] Workflow tested (trigger manually via GitHub UI)
- [ ] Failure notifications configured

### Self-Hosted Runner (Optional, Faster)
- [ ] VM provisioned (t3.micro, 1 vCPU, 1 GB RAM)
- [ ] GitHub runner installed
- [ ] Runner registered to repo
- [ ] Workflow updated to target self-hosted runner
- [ ] Health checks configured

### Docker (Optional, Portable)
- [ ] Dockerfile created
- [ ] Built and tested locally
- [ ] Pushed to registry
- [ ] Deployed to container service (optional)

---

## Documentation Checklist

- [x] FINAL_STATUS.md ✅
- [x] QUICKSTART.md ✅
- [x] README.md ✅
- [x] PLAN.md ✅
- [x] KEEPER_SETUP.md ✅
- [x] IMPLEMENTATION_SUMMARY.md ✅
- [x] INDEX.md ✅
- [ ] Operator runbook (during Phase 5)
- [ ] Troubleshooting guide (during Phase 5)
- [ ] Video walkthrough (nice-to-have)

---

## Cost Tracking

| Phase | Action | Cost (SOL) | Cost (USD @$85) | Date |
|-------|--------|-----------|-----------------|------|
| Dev | (Free, localnet) | 0 | $0 | 2026-05-24 |
| Devnet | Deploy program | ~0.5 | ~$43 | TBD |
| Devnet | Initialize vault | ~0.004 | ~$0.34 | TBD |
| Devnet | Test deposits | ~0.01 | ~$0.85 | TBD |
| Mainnet | Deploy program | ~1.74 | ~$148 | TBD |
| Mainnet | Initialize vault | ~0.004 | ~$0.34 | TBD |
| Mainnet | First deposit | TBD | TBD | TBD |
| Mainnet | Ongoing (per rebalance) | ~0.0005 | ~$0.04 | TBD |
| **Total (to mainnet)** | | **~2.25+** | **~$191+** | |

---

## Sign-Off

- [ ] Project owner review (all phases complete)
- [ ] Code review (by external auditor, optional)
- [ ] Security audit (before mainnet)
- [ ] Mainnet authorization (go/no-go decision)

---

**Current Status:** Phase 1 complete, Phase 2 in progress (3 blockers remain)

**Estimated completion:** 
- Phase 2: 2–3 hours (once blockers are fixed)
- Phase 3 (devnet): 1 week
- Phase 4 (security): 1–2 weeks
- Phase 5 (prep): 3–5 days
- Phase 6 (mainnet): 1 day

**Total to mainnet:** 3–4 weeks

---

**Last updated:** 2026-05-24
**Next checkpoint:** Fix the 3 blockers, run `anchor test`, commit to GitHub
