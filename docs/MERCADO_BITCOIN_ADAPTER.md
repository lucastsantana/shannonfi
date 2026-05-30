# Mercado Bitcoin Adapter Architecture

## Overview

The Mercado Bitcoin adapter is the original exchange integration for Shannon's Demon. It implements the same `ExchangeAdapter` interface as Binance, enabling consistent multi-exchange strategy execution.

**File**: `bot/src/adapters/mercadobitcoin/`

## Design: Multi-File Pattern

Following a clean separation of concerns:

```
mercadobitcoin/
├── raw-types.ts    # MB API response shapes (not exported)
├── client.ts       # HTTP client with OAuth2 token management
├── endpoints.ts    # REST endpoint wrappers
└── adapter.ts      # ExchangeAdapter implementation
```

## Key Characteristics

### Authentication

**OAuth2 Client Credentials Flow**:
- Client ID + Client Secret → access token (1-hour TTL)
- Token cached with 60-second refresh buffer
- No per-request signing overhead
- Automatic refresh on token expiry

**vs. Binance**: MB uses token-based auth; Binance uses request signing. MB requires token management; Binance doesn't.

### Order Fills

**Polling-Based** (unlike Binance's synchronous fills):
- Place order → get minimal response with `orderId`
- Poll order status every 3 seconds
- Max 10 attempts (30 seconds total)
- Per-attempt try-catch: transient 400s don't abort

**Why?** MB market orders fill near-instantly but require status confirmation.

### Symbol Format

MB uses hyphenated pairs:
- Format: `BASE-QUOTE`
- Examples: `SOL-BRL`, `HYPE-BRL`, `BTC-BRL`
- No internal conversion needed (matches config format)

### Quantity Precision

**Fixed 8 Decimal Places**:
- All SOL/base asset quantities floored to 8 decimals
- `brlToBase(brlAmount, price, 8)` in `math.ts`
- Works for all MB trading pairs
- No dynamic precision lookup needed (simpler than Binance)

## Implementation Details

### `client.ts` — OAuth2 HTTP Client

```typescript
class MbClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  
  private async ensureToken(): Promise<string>
  async get<T>(path: string, params?: {...}): Promise<T>
  async getPublic<T>(path: string, params?: {...}): Promise<T>
  async post<TReq, TRes>(path: string, body: TReq): Promise<TRes>
}
```

**Token Management:**
```typescript
// Refresh if within 60s of expiry
if (Date.now() < tokenExpiresAt - 60_000) {
  return cachedToken;
}

// Otherwise fetch new token
POST /oauth2/token
  grant_type=client_credentials
  scope=global
  client_id=...
  client_secret=...
→ { access_token: "...", expires_in: 3600 }

// Store with refresh buffer
tokenExpiresAt = Date.now() + (expires_in - 60) * 1000
```

**Authenticated requests:**
- All `get()` and `post()` calls run `ensureToken()` first
- Bearer token added to Authorization header
- Automatic retry on 429 (rate limited)

**Public requests:**
- `getPublic()` skips token management
- Used for price/candle fetches (no auth needed)

### `endpoints.ts` — API Wrappers

| Method | Purpose | Auth |
|--------|---------|------|
| `getAccountId()` | Fetch first account's ID | ✅ signed |
| `getBalances(accountId)` | Get SOL + BRL balances | ✅ signed |
| `createOrder(accountId, request)` | Place market order | ✅ signed |
| `getOrder(accountId, orderId)` | Poll order status | ✅ signed |
| `getOrders(accountId, limit)` | List recent orders | ✅ signed |
| `getCandles(countback, resolution)` | Candle data for volatility | ❌ public |

**Account ID Lookup:**
```typescript
GET /accounts (signed)
→ [{ id: "12345", name: "Primary", type: "trading", ... }]
// Returns first account; MB users typically have one
```

**Order Creation:**
```typescript
// For BUY: specify BRL amount to spend
POST /accounts/{id}/{symbol}/orders
  type: "market"
  side: "buy"
  cost: 500.00        // Spend R$500 to buy SOL
  externalId: uuid

// For SELL: specify SOL quantity to sell
POST /accounts/{id}/{symbol}/orders
  type: "market"
  side: "sell"
  qty: "2.50000000"   // Sell 2.5 SOL
  externalId: uuid
```

**Symbol Parameter:**
```typescript
// Endpoint path includes symbol
POST /accounts/{id}/SOL-BRL/orders
```

### `adapter.ts` — ExchangeAdapter Implementation

Implements 4 required methods:

#### `getPrice(): Promise<number>`
```typescript
// Fetch latest SOL/BRL price via public candle endpoint
GET /candles?symbol=SOL-BRL&resolution=1d&to=now&countback=1
→ { t: [1620000000], c: ["400.50"], ... }
→ returns 400.50

// Note: Uses close of most recent 1-day candle
// Not a real-time tick; refreshes with new candle every day
```

Cost: 1 public API call (no auth overhead)

#### `getPortfolio(knownPrice?): Promise<Portfolio>`
```typescript
// Fetch account ID (cached after first call)
GET /accounts
→ accounts[0].id = "12345"

// Fetch balances with auth
GET /accounts/12345/balances
→ [
    { symbol: "SOL", available: "10.50000000", onHold: "0" },
    { symbol: "BRL", available: "5000.00", onHold: "0" }
  ]

// Compute portfolio
SOL value = 10.5 × (knownPrice ?? getPrice())
Portfolio = SOL value + BRL balance
Return Portfolio object
```

Cost: 1 signed API call if knownPrice supplied, 2 if not (balance + price fetch)

#### `executeTrade(direction, brlAmount, portfolioBefore): Promise<TradeRecord>`
```typescript
// Place market order
POST /accounts/12345/SOL-BRL/orders
  type: "market"
  side: "buy" or "sell"
  cost: 500.00 (for BUY)
  qty: "2.50000000" (for SELL)
  externalId: uuid
→ { orderId: "54321", status: "created" }

// Poll order fill (up to 30s)
GET /accounts/12345/SOL-BRL/orders/54321
→ {
    status: "filled",
    filledQty: "2.50000000",
    avgPrice: 200.00,
    cost: 500.00,      // BRL spent
    fee: "0.50"        // MB taker fee in BRL
  }

// Return TradeRecord with fill details
```

Cost: 1 signed call to place order + up to 10 polling calls

**Polling Logic:**
```typescript
for (let attempt = 0; attempt < 10; attempt++) {
  sleep(3000);  // 3s between attempts
  try {
    order = getOrder();
    if (terminal_status) return order;  // filled, cancelled, etc
  } catch (err) {
    if (last_attempt) throw;  // Give up after 10 attempts
    // Otherwise retry
  }
}
// Final fallback fetch after loop
```

#### `getCandles(countback, resolution): Promise<number[]>`
```typescript
// Fetch candle closes for volatility calculation
GET /candles?symbol=SOL-BRL&resolution=1d&to=now&countback=30
→ {
    t: [ts1, ts2, ..., ts30],      // Timestamps
    c: ["200", "205", ..., "400"]  // Close prices
  }

// Extract and sort closes ascending by timestamp
→ [200, 205, ..., 400]
```

Cost: 1 public API call (cached daily by VolatilityService)

## Lazy Evaluation & Cost Efficiency

Like the Binance adapter, MB uses lazy evaluation:

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
  5. pollOrderFill()               → up to 10 polling calls
  6. getPortfolio() [post-trade]   → 1 signed call
  Total: ~15 API calls worst-case (12 unique endpoints)
```

**API rate limits**: MB allows 60 requests/60 seconds. At 5 min poll interval, worst case is 12 calls/5min = 144 calls/hour = 3,456 calls/day. Well within limits.

## Configuration

See `bot/configs/hype-mb.yaml`:

```yaml
exchange: mercadobitcoin
symbol: HYPE-BRL

mercadobitcoin:
  clientId: "PLACEHOLDER"        # Loaded from keyring
  clientSecret: "PLACEHOLDER"    # Loaded from keyring
  apiBaseUrl: "https://api.mercadobitcoin.net/api/v4"  # default

# Standard strategy params (same as Binance)
rebalanceThresholdBps: 100
maxSlippageBps: 100
pollIntervalSeconds: 300

# MB-specific tax feature
neverExceedExemptionLimit: true  # Lei 9.250/1995 cap
```

## Error Handling

**401 Unauthorized**
- Client credentials invalid
- Tokens revoked/regenerated
→ Check keyring: `secret-tool lookup service mercadobitcoin key clientId`

**400 Bad Request**
- Invalid symbol (use `SOL-BRL`, not `SOLBRL`)
- Account ID changed
- Malformed order request
→ Check logs for exact error message

**429 Rate Limited**
- Too many requests to MB
- Retry with exponential backoff (built-in)
→ If persistent, increase poll interval

**Transient 400s During Polling**
- MB occasionally returns 400 for a moment
- Per-attempt try-catch handles this
- Retries automatically
→ Normal behavior, no action needed

## Testing

Dry-run test:
```bash
DRY_RUN=true ./start-instance.sh hype-mb --once
```

Should see:
```
[info] Using Mercado Bitcoin adapter (HYPE-BRL, Lei 9.250/1995)
[info] Authenticated
[info] Price check ... basePriceBrl: "333.75"
[info] Portfolio snapshot
[info] Single cycle complete
```

Live test (single cycle):
```bash
./start-instance.sh hype-mb --once
```

## Comparison: MB vs Binance

| Aspect | Mercado Bitcoin | Binance |
|--------|---|---|
| **Auth** | OAuth2 token (60-min TTL) | HMAC-SHA256 (per-request) |
| **Token Management** | Auto-refresh on expiry | No token management |
| **Order Fills** | Poll for 30s max | Synchronous (no polling) |
| **Symbol Format** | `SOL-BRL` | `SOLBRL` |
| **Quantity Precision** | Fixed 8 decimals | Dynamic LOT_SIZE filter |
| **Poll Frequency** | Every 3s (10 attempts) | 1s fallback only |
| **Tax Feature** | Lei 9.250 exemption cap | N/A (foreign exchange) |
| **Min Trade Size** | R$1 (testing) | R$20 (typically) |
| **Typical Spread** | Tighter | Wider |
| **Liquidity** | Lower | Higher |

## Performance Characteristics

**Mercado Bitcoin Adapter:**
- Latency: ~1-2s per API call (Brazil-based servers)
- Throughput: 60 req/min limit (conservative)
- Polling: Most orders fill by 2nd attempt (6s total)
- Token overhead: ~10ms per token refresh (happens ~1/hour)

**Best For:**
- Brazilian-based traders (low latency)
- Small portfolios (Lei 9.250 exemption useful)
- Tax-efficient trading (automated exemption tracking)
- Lower-frequency strategies (enough headroom in rate limits)

## Future Enhancements

- [ ] Post-only (maker) orders for lower fees
- [ ] Order cancellation/replacement logic
- [ ] Real-time WebSocket updates (currently polling)
- [ ] Support for other MB trading pairs (BTC-BRL, ETH-BRL, etc.)
- [ ] Trailing stop orders
- [ ] Grid trading (multiple rebalances per cycle)

## Development Notes

### Why Polling Instead of Order Hooks?

MB doesn't expose WebSocket order updates, so polling is necessary. The fixed 3s interval + 10-attempt limit provides:
- Certainty of order status within 30 seconds
- Protection against transient network hiccups
- Reasonable balance between latency and API cost

### Why Token Caching?

OAuth2 token refresh adds ~10ms per request without caching. Caching saves ~100ms per hour (60 refreshes). More importantly, it avoids unnecessary OAuth server roundtrips.

### Why Account ID Caching?

Account ID never changes for a credential pair, so caching eliminates one API call per cycle. Traded for simplicity: if a user adds accounts, they must restart the bot.

---

**Next**: See [BINANCE_ADAPTER.md](./BINANCE_ADAPTER.md) for comparison, [STRATEGY.md](./STRATEGY.md) for how both adapters implement the same logic, or [CONFIGURATION.md](./CONFIGURATION.md) for tuning parameters.
