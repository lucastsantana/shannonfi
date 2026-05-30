# Shannon's Demon Strategy

## What Is It?

Shannon's Demon is a **volatility-harvesting strategy** that automatically rebalances a 50/50 portfolio to profit from price oscillations. The bot sells after rallies and buys after declines, capturing the "volatility premium."

## The Core Idea

In a volatile market, prices oscillate. A simple 50/50 portfolio naturally captures gains from these swings:

```
Start:  SOL at R$400, Portfolio = R$5,000 SOL + R$5,000 BRL = R$10,000

Rally:  SOL rises to R$800
        Portfolio worth = R$5,000 × 2 + R$5,000 = R$15,000
        (Unbalanced: 67% SOL, 33% BRL)

Rebalance: Sell 50% of SOL to restore 50/50
        Now hold: R$7,500 SOL + R$7,500 BRL = R$15,000
        (Back to 50/50)

Decline:  SOL falls to R$400
        Portfolio worth = R$7,500 × 0.5 + R$7,500 = R$11,250
        (You locked in R$1,250 profit by selling high)

Total gain: R$1,250 (12.5%) vs. 0% if you just held SOL
```

## How the Bot Works

### 1. **Monitor Price** (Every 5 minutes)
- Fetch current SOL/BRL price
- Estimate current portfolio allocation from last known state

### 2. **Check Drift** (Lazy evaluation)
- Calculate: How far is current allocation from 50/50?
- If drift < threshold (1% default): skip, try again in 5 minutes
- If drift > threshold: proceed to rebalance

### 3. **Fetch Balances** (Only if drift exceeds threshold)
- Get actual account balances
- Calculate exact drift

### 4. **Decide Direction**
- If SOL > 50%: SELL SOL → buy BRL
- If SOL < 50%: BUY SOL → spend BRL

### 5. **Rebalance**
- Place market order for exact amount to hit 50/50
- Record trade, cost basis, tax event
- Sleep 5 minutes, repeat

## Mathematical Foundation

### Drift Formula

For a portfolio with value V, where S = SOL value and B = BRL value:

```
ratio = S / (S + B)
deviation = |ratio - 0.5|
```

Example: If SOL is worth R$5,100 and BRL is R$4,900:
```
ratio = 5100 / 10000 = 0.51
deviation = |0.51 - 0.5| = 0.01 = 1%
```

### Rebalance Trigger

When deviation > threshold (default 1%), rebalance occurs.

**Price move required to trigger rebalance:**

If threshold is 1% (100 bps):
- SOL must rise ~4% from last rebalance price, OR
- SOL must fall ~4% from last rebalance price

| Threshold | Price Rise to Trigger |
|-----------|----------------------|
| 0.5% | ~2% |
| 1% | ~4% |
| 2% | ~8% |
| 3% | ~13% |

### Volatility Premium

Each cycle captures a "volatility premium" proportional to the price swing:

```
gain ≈ (V / 4) × volatility²
```

Where V = total portfolio value, volatility = price move

Higher volatility → higher gains per cycle.

## Adaptive Thresholds

Instead of a fixed 1% threshold, the bot can adjust based on market volatility:

```
threshold = volatility × 1.25 (clamped to 0.5% - 5%)
```

**Why?** In calm markets, a 1% threshold wastes money on fees. In volatile markets, 1% might trigger too often.

Example:
- **Calm market** (0.3% daily volatility): threshold → 0.5% (floor)
- **Normal market** (1.5% daily volatility): threshold → 1.88%
- **Volatile market** (3% daily volatility): threshold → 3.75%

## Tax Efficiency (Brazil-Specific)

### Mercado Bitcoin (Domestic Exchange)

Lei 9.250/1995 Art. 21:
- Monthly SELL proceeds ≤ R$35,000: **exempt** from capital gains tax
- Above threshold: taxable, payment due last business day of next month

The `neverExceedExemptionLimit` config caps trades to stay under the exemption.

### Binance (Foreign Exchange)

No exemption applies. All trades are taxable regardless of volume.

## Cost Basis Tracking

The bot uses **AVCO** (Average Cost) method for tax reporting:

```
When you BUY:
  average_cost = (prior_total_cost + new_cost) / (prior_qty + new_qty)

When you SELL:
  realized_gain = proceeds - (quantity_sold × average_cost)
```

Example:
```
Buy 10 SOL at R$300 = R$3,000 avg cost
Buy 5 SOL at R$400 = Total R$5,000 for 15 SOL

Average cost = R$5,000 / 15 = R$333.33 per SOL

Sell 5 SOL at R$500 = R$2,500 proceeds
Realized gain = R$2,500 - (5 × R$333.33) = R$833.35
```

## Why This Works

1. **Automatic execution**: Removes emotion from "buy low, sell high"
2. **Cost efficiency**: Only rebalances when drift is meaningful (saves on fees)
3. **Captures volatility**: Profits from price swings regardless of direction
4. **Composable**: Works across multiple assets/exchanges simultaneously
5. **Tax-efficient** (on domestic exchanges): Uses exemption thresholds intelligently

## Limitations

1. **Needs volatility**: In a flat market, there's nothing to harvest
2. **Market fees eat profits**: If fees > volatility premium, you lose money
3. **Slippage risk**: Market orders don't always fill at the best price
4. **No directional bet**: You're 50/50 always, so you don't profit if one asset rallies permanently
5. **Rebalance lag**: By the time you sell, price may have changed

## Tuning Parameters

| Parameter | Default | Effect |
|-----------|---------|--------|
| **rebalanceThresholdBps** | 100 | Higher = less frequent trades, fewer fees but slower recovery to 50/50 |
| **thresholdVolatilityMultiplier** | 1.25 | Higher = wider threshold in volatile markets (trades less often) |
| **volatilityWindowDays** | 30 | Longer = smoother threshold (less reactive to short-term spikes) |
| **maxSlippageBps** | 100 | Tolerance for fill price vs. expected price |

## Example Scenario

```
Day 1:  BTC at R$100,000. Portfolio: 1 BTC + R$100,000 = R$200,000 (50/50)
Day 2:  BTC rallies to R$110,000. Portfolio: 1 BTC + R$100,000 = R$210,000 (52.4% BTC)
        Deviation: 2.4% > 1% threshold → REBALANCE
        Sell 0.048 BTC → get R$5,280
        New: 0.952 BTC + R$105,280 = R$210,000 (49.9/50.1 ✓)
Day 3:  BTC falls to R$90,000. Portfolio: 0.952 BTC + R$105,280 = R$191,360 (45% BTC)
        Deviation: 5% > 1% threshold → REBALANCE
        Buy 0.054 BTC (costs R$4,860)
        New: 1.006 BTC + R$100,420 = R$191,360 (50.3/49.7 ✓)
Day 4:  BTC back to R$100,000. Portfolio: 1.006 BTC + R$100,420 = R$200,820
        Profit: R$820 from volatile swings alone
```

---

**Next**: Read [CONFIGURATION.md](./CONFIGURATION.md) to tune parameters, or [ARCHITECTURE.md](./ARCHITECTURE.md) for implementation details.
