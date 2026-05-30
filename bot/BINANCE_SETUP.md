# Binance Adapter Setup Guide

This guide explains how to configure and run Shannon's Demon on Binance.com instead of Mercado Bitcoin.

## Why Binance?

Binance.com offers significant advantages over Mercado Bitcoin for this strategy:

- **Higher liquidity**: SOLBRL pair trades with tighter spreads
- **Lower fees**: Maker fees as low as 0.05% (vs. MB's typical 0.3%)
- **More trading pairs**: Expand to other assets (HYPEBRL, BTCBRL, etc.)
- **Tax considerations**: All Binance trades are taxable in Brazil (Lei 9.250 exemption doesn't apply)

## Prerequisites

1. **Binance.com account** (not Binance US or other regions)
   - Level 1 KYC: name, date of birth, country of residence
   - Level 2 (optional): document verification for higher withdrawal limits

2. **BRL funding method**
   - Set up a BRL deposit via PIX through a Binance partner bank (e.g., Capitual, Zro)
   - Small test deposit (R$100) to verify the process

3. **Linux machine** with GNOME Keyring installed (macOS/Windows: see alternatives below)

## Step 1: Create Binance API Key

1. Log in to [Binance.com](https://www.binance.com)
2. Go to **Account** → **API Management**
3. Click **Create API**
   - Label: "Shannon Demon" (or your preference)
   - Restrictions: ✓ Spot & Margin Trading
   - Do NOT check: Withdrawals (not needed for trading)
   - API Key: Carefully copy and store
   - Secret Key: Carefully copy and store
4. **Whitelist your IP address** (highly recommended):
   - From the API key settings, add your machine's public IP
   - You can find it at `curl https://ifconfig.me`

## Step 2: Store Credentials in GNOME Keyring

This is the **same method** MB uses. Store credentials securely:

```bash
# API Key (the longer alphanumeric string)
secret-tool store service binance key apiKey

# Paste your API key, press Enter, Ctrl+D

# API Secret (also a long string)
secret-tool store service binance key apiSecret

# Paste your secret, press Enter, Ctrl+D
```

Verify storage:
```bash
secret-tool lookup service binance key apiKey
secret-tool lookup service binance key apiSecret
```

Both should return your values without error.

## Step 3: Configure the Bot

Copy the example config and update it for Binance:

```bash
cp bot/shannonfi.config.yaml.example bot/shannonfi.config.yaml
```

Edit `bot/shannonfi.config.yaml`:

```yaml
# Change from mercadobitcoin to binance
exchange: binance

# Your trading pair (SOLBRL is the primary pair on Binance.com)
symbol: SOL-BRL

# Remove or comment out the mercadobitcoin section
# mercadobitcoin:
#   clientId: ...
#   clientSecret: ...

# Add your Binance credentials (secrets come from keyring at runtime)
binance:
  apiKey: ""        # Leave empty — loaded from keyring
  apiSecret: ""     # Leave empty — loaded from keyring
  # apiBaseUrl: https://api.binance.com   # default

# All other strategy parameters work identically
rebalanceThresholdBps: 100
useAdaptiveThreshold: true
thresholdVolatilityMultiplier: 1.5
dryRun: true        # Strongly recommended for first run!
```

**Important:** The `apiKey` and `apiSecret` fields in the YAML should be empty strings (`""`). Credentials are loaded from GNOME Keyring at runtime, **not** from the file. This prevents secrets from being committed to Git.

## Step 4: Run Setup Check

Verify connectivity and credentials:

```bash
npm run setup-check
```

Expected output:
```
=== Shannon's Demon — Setup Check ===

1. Loading and validating configuration...
   OK — Config loaded
   Exchange:   binance
   ...

2. Testing Binance API authentication...
   OK — Authenticated. Account Type: spot

3. Fetching balances...
   SOL balance: 0.000000 SOL
   BRL balance: R$0.00

4. Checking SOL-BRL market (recent candles)...
   OK — 7 daily candles. Latest close: R$245.50/SOL

✓ All checks passed. The bot is ready to run.
```

If credentials fail, check:
- Keyring values: `secret-tool lookup service binance key apiKey`
- Binance IP whitelist: Is your IP allowed?
- API key restrictions: Is "Spot & Margin Trading" enabled?

## Step 5: Run in Dry-Run Mode

Test a single rebalance cycle without real orders:

```bash
DRY_RUN=true npm run dev:once
```

This simulates the entire flow but logs all trades with status `DRY_RUN` instead of placing real orders.

Expected log output:
```
[DRY RUN] Would execute Binance trade
  direction: SELL_BASE
  brlAmount: 245.50
  symbol: SOL-BRL
```

## Step 6: Monitor Live (Single Cycle)

Place a single real trade to verify the setup:

```bash
node dist/index.js --once
```

The bot will:
1. Fetch the latest SOLBRL price
2. Check your portfolio balance
3. Decide whether to rebalance
4. If drift > threshold, place a live market order
5. Record the trade and exit

**Caution:** This places a real trade with real BRL. Start with a small position (e.g., R$500) until you're confident.

## Step 7: Run Continuously

Start the rebalancer in a loop (polls every 15 minutes by default):

```bash
node dist/index.js
```

Or use PM2 for automatic restart on failure:

```bash
pm2 start --name sol-binance dist/index.js
pm2 save
pm2 startup
```

## Multi-Instance Setup (Multiple Assets)

To run several strategies in parallel on different assets (SOL, HYPE, BTC), use a PM2 ecosystem file:

Create `ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [
    {
      name: 'sol-binance',
      script: 'bot/dist/index.js',
      args: '--config configs/sol-binance.yaml',
    },
    {
      name: 'hype-binance',
      script: 'bot/dist/index.js',
      args: '--config configs/hype-binance.yaml',
    },
  ],
};
```

For each instance:
1. Create a separate config file (`configs/sol-binance.yaml`, `configs/hype-binance.yaml`)
2. Set a **different dbPath** for each: `dbPath: ./data/sol-binance/shannonfi.db`
3. Adjust `symbol` (SOL-BRL, HYPE-BRL, etc.)

Then start all instances:
```bash
pm2 start ecosystem.config.cjs
pm2 monit        # Watch all processes
pm2 logs sol-binance  # Tail logs for one instance
```

## Tax Implications

Unlike Mercado Bitcoin, **all Binance trades are taxable in Brazil** (Lei 9.250 exemption is domestic-exchange only).

- Monthly sales are tracked in the database
- No R$35,000/month exemption applies
- Capital gains are taxable regardless of volume
- The `neverExceedExemptionLimit` config has no effect on Binance
- Keep records for your accountant at tax time

See `bot/src/core/tracker/tax.ts` for details.

## Troubleshooting

### 401 Unauthorized
- Credentials not in keyring: `secret-tool lookup service binance key apiKey`
- API key deleted/regenerated: Create a new one and update keyring
- IP whitelist: Verify your public IP is whitelisted in Binance API settings

### 400 Bad Request
- Invalid symbol: Verify `symbol: SOL-BRL` in config (Binance uses SOLBRL without hyphen internally)
- Order quantity precision: The bot fetches LOT_SIZE from exchange info; no manual precision needed

### "No candle data returned"
- Symbol not found: Double-check `symbol: SOL-BRL` and internet connectivity
- Binance maintenance: Check Binance status page

### Order fills slowly
- Binance market orders fill nearly instantly
- If delays occur, check order in Binance API logs or Spot Wallet

## Next Steps

1. **Backtest on Binance data**: Run `python backtest/shannon_backtest_coingecko.py` to validate strategy parameters before live trading
2. **Monitor your portfolio**: Track daily snapshots in `data/sol-binance/shannonfi.db` or JSON backups
3. **Review tax events**: Check `data/sol-binance/tax_events.json` monthly to plan for DARF payments

## Support

- **Binance API docs**: https://binance-docs.github.io/apidocs/
- **Binance spot trading guide**: https://www.binance.com/en/how-to-trade
- **Local time in BRT**: All timestamps are in Brasília time (UTC-3)

---

**Last Updated:** 2026-05-29
