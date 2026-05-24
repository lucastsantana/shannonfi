# Shannon's Demon Vault — Solana Anchor Program

## Context

Build a Solana program implementing the Shannon's Demon rebalancing strategy: hold exactly 50% SOL / 50% USDC by value, rebalancing every 432,000 slots (~2 days). The vault issues and redeems NAV-priced shares, restricted to the owner wallet. Rebalancing is triggered by a designated keeper wallet (stored on-chain) rather than being fully open.

**Key constraints:**
- Rebalance restricted to a designated `keeper` pubkey stored in `VaultState`; authority can rotate it via `set_keeper`
- Only vault authority can deposit (mint shares) or withdraw (burn shares)
- Maximize on-chain efficiency and minimize deployment cost

---

## Technology Stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Framework | Anchor 0.30.x | Standard Solana framework |
| DEX / swap | Jupiter v6 CPI (`shared_accounts_route`) | Best price, handles wSOL wrapping, 1-hop for SOL/USDC |
| Oracle | Pyth v2 Pull Oracle (`PriceUpdateV2`) | Battle-tested SOL/USD feed, staleness-aware |
| Scheduling | Designated keeper wallet (slot-gated, keeper-restricted instruction) | Clockwork is dead (Oct 2023); keeper wallet stored on-chain, rotatable by authority |
| Share token | SPL Token, 6 decimals, PDA-controlled mint | Matches USDC precision |
| Languages | Rust (program) + TypeScript (tests + optional keeper bot) | Standard Anchor stack |

---

## Account State: `VaultState`

**PDA seeds:** `[b"vault", authority.key().as_ref()]`  
One vault per authority wallet; address derivable from owner pubkey.

**Space:** `8 (discriminator) + 190 (fields) = 198 bytes`

```rust
#[account]
pub struct VaultState {
    pub authority:               Pubkey,  // 32 — owner; only account that can deposit/withdraw
    pub keeper:                  Pubkey,  // 32 — only wallet allowed to call rebalance; rotatable by authority
    pub share_mint:              Pubkey,  // 32 — PDA-controlled SPL mint
    pub usdc_mint:               Pubkey,  // 32 — USDC mint address
    pub vault_usdc_ata:          Pubkey,  // 32 — vault's USDC ATA (stored for validation)
    pub last_rebalance_slot:     u64,     //  8
    pub rebalance_interval:      u64,     //  8 — default 432_000
    pub total_shares:            u64,     //  8 — 6-decimal share units
    pub rebalance_threshold_bps: u16,     //  2 — default 100 = 1% drift before rebalancing
    pub keeper_fee_bps:          u16,     //  2 — default 10 = 0.1% of vault AUM paid to keeper
    pub paused:                  bool,    //  1 — emergency pause flag
    pub bump:                    u8,      //  1
}
```

**Native SOL balance** is read directly from `vault_state.to_account_info().lamports() - rent_exempt_min` — not stored in state.

---

## Deployment Costs (Mainnet, SOL ~$85)

| Item | SOL | USD |
|------|-----|-----|
| Program deployment (permanent, ~250 KB binary) | ~1.74 | ~$148 |
| VaultState PDA (198 bytes) | 0.00154 | $0.13 |
| share_mint (82 bytes) | 0.00142 | $0.12 |
| vault_usdc_ata (165 bytes) | 0.00203 | $0.17 |
| vault_wsol_ata (165 bytes) | 0.00203 | $0.17 |
| authority_share_ata (165 bytes) | 0.00203 | $0.17 |
| initialize tx fee | ~0.004 | $0.34 |
| **Total first-run** | **~1.754 SOL** | **~$149** |

Note: the deploy buffer account (~1.74 SOL) is temporary and reclaimed via `solana program close --buffers`. Per-operation fees (deposit, withdraw, rebalance) are ~0.0002–0.0005 SOL each.
