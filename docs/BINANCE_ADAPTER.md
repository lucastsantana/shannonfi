# Binance Adapter Architecture

## Overview

The Binance adapter brings international exchange support to Shannon's Demon. It implements the same `ExchangeAdapter` interface as Mercado Bitcoin, enabling multi-exchange strategies.

**File**: `bot/src/adapters/binance/`

## Design: Multi-File Pattern

Following the Mercado Bitcoin adapter pattern:

```
binance/
├── raw-types.ts    # Binance API response shapes (not exported)
├── client.ts       # HTTP client with HMAC-SHA256 signing
├── endpoints.ts    # REST endpoint wrappers
└── adapter.ts      # ExchangeAdapter implementation
```

## Key Differences from Mercado Bitcoin

### Authentication

**Mercado Bitcoin**: OAuth2 token (59-min TTL, refresh overhead)

**Binance**: HMAC-SHA256 signed requests
- No token management
- Signature on every authenticated request
- Faster auth setup (no token negotiation)
- 15-second timeout per request

### Order Fills

**Mercado Bitcoin**: 
- Returns minimal response from place order
- Poll order status in loop (up to 30s total)
- Market orders fill near-instantly but require polling

**Binance**:
- Returns full fill data synchronously
- No polling needed for market orders
- If order doesn't fill immediately, poll is a fallback (rarely needed)

### Symbol Format

| Exchange | Format | Example |
|----------|--------|---------|
| MB | `BASE-QUOTE` | `SOL-BRL`, `HYPE-BRL` |
| Binance | `BASEQUOTE` | `SOLBRL`, `HYPEBRL` |

The adapter handles this conversion internally.

### Quantity Precision

**Mercado Bitcoin**: Hardcoded 8 decimal places

**Binance**: Dynamic LOT_SIZE filter per symbol
- Fetched once from `GET /api/v3/exchangeInfo`
- Cached to avoid repeated API calls
- Example: `stepSize: "0.01"` means only 0.01 increments allowed
- Adapter floors quantity to nearest step automatically

## Implementation Details

### `client.ts` — HTTP Client

```typescript
class BinanceClient {
  signed<T>(method: 'GET' | 'POST', path: string, params?: {...}): Promise<T>
  get<T>(path: string, params?: {...}): Promise<T>
}
```

**Signing flow:**
1. Add `timestamp` to params
2. Sort params alphabetically
3. Build query string: `key1=val1&key2=val2&...`
4. Compute HMAC-SHA256: `sign(queryString, apiSecret)`
5. Append `signature` to query string
6. Send with `X-MBX-APIKEY` header

**Retry logic:**
- 3 retries with exponential backoff
- Retries on: network errors, 429 (rate limit)
- Does NOT retry on 401 (auth failed) or 400 (bad request)

### `endpoints.ts` — API Wrappers

| Method | Purpose |
|--------|---------|
| `getTickerPrice(symbol)` | Current price (public) |
| `getAccount()` | Balances & account info (signed) |
| `createOrder(params)` | Place market order (signed) |
| `getOrder(symbol, orderId)` | Order status (signed) |
| `getKlines(symbol, interval, limit)` | Candle data (public) |
| `getExchangeInfo(symbol?)` | Symbol metadata including LOT_SIZE (public) |

### `adapter.ts` — ExchangeAdapter Implementation

Implements 4 required methods:

#### `getPrice(): Promise<number>`
```typescript
// Fetch latest SOL/BRL price
GET /api/v3/ticker/price?symbol=SOLBRL
→ { symbol: "SOLBRL", price: "245.50" }
→ returns 245.50
```

Cost: 1 public API call (cached per cycle)

#### `getPortfolio(knownPrice?): Promise<Portfolio>`
```typescript
// Fetch account balances, use provided price if available
GET /api/v3/account (signed)
→ { balances: [{asset: "SOL", free: "1.50"}, {asset: "BRL", free: "500"}] }
→ Compute: SOL value = 1.50 × 245.50 = 368.25
→ Return Portfolio object
```

Cost: 1 signed API call (optional, uses knownPrice to skip)

#### `executeTrade(direction, brlAmount, portfolioBefore): Promise<TradeRecord>`
```typescript
// Place market order
POST /api/v3/order
  symbol: "SOLBRL"
  side: "BUY" or "SELL"
  type: "MARKET"
  quoteOrderQty: 500      // for BUY: spend BRL amount
  quantity: 2.04          // for SELL: sell SOL quantity

→ { executedQty: "2.04", cummulativeQuoteQty: "500.80", fills: [...] }
→ Record trade, compute fees, return TradeRecord
```

**Cost**: 1 signed API call (no polling needed)

**Fee handling:**
- Fees can be in BRL (preferred) or base asset
- If fee in base asset: convert to BRL using fill price
- Sum all fills to get total fee

#### `getCandles(countback, resolution): Promise<number[]>`
```typescript
// Fetch candle closes for volatility calculation
GET /api/v3/klines?symbol=SOLBRL&interval=1d&limit=30
→ [
    [1620000000, "200", "250", "190", "240", ...],  // candle 1
    [1620086400, "240", "300", "230", "290", ...],  // candle 2
    ...
  ]
→ Extract close prices (index 4): [240, 290, ...]
→ Sort by time, return in ascending order
```

Cost: 1 public API call (cached daily by VolatilityService)

## Lazy Evaluation & Cost Efficiency

Like the MB adapter, Binance adapter uses lazy evaluation to minimize API calls:

**Per-cycle request budget:**
```
No rebalance needed:
  1. getPrice()                    → 1 public call
  2. [drift check fails early]
  Total: 1 call

Rebalance triggered:
  1. getPrice()                    → 1 public call
  2. getPortfolio(knownPrice)      → 1 signed call (price reused)
  3. getCandles() [once per day]   → 1 public call (cached)
  4. createOrder()                 → 1 signed call
  5. getPortfolio() [post-trade]   → 1 signed call
  Total: ~5 calls (4 unique endpoints)
```

**API rate limits**: Binance allows 1200 requests/minute. At 5 min poll interval, worst case is 12 calls/min = 144 calls/hour = 3,456 calls/day. Well within limits.

## Configuration

See `bot/configs/btc-binance.yaml`:

```yaml
exchange: binance
symbol: BTC-BRL

binance:
  apiKey: "PLACEHOLDER"        # Loaded from keyring
  apiSecret: "PLACEHOLDER"     # Loaded from keyring
  apiBaseUrl: "https://api.binance.com"  # default, can override

# Standard strategy params (same as MB)
rebalanceThresholdBps: 100
maxSlippageBps: 100
pollIntervalSeconds: 300
```

## Error Handling

**401 Unauthorized**
- API key invalid or expired
- IP not whitelisted
- Time sync issue (timestamp too far off)
→ Check keyring, IP whitelist, and server time

**400 Bad Request**
- Invalid symbol (use `SOLBRL`, not `SOL-BRL`)
- Order quantity doesn't fit LOT_SIZE
- Insufficient balance
→ Check logs for exact error message

**429 Rate Limited**
- Too many requests to Binance
- Retry with exponential backoff (built-in)
→ If persistent, increase poll interval

## Testing

Dry-run test:
```bash
DRY_RUN=true ./start-instance.sh btc-binance --once
```

Should see:
```
[info] Using Binance adapter (BTC-BRL)
[info] Authenticated
[info] Price check ... basePriceBrl: "371678.00"
[info] Portfolio snapshot
[info] Single cycle complete
```

Live test (single cycle):
```bash
./start-instance.sh btc-binance --once
```

## Extending to Other Symbols

The adapter is generic to any `BASE-QUOTE` pair on Binance:

```yaml
symbol: HYPE-BRL    # Works automatically
symbol: BTC-USDT    # Or other pairs
symbol: ETH-USDC    # Extensible design
```

Just create a new config file with the desired symbol. The adapter:
1. Converts to Binance format (`HYPEBRL`, `BTCUSDT`, etc.)
2. Fetches LOT_SIZE for that symbol
3. Handles everything else identically

No code changes needed.

## Future Enhancements

- [ ] Post-only (maker) orders for lower fees
- [ ] Trailing stop losses
- [ ] Grid trading (multiple rebalances per cycle)
- [ ] Stop-loss orders if portfolio drops X%
- [ ] Binance US support (different fee structure)
- [ ] Futures/margin support (higher risk/reward)

---

**Next**: See [BINANCE_SETUP.md](./BINANCE_SETUP.md) for user-facing setup, or [ARCHITECTURE.md](./ARCHITECTURE.md) for the overall system.
