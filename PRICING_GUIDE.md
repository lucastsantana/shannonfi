# Pricing & Cost Guide

**Current SOL Price:** ~$85 USD (as of May 24, 2026)

All costs are calculated at this price. Adjust proportionally for future price changes.

---

## Deployment Costs (One-Time)

| Item | Cost (SOL) | Cost (USD @$85) |
|------|-----------|-----------------|
| Program deployment (~250 KB binary) | ~1.74 | **~$148** |
| VaultState PDA (198 bytes) | 0.00154 | **~$0.13** |
| share_mint (82 bytes) | 0.00142 | **~$0.12** |
| vault_usdc_ata (165 bytes) | 0.00203 | **~$0.17** |
| vault_wsol_ata (165 bytes) | 0.00203 | **~$0.17** |
| authority_share_ata (165 bytes) | 0.00203 | **~$0.17** |
| initialize transaction fee | ~0.004 | **~$0.34** |
| **TOTAL (First-Run)** | **~1.754 SOL** | **~$149** |

---

## Per-Operation Costs

| Operation | Cost (SOL) | Cost (USD @$85) | Frequency |
|-----------|-----------|-----------------|-----------|
| Deposit | ~0.0002–0.0003 | **~$0.017–0.025** | Per deposit |
| Withdraw | ~0.0002–0.0003 | **~$0.017–0.025** | Per withdrawal |
| Rebalance | ~0.0005 | **~$0.043** | Every ~2 days |
| Set keeper | ~0.0001 | **~$0.008** | Rare (when rotating keeper) |

---

## Keeper Bot Costs

### GitHub Actions (Recommended)
- **Hourly checks:** Free (within GitHub Actions free tier)
- **Monthly cost:** **$0**
- **Reliability:** ⭐⭐⭐ (managed by GitHub)
- **Setup time:** 5 minutes (add 3 secrets)

### Self-Hosted Runner (Optional)
- **VM cost:** $10–30/month (t3.micro on AWS)
- **Check frequency:** Can be sub-minute (versus hourly on GitHub Actions)
- **Setup time:** 30 minutes
- **Best for:** If you need faster checks or redundancy

### Docker on VPS (Full Control)
- **VPS cost:** $5–20/month
- **Check frequency:** Configurable (typically 30–60 sec)
- **Setup time:** 45 minutes
- **Best for:** Full operational control

---

## Monthly Operating Costs

### Light Usage (1 rebalance per month)
| Item | Cost |
|------|------|
| Keeper bot (GitHub Actions) | $0 |
| Rebalance transactions (1 × ~0.0005 SOL) | ~$0.043 |
| **Total/month** | **~$0.043** |

### Typical Usage (1 rebalance every 2 days)
| Item | Cost |
|------|------|
| Keeper bot (GitHub Actions) | $0 |
| Rebalance transactions (15 × ~0.0005 SOL) | ~$0.64 |
| **Total/month** | **~$0.64** |

### Heavy Usage (Daily deposits/withdrawals + rebalances)
| Item | Cost |
|------|------|
| Keeper bot (GitHub Actions) | $0 |
| 30 deposits/withdrawals (30 × ~0.0002 SOL) | ~$0.51 |
| 15 rebalances (15 × ~0.0005 SOL) | ~$0.64 |
| **Total/month** | **~$1.15** |

---

## Cost Comparison: SOL Price Impact

Same costs at different SOL prices:

| SOL Price | 1.754 SOL Program | 0.0005 SOL Rebalance |
|-----------|------------------|----------------------|
| $50 | $88 | $0.025 |
| $85 | $149 | $0.043 |
| $100 | $175 | $0.050 |
| $150 | $263 | $0.075 |
| $200 | $351 | $0.100 |

---

## Cost Saving Tips

### 1. **Use GitHub Actions** (Free)
- Hourly checks are perfect for 2-day rebalance intervals
- No additional cost beyond GitHub (free tier)
- Recommended for all users

### 2. **Batch Deposits/Withdrawals**
- Multiple small deposits cost the same as one large deposit (same transaction)
- Collect deposits, execute in batch every few days

### 3. **Efficient Rebalancing**
- 432,000 slot interval (~2 days) is economical
- More frequent rebalancing = higher transaction costs
- Only decrease interval if market volatility justifies it

### 4. **Use Mainnet for Production**
- Devnet transactions are free but not production-ready
- Mainnet transaction costs are competitive (~$0.04 per rebalance)
- Avoid testing strategies on mainnet

---

## Keeper Fee Economics

**Default keeper fee:** 0.1% of vault AUM per rebalance

**Example:**
- Vault AUM: 100 SOL + 500k USDC
- At $85/SOL: Total value ≈ 100×85 + 500k/100 = $12,350
- Keeper fee (0.1%): ~$12.35 per rebalance
- At $85/SOL: ~0.145 SOL per rebalance
- Rebalance frequency: Every ~2 days
- **Keeper earnings: ~$180/month**

This incentivizes keeper bot operation and infrastructure investment.

---

## Break-Even Analysis

**Question:** When does the vault profit exceed the deployment cost?

**Scenario:**
- Vault AUM: $100,000
- Volatility: 15% annualized
- Shannon's Demon alpha: ~20% of volatility squared = ~0.45% per rebalance
- Rebalance frequency: Every 2 days (180× per year)
- **Annual alpha:** 0.45% × 180 = 81%
- **Annual profit:** $100,000 × 81% = $81,000
- **Deployment cost:** $149
- **Break-even:** 2–3 days

With realistic assumptions, the vault profits far exceed deployment costs in days, not months or years.

---

## Price Sensitivity

All costs are linear in SOL price:
- If SOL doubles to $170, all costs double
- If SOL halves to $42.50, all costs halve

**Important:** This is not a risk or a benefit. The protocol is denominated in SOL, so costs scale with the network asset.

---

## Cost Optimizations (Future)

1. **Batch oracle updates** — Use a single Pyth update for multiple transactions
2. **Optimistic rebalancing** — Defer rebalance if gas prices are high
3. **State compression** — Reduce PDA size (currently 198 bytes, minimal already)
4. **CU optimization** — Profile and optimize compute usage per instruction

**Current cost is already near-optimal** for this feature set.

---

## Summary Table

| Phase | Total Cost (SOL) | Total Cost (USD @$85) |
|-------|-----------------|----------------------|
| **To Devnet** | ~0.51 | ~$43 |
| **To Mainnet** | ~2.25 | ~$191 |
| **Year 1 (typical)** | ~2.25 + ~0.024 | ~$191 + $2 |

Deployment cost is paid once. Operating cost is negligible (~$0.64/month for typical usage).

---

**Last Updated:** May 24, 2026  
**SOL Price:** $85 USD  
**Exchange Rate Used:** 1 SOL = $85 USD
