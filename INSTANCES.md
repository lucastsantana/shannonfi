# Shannon's Demon — Multi-Instance Setup

This document explains how to manage multiple bot instances running in parallel on different exchanges and assets.

## Current Setup

Your existing HYPE-BRL Mercado Bitcoin portfolio has been preserved and is now managed via PM2.

```
bot/
├── configs/
│   └── hype-mb.yaml              ← HYPE-BRL on Mercado Bitcoin (existing)
│   └── sol-binance.yaml          ← (Optional: SOL-BRL on Binance)
│
└── data/
    └── hype-mb/
        ├── shannonfi.db          ← Full trade history preserved
        ├── trade_history.json    ← 15-day rolling backup
        ├── portfolio_snapshots.json
        ├── tax_events.json
        └── cost_basis.json
```

## Start Your Existing Instance

### Option A: PM2 (Recommended)

```bash
# Build once
npm run build

# Start all instances defined in ecosystem.config.cjs
pm2 start ecosystem.config.cjs

# Watch status
pm2 monit

# Tail logs
pm2 logs hype-mb

# Save for auto-startup on reboot
pm2 save
pm2 startup
```

### Option B: Manual (One-Time Run)

```bash
npm run build
node bot/dist/index.js --config bot/configs/hype-mb.yaml
```

## Add a New Instance (Example: SOL-BRL on Binance)

### 1. Create Binance credentials

```bash
secret-tool store service binance key apiKey
# Paste API key, Ctrl+D

secret-tool store service binance key apiSecret
# Paste secret, Ctrl+D
```

### 2. Create config file

Copy this to `bot/configs/sol-binance.yaml`:

```yaml
exchange: binance
symbol: SOL-BRL

binance:
  apiKey: ""        # Loaded from keyring
  apiSecret: ""     # Loaded from keyring

rebalanceThresholdBps: 100
maxSlippageBps: 100
minPortfolioValueBrl: 200
minTradeSizeBrl: 20
pollIntervalSeconds: 900
minRebalanceIntervalSeconds: 7200

useAdaptiveThreshold: true
thresholdVolatilityMultiplier: 1.5
volatilityWindowDays: 30

dryRun: false
logLevel: info

dbPath: ./data/sol-binance/shannonfi.db
jsonRetentionDays: 15
```

### 3. Enable in ecosystem.config.cjs

Uncomment the `sol-binance` section in `ecosystem.config.cjs`:

```javascript
{
  name: 'sol-binance',
  script: './dist/index.js',
  cwd: './bot',
  args: '--config ../configs/sol-binance.yaml',
  // ... rest of config
},
```

### 4. Verify and start

```bash
npm run build

# Test dry-run first
DRY_RUN=true node bot/dist/index.js --config bot/configs/sol-binance.yaml

# Start both instances via PM2
pm2 restart ecosystem.config.cjs

# Verify
pm2 status
```

## PM2 Commands Reference

```bash
# Status and monitoring
pm2 status              # Show all instances and their status
pm2 monit               # Real-time dashboard
pm2 logs                # Stream all logs
pm2 logs hype-mb        # Stream logs for one instance

# Control instances
pm2 start ecosystem.config.cjs      # Start all
pm2 stop hype-mb                    # Stop one
pm2 restart ecosystem.config.cjs    # Restart all
pm2 delete ecosystem.config.cjs     # Remove all

# Persistence
pm2 save                # Save state to disk
pm2 startup             # Generate startup script for your OS
pm2 unstartup           # Remove startup script
```

## Data Directory Structure

Each instance has its own isolated data directory:

```
bot/data/
├── hype-mb/                    # HYPE-BRL on MB
│   ├── shannonfi.db
│   ├── shannonfi.db-shm        (SQLite WAL)
│   ├── shannonfi.db-wal        (SQLite WAL)
│   ├── trade_history.json
│   ├── portfolio_snapshots.json
│   ├── tax_events.json
│   └── cost_basis.json
│
└── sol-binance/                # SOL-BRL on Binance (optional)
    ├── shannonfi.db
    ├── ...
```

**Why separate data dirs?**
- Prevents cross-contamination of trade history
- Each asset has independent cost basis tracking
- Tax events are per-exchange (MB uses Lei 9.250 exemption; Binance doesn't)
- Easy to audit or migrate individual instances

## Logging

Logs are written to `bot/logs/` by PM2:

```
bot/logs/
├── hype-mb.log              # Standard output
├── hype-mb-error.log        # Error output
├── sol-binance.log
└── sol-binance-error.log
```

View logs:
```bash
pm2 logs hype-mb             # Stream in real-time
tail -f bot/logs/hype-mb.log # Manual tail
```

## Backup & Recovery

### Backup your data

```bash
# Backup all instance data
tar czf ~/shannonfi-backup-$(date +%Y%m%d).tar.gz bot/data/

# Just one instance
tar czf ~/hype-mb-backup-$(date +%Y%m%d).tar.gz bot/data/hype-mb/
```

### Restore from backup

```bash
# Extract to the same location
tar xzf ~/shannonfi-backup-20260529.tar.gz -C /home/user/repos/shannonfi/

# Restart bot
pm2 restart ecosystem.config.cjs
```

## Troubleshooting

### Instance won't start
```bash
pm2 logs hype-mb           # Check error messages
npm run setup-check         # Verify config and credentials
# (Note: setup-check reads from root config; manually set to instance config for testing)
```

### Duplicate trades or data corruption
- **Never run two instances with the same `dbPath`** — they will conflict
- Each config must have a unique `dbPath`
- Stop all instances before manually editing data

### Running out of disk space
- SQLite WAL files (`.db-shm`, `.db-wal`) grow during high-frequency trading
- JSON backups roll off after `jsonRetentionDays` (default 15)
- Monitor disk: `df -h bot/data/`

### Rebalancing too frequently or too rarely
Adjust these per-instance in the config file:
- `rebalanceThresholdBps` — higher = less frequent
- `useAdaptiveThreshold` — set to true for volatility-aware tuning
- `pollIntervalSeconds` — faster checks increase API costs

## Tax Considerations

### Mercado Bitcoin instances
- Lei 9.250/1995 applies
- Monthly SELL proceeds ≤ R$35,000 are exempt
- `neverExceedExemptionLimit: true` enforces the cap
- Tax events in `tax_events.json` track exemption status

### Binance instances
- All trades are taxable (no Lei 9.250 exemption)
- Monthly gains must be included on DARF
- `neverExceedExemptionLimit` is ignored
- Tax events still tracked for your records

## Next Steps

1. **Verify HYPE-MB is running:**
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 logs hype-mb
   ```

2. **Optional: Add a Binance instance** (see "Add a New Instance" above)

3. **Set up auto-startup** (survives reboot):
   ```bash
   pm2 save
   pm2 startup
   ```

4. **Regular backups**:
   ```bash
   # Daily backup script (add to crontab)
   0 2 * * * tar czf ~/backups/shannonfi-$(date +\%Y\%m\%d).tar.gz /home/user/repos/shannonfi/bot/data/
   ```

---

**Last Updated:** 2026-05-29
