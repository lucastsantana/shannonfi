# Local Testing Plan

Test the Anchor program on localnet before devnet/mainnet.

---

## Phase 1: Build & Compile ✅ (In Progress)

### Command
```bash
cargo build -p shannonfi --release
```

### Expected Output
- No compilation errors
- Binary compiled to `target/release/shannonfi.so` (~250 KB)
- All dependencies resolved

### What to Check
- [ ] No warnings about overflow
- [ ] All custom types compile
- [ ] Pyth oracle types available
- [ ] Jupiter CPI types available

---

## Phase 2: Unit Tests (Math Functions)

### Command
```bash
cargo test -p shannonfi --lib
```

### Tests to Run
- [x] `isqrt_u128()` — Integer square root
  - Test: 0, 1, 4, 9, 16, 100, 1_000_000
  - Expected: Exact results for perfect squares
  
- [x] `pyth_price_to_usd_6dec()` — Price conversion
  - Test: price=15_000_000_000, expo=-8
  - Expected: > 0, no overflow

### Expected Result
- All tests pass
- No panics on edge cases (0, max u64, etc.)

---

## Phase 3: Integration Tests (Full Flows)

### Prerequisite
Start localnet validator:
```bash
solana-test-validator &
```

### Tests to Implement
1. **Initialize Vault**
   - Create vault with authority + keeper
   - Expected: VaultState created, share_mint created, ATAs initialized

2. **First Deposit (Geometric Mean)**
   - Deposit 1 SOL + 1_000_000 USDC (1 USDC)
   - Expected: shares = sqrt(sol_value_usd * 1_000_000)
   - Check NAV per share = (sol_value + usdc) / shares

3. **Second Deposit (NAV-Proportional)**
   - Deposit 2 SOL + 2_000_000 USDC
   - Expected: shares = (deposit_value * total_shares) / vault_value
   - Check NAV unchanged

4. **Withdraw (Partial)**
   - Withdraw 50% of shares
   - Expected: Receive 50% of SOL and USDC
   - Check: total_shares decreases

5. **Withdraw (Full)**
   - Withdraw remaining shares
   - Expected: Receive all remaining SOL + USDC
   - Check: total_shares = 0

6. **Set Keeper**
   - Rotate keeper wallet
   - Expected: New keeper can call rebalance, old keeper cannot

7. **Rebalance (SOL-Heavy)**
   - Create imbalance: 60% SOL / 40% USDC
   - Call rebalance
   - Expected: Swaps SOL → USDC, restores ~50/50
   - Check: last_rebalance_slot updated

8. **Rebalance (USDC-Heavy)**
   - Create imbalance: 40% SOL / 60% USDC
   - Call rebalance
   - Expected: Swaps USDC → SOL, restores ~50/50

### Error Path Tests
- [ ] `Unauthorized` — Non-authority deposits/withdraws
- [ ] `VaultPaused` — Operations fail when paused
- [ ] `OracleStale` — Price > 60s old rejected
- [ ] `SlotNotElapsed` — Rebalance too soon fails
- [ ] `BelowThreshold` — Rebalance when already balanced fails
- [ ] `WrongSwapDirection` — Swap with wrong token fails
- [ ] `SlippageExceeded` — Slippage > 1% fails
- [ ] `BelowMinimumDeposit` — Small deposits rejected

---

## Phase 4: Manual Testing (Localnet)

### Setup
```bash
# Terminal 1: Start validator
solana-test-validator --reset

# Terminal 2: Set up test wallet
solana config set --url http://localhost:8899
solana-keygen new -o /tmp/test-wallet.json
solana airdrop 100 /tmp/test-wallet.json --url http://localhost:8899
```

### Test Steps
1. Deploy program
   ```bash
   anchor build
   anchor deploy --provider.cluster localnet
   ```

2. Initialize vault
   ```bash
   npm run init-vault -- --keeper <KEEPER_PUBKEY>
   ```

3. Create USDC mint (if needed)
   ```bash
   spl-token create-mint /tmp/test-wallet.json 6
   ```

4. Deposit
   ```bash
   npm run deposit -- --sol 1 --usdc 1000
   ```

5. Check vault state
   ```bash
   npm run fetch-vault-state
   ```

6. Withdraw
   ```bash
   npm run withdraw -- --shares <SHARE_AMOUNT>
   ```

7. Set keeper
   ```bash
   npm run set-keeper -- --new-keeper <NEW_KEEPER>
   ```

8. Rebalance (manually advance slots)
   ```bash
   # Get current slot
   solana slot

   # Advance to trigger rebalance
   npm run rebalance
   ```

---

## Phase 5: Edge Cases

### Test Cases
- [ ] **Zero shares** — Vault with total_shares = 0
- [ ] **Large amounts** — Deposit 1M SOL + 1B USDC
- [ ] **Precision loss** — Rounding in NAV calculation
- [ ] **Dust** — Withdraw remaining 1 lamport/token
- [ ] **Concurrent operations** — Simulate multiple txs (if possible)

---

## Expected Results

### Compilation
- ✅ No errors
- ✅ ~250 KB binary

### Unit Tests
- ✅ Math functions pass all edge cases

### Integration Tests
- ✅ All 8 test scenarios pass
- ✅ All 8 error cases trigger correct errors

### Manual Testing
- ✅ Vault initializes
- ✅ Deposits mint correct shares
- ✅ Withdrawals return correct amounts
- ✅ NAV remains consistent
- ✅ Keeper can be rotated
- ✅ Rebalancing updates slot

---

## Success Criteria

| Phase | Success | Status |
|-------|---------|--------|
| Build | No compilation errors | ⏳ In progress |
| Unit Tests | All math functions pass | 🔴 Not started |
| Integration | All 8 flows + 8 errors | 🔴 Not started |
| Manual | Vault fully functional | 🔴 Not started |

---

## Common Issues & Fixes

### Issue: "anchor not found"
**Fix:** `npm install -g @coral-xyz/anchor-cli`

### Issue: Localnet fails to start
**Fix:** Kill existing validator: `solana-test-validator --kill`

### Issue: PDA derivation mismatch
**Fix:** Ensure seeds are identical: `[b"vault", authority.key().as_ref()]`

### Issue: Oracle account validation fails
**Fix:** Use mock Pyth account from `tests/helpers/oracle.ts`

### Issue: Transaction too large
**Fix:** Split into multiple txs or use versioned txs with ALTs

---

## Timeline

| Phase | Estimated | Status |
|-------|-----------|--------|
| Build | 10–15 min | ⏳ Running |
| Unit Tests | 5–10 min | 🔴 Queued |
| Integration | 30–45 min | 🔴 Queued |
| Manual | 30–45 min | 🔴 Queued |
| **Total** | **1.5–2 hours** | |

---

**Next:** Monitor build output and run Phase 2 once complete.
