# Quickstart — On-Chain Vault (Solana)

## Choose Your Path

| | CEX Bot (Coinbase) | On-Chain Vault (Solana) |
|---|---|---|
| **Requirements** | Node.js 18+, Coinbase account | Rust, Solana CLI, Anchor, Node.js |
| **Deployment cost** | Free | ~$263 (1.75 SOL) |
| **Custody** | Coinbase holds funds | Self-custodial smart contract |
| **Status** | Complete, production-ready | Core complete, integration pending |
| **Start here** | **[cex/README.md](./cex/README.md)** | This guide ↓ |

**If you want the Coinbase bot**, stop here and follow **[cex/README.md](./cex/README.md)** — no Solana toolchain needed.

**This guide covers the on-chain Solana vault.**

---

## 5-Minute Overview

**Shannon's Demon Vault** is an on-chain rebalancing fund on Solana that:
- Holds exactly 50% SOL / 50% USDC (by value)
- Rebalances every ~2 days automatically
- Issues/redeems shares (NAV-based)
- Generates excess return from volatility harvesting

**Cost to deploy:** ~$263 (1.75 SOL) on mainnet.

---

## Local Development (5 min)

### Prerequisites
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Install Anchor
npm install -g @coral-xyz/anchor-cli
```

### Build & Test
```bash
cd /home/user/repos/shannonfi

# Install JS dependencies
npm install

# Build Anchor program
anchor build

# Run tests (requires local Solana test validator)
solana-test-validator &
anchor test
solana-test-validator --kill
```

---

## Devnet Deployment (10 min)

### 1. Generate Program & Keeper Keypairs
```bash
solana-keygen new -o ./target/deploy/shannonfi-keypair.json
solana-keygen new -o ./keeper-keypair.json

# Get program ID
solana address -k ./target/deploy/shannonfi-keypair.json
# Output: 4EYp2gXhDcPVZYcaQfT2tBUfT6L8jSfPMd6a4P8EX2Qx (example)
```

### 2. Update Program ID
Edit `programs/shannonfi/src/lib.rs`:
```rust
declare_id!("YOUR_PROGRAM_ID_HERE");
```

Also update `Anchor.toml`:
```toml
[programs.devnet]
shannonfi = "YOUR_PROGRAM_ID_HERE"
```

### 3. Build & Deploy
```bash
# Configure Solana CLI for devnet
solana config set --url https://api.devnet.solana.com
solana config set --keypair ~/.config/solana/id.json

# Airdrop SOL (devnet only)
solana airdrop 5

# Build and deploy
anchor build --release
anchor deploy --provider.cluster devnet
```

### 4. Initialize Vault
```bash
# Create a vault (example using Anchor client)
anchor idl fetch YOUR_PROGRAM_ID > idl.json

# Use Anchor.toml test script or write a client
npm run test -- --provider.cluster devnet
```

---

## Mainnet Deployment (Production)

### 1. **Prepare**
- Ensure keeper has SOL for transaction fees (~0.001 per rebalance)
- Ensure vault has initial deposit (min 0.001 SOL + 1 USDC)

### 2. **Deploy Program**
```bash
solana config set --url https://api.mainnet-beta.solana.com

anchor build --release
anchor deploy --provider.cluster mainnet-beta
```

### 3. **Initialize Vault**
```bash
# Replace with your actual addresses
export AUTHORITY="YOUR_WALLET_ADDRESS"
export KEEPER="YOUR_KEEPER_WALLET_ADDRESS"
export USDC_MINT="EPjFWaLb3odcccccccccccccccccccccccdvHHgqq"

# Call initialize instruction via Anchor client
npm run init-vault
```

### 4. **Make First Deposit**
```bash
export SOL_AMOUNT=1000000000  # 1 SOL
export USDC_AMOUNT=1000000    # 1 USDC

npm run deposit
```

### 5. **Set Up Keeper**
See [KEEPER_SETUP.md](./KEEPER_SETUP.md) for deployment options.

---

## Using the Vault

### As an End User

**Deposit (Buy Shares):**
```bash
npm run deposit -- --sol 1 --usdc 1000
# Returns: shares minted
```

**Withdraw (Sell Shares):**
```bash
npm run withdraw -- --shares 500000000  # 500M shares (6 decimals)
# Returns: SOL + USDC withdrawn
```

### As the Vault Authority

**Rotate Keeper:**
```bash
npm run set-keeper -- --new-keeper <NEW_KEEPER_PUBKEY>
```

**Pause Vault (Emergency):**
```bash
# Edit vault state to set `paused = true`
npm run pause-vault
```

---

## Monitoring

### Check Vault State
```bash
npm run fetch-vault-state -- --vault <VAULT_PDA>
```

Output:
```json
{
  "authority": "...",
  "keeper": "...",
  "total_shares": 1000000000,
  "last_rebalance_slot": 240000000,
  "rebalance_interval": 432000,
  "paused": false,
  "vault_sol_lamports": 5000000000,
  "vault_usdc": 1000000000
}
```

### NAV Per Share
```bash
npm run get-nav -- --vault <VAULT_PDA>
# Output: 1234567 (in 6-decimal USD, e.g., $1.234567)
```

### Rebalance History
```bash
npm run rebalance-history -- --vault <VAULT_PDA> --limit 10
```

---

## Key Files to Know

| File | Purpose |
|------|---------|
| `programs/shannonfi/src/lib.rs` | Program entrypoint |
| `programs/shannonfi/src/state.rs` | VaultState data model |
| `PLAN.md` | Architecture & design |
| `README.md` | Full documentation |
| `KEEPER_SETUP.md` | Keeper deployment guide |

---

## Common Commands

```bash
# Build
anchor build

# Test (localnet)
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Deploy to mainnet
anchor deploy --provider.cluster mainnet-beta

# Get program account
solana account PROGRAM_ID -u mainnet-beta

# Get vault PDA
npm run derive-vault -- --authority YOUR_WALLET

# Fetch vault state
npm run fetch-vault -- --vault VAULT_PDA
```

---

## Costs

| Operation | Cost |
|-----------|------|
| Program deployment | ~1.74 SOL (~$261) |
| Initialize vault | ~0.004 SOL (~$0.60) |
| Deposit | ~0.0002 SOL (~$0.03) |
| Withdraw | ~0.0002 SOL (~$0.03) |
| Rebalance | ~0.0005 SOL (~$0.08) |

---

## Next Steps

1. **Test locally** → Run `anchor test` on localnet
2. **Deploy to devnet** → Follow Devnet Deployment section
3. **Test rebalancing** → Set up keeper bot, trigger a rebalance
4. **Review security** → See [PLAN.md](./PLAN.md) for safeguards
5. **Deploy to mainnet** → Follow Mainnet Deployment section

---

## Troubleshooting

**Q: Build fails with "anchor not found"**  
A: Install Anchor CLI: `npm install -g @coral-xyz/anchor-cli`

**Q: Localnet tests timeout**  
A: Increase test timeout in `Anchor.toml` → `[scripts] test = "... -t 1000000"`

**Q: Deployment fails "insufficient lamports"**  
A: Airdrop more SOL: `solana airdrop 10`

**Q: Keeper doesn't trigger rebalance**  
A: Check Pyth feed not stale, vault drift > 1%, slot elapsed. See [KEEPER_SETUP.md](./KEEPER_SETUP.md).

---

## Resources

- [Anchor Docs](https://www.anchor-lang.com/)
- [Solana Docs](https://docs.solana.com/)
- [Jupiter CPI](https://docs.jup.ag/docs/cross-program-invocation-cpi)
- [Pyth Oracles](https://docs.pyth.network/)

---

**Ready?** Start with `anchor build && anchor test` 🚀
