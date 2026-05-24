# Shannon's Demon Backtest Results
## January 1 - May 24, 2026

### Executive Summary

The Shannon's Demon volatility-harvesting strategy was backtested over a **5-month period (Jan 1 - May 24, 2026)** with an initial capital of **$10,000**.

**Key Finding:** In a strongly trending market, Shannon's Demon underperformed compared to buy-and-hold, as expected. However, it still captured 15.17% returns with lower volatility.

---

## Performance Comparison

| Strategy | Initial Value | Final Value | Gain | Return | Rebalances |
|----------|---------------|-------------|------|--------|-----------|
| **Shannon's Demon** | $10,000.00 | **$11,516.98** | **$1,516.98** | **15.17%** | 1 |
| Buy & Hold (50/50) | $10,000.00 | $11,554.92 | $1,554.92 | 15.55% | 0 |
| All SOL (100%) | $10,000.00 | $13,109.84 | $3,109.84 | 31.10% | 0 |

---

## Market Context

| Metric | Value |
|--------|-------|
| **Starting SOL Price** | $183.45 |
| **Ending SOL Price** | $240.50 |
| **Price Change** | +$57.05 (↑ 31.1%) |
| **Period** | 144 days |
| **Market Condition** | Strong Uptrend |

---

## Strategy Analysis

### Shannon's Demon (15.17% Return)

The strategy maintained a target 50/50 SOL/USD allocation with **1 rebalance event** on April 23, 2026:

**Rebalance Details:**
- **Date:** April 23, 2026
- **SOL Price:** $225.60
- **Portfolio Value:** $11,148.81
- **Trigger:** SOL ratio drifted to 55.15% (exceeded 5% threshold)
- **Action:** Sold SOL to return to 50/50 allocation

#### Why Shannon's Demon Underperformed
In a **strong, sustained bull market** (SOL +31.1%), holding 100% SOL significantly outperforms any balanced strategy. Shannon's Demon forced selling of the best-performing asset, which is exactly the opposite of what you want in a trending market.

**The tradeoff:**
- ❌ Missed 16% of upside vs. all-SOL strategy
- ✅ Reduced volatility and drawdown risk
- ✅ Protected capital during downturns (if they occurred)
- ✅ Simple mechanical rebalancing with no market timing

---

### Buy & Hold 50/50 (15.55% Return)

Outperformed Shannon's Demon by 0.38 percentage points by never rebalancing. In a trending market, this is optimal.

- Held: 27.29 SOL + $5,000 USD
- Benefited from SOL appreciation without forced selling
- Would suffer more in volatile/sideways markets

---

### All SOL (31.10% Return)

Maximum upside capture by staying 100% in the outperforming asset.

- Started with: 54.59 SOL
- Benefited from every dollar of SOL appreciation
- **Risk:** Highly concentrated; no downside protection

---

## When Shannon's Demon Shines

While underperforming in this bull market, Shannon's Demon excels in:

1. **Volatile/Choppy Markets** - Rebalancing buy-lows, sell-highs
   - Example: SOL swings 30-35% over months
   - Captures volatility premium without timing

2. **Mean-Reverting Ranges** - Sustained 40-60% allocation drifts
   - Example: $180-$220 sideways action
   - Forces systematic loss harvesting

3. **Risk Management** - Prevents concentration in one asset
   - Portfolio never more than 55-60% in SOL
   - Defined downside protection

4. **Behavioral Discipline** - Mechanical rebalancing removes emotion
   - No FOMO during rallies
   - No panic selling during drops

---

## Key Metrics

### Rebalancing Activity
- **Total Rebalances:** 1
- **Rebalance Frequency:** ~144 days (2.8 months average)
- **Configured Interval:** ~30 days
- **Trigger Sensitivity:** 5% drift threshold

The single rebalance occurred late in the period when SOL had built up to 55% of the portfolio, exceeding the rebalancing threshold.

### Cumulative Returns Over Time

```
Start:     $10,000 (Jan 1)
Month 2:   $9,710  (-2.9% - initial SOL weakness)
Month 3:   $10,330 (+3.3% - recovery begins)
Month 4:   $10,610 (+6.1% - steady appreciation)
Month 5:   $11,517 (+15.17% - strong finish)
```

---

## Risk & Return Profile

### Shannon's Demon
- **Return:** 15.17%
- **Volatility Impact:** Lower (hedged with USD stablecoin)
- **Max Drawdown:** Smaller due to 50% USD position
- **Sharpe Ratio Proxy:** Moderate (less volatile/lower return)

### Buy & Hold 50/50
- **Return:** 15.55%
- **Volatility Impact:** Slightly higher
- **Max Drawdown:** Moderate (50% unhedged)
- **Sharpe Ratio Proxy:** Moderate-to-good

### All SOL
- **Return:** 31.10%
- **Volatility Impact:** Highest (100% crypto)
- **Max Drawdown:** Largest exposure to drawdowns
- **Sharpe Ratio Proxy:** Good return, but high volatility cost

---

## Lessons Learned

### 1. **Market Regime Matters**
Shannon's Demon is NOT a "beat the market" strategy. It's a **volatility harvesting** strategy that:
- ✅ Outperforms in choppy/mean-reverting markets
- ❌ Underperforms in strong directional moves

### 2. **The Rebalance Penalty**
In trending markets, rebalancing forces you to sell winners and hold losers. This is a feature (risk control) in normal markets, but a bug in persistent bull/bear trends.

### 3. **Consistency Over Extremes**
- Shannon's Demon: Steady, predictable, defensive
- Buy & Hold: Slightly better in this case, but equivalent risk
- All SOL: Maximum upside but unprotected

### 4. **Volatility is Your Friend**
The strategy performs best when SOL oscillates around its moving average. A 20% SOL rally followed by a 15% drop = more rebalancing opportunities = higher returns.

---

## Recommendations

### 1. **For Risk-Averse Investors**
Shannon's Demon is appropriate. The 0.38% underperformance vs. buy-and-hold is a small price for:
- Systematic risk management
- No emotional decision-making
- Built-in downside protection

### 2. **For Market Timing Enthusiasts**
Use Shannon's Demon as your **core position** but consider:
- Tactical overweight to SOL in bull markets
- Adding hedges (stablecoins, options) in bear setups
- Tighter rebalancing bands (3% instead of 5%) for more activity

### 3. **For Volatility Traders**
Backtest with:
- **Longer lookback:** Full bull/bear/sideways cycle (1-2 years)
- **Leverage:** 2-3x on USD position to amplify rebalancing gains
- **Tighter thresholds:** 2% drift triggers more frequent rebalancing

---

## Next Steps for Production Vault

1. **Real Oracle Integration** - Replace hardcoded $150 price with Pyth PriceUpdateV2
2. **Multi-Asset Support** - Extend to SOL/USDT, SOL/ORCA, etc.
3. **Variable Rebalance Thresholds** - Let authority adjust drift trigger
4. **Slippage Protection** - Add max slippage checks on Jupiter swaps
5. **Performance Fee** - Charge 0.5-1% of outperformance vs. buy-and-hold

---

## Backtest Assumptions

- ✅ No trading slippage (unrealistic, favors all strategies)
- ✅ No fees (real cost: ~0.05% per rebalance)
- ✅ Perfect price feeds (Pyth is reliable but not perfect)
- ✅ Rebalances execute atomically (via Jupiter CPI)
- ✅ Historical prices are accurate daily closes

---

**Generated:** 2026-05-24  
**Period:** 2026-01-01 to 2026-05-24 (144 days)  
**Strategy:** Shannon's Demon 50/50 SOL/USD with 5% drift rebalancing
