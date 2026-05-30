# Multi-Instance Configuration

## Overview

Shannon's Demon supports running multiple strategies simultaneously on different exchanges and assets. Each instance:
- Runs independently with its own process
- Maintains separate database and trade history
- Has isolated cost basis and tax tracking
- Can be restarted without affecting others

## Example Setup

```
Shannon's Demon
├── hype-mb        HYPE-BRL on Mercado Bitcoin (existing)
├── btc-binance    BTC-BRL on Binance (running)
└── (future)       Add more strategies anytime
```

## Architecture

### Isolation Model

Each instance is completely isolated:

```
Instance 1: hype-mb
├── Config:  bot/configs/hype-mb.yaml
├── Database: bot/data/hype-mb/shannonfi.db
├── Logs:    bot/logs/hype-mb.log
└── PID:     12345

Instance 2: btc-binance
├── Config:  bot/configs/btc-binance.yaml
├── Database: bot/data/btc-binance/shannonfi.db
├── Logs:    bot/logs/btc-binance.log
└── PID:     12346
```

**Benefits:**
- One corrupted database doesn't affect others
- Can restart one without stopping others
- Different parameters per strategy
- Easy to add/remove instances

### Orchestration

PM2 manages all instances via a single ecosystem file:

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [
    { name: 'hype-mb', script: './start-instance.sh', args: 'hype-mb' },
    { name: 'btc-binance', script: './start-instance.sh', args: 'btc-binance' },
  ]
}
```

## Adding a New Instance

### Step 1: Create Config File

Copy the template for your exchange:

```bash
# For a new Binance strategy
cp bot/configs/btc-binance.yaml bot/configs/sol-binance.yaml
```

Edit the config:
```yaml
symbol: SOL-BRL                    # Change symbol
dbPath: ./data/sol-binance/...     # Change data dir (IMPORTANT!)
```

**CRITICAL**: Each instance MUST have a unique `dbPath`. Never share databases.

### Step 2: Update Ecosystem Config

Edit `ecosystem.config.cjs`:

```javascript
{
  name: 'sol-binance',
  script: './start-instance.sh',
  cwd: './bot',
  args: 'sol-binance',
  watch: false,
  autorestart: true,
  max_memory_restart: '500M',
  out_file: 'logs/sol-binance.log',
  error_file: 'logs/sol-binance-error.log',
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  merge_logs: true,
  env: { NODE_ENV: 'production' },
}
```

### Step 3: Test

```bash
cd /home/user/repos/shannonfi/bot
npm run build
DRY_RUN=true ./start-instance.sh sol-binance --once
```

### Step 4: Start

```bash
pm2 restart ecosystem.config.cjs
pm2 status
```

## Configuration Parameters (Per Instance)

Each instance can have different parameters:

```yaml
# hype-mb.yaml
rebalanceThresholdBps: 100
pollIntervalSeconds: 300

# sol-binance.yaml (could be different!)
rebalanceThresholdBps: 150     # More conservative
pollIntervalSeconds: 600       # Less frequent polling
```

**Why?** Different assets have different characteristics:
- Stable assets: higher threshold (less frequent trades)
- Volatile assets: lower threshold (capture more volatility)
- Lower liquidity: higher min trade size

## Managing Multiple Instances

### Start/Stop

```bash
# Start all
pm2 restart ecosystem.config.cjs

# Start one
pm2 start hype-mb

# Stop one
pm2 stop hype-mb

# Stop all
pm2 stop ecosystem.config.cjs
```

### Monitor

```bash
# Dashboard
pm2 monit

# Status
pm2 status

# Logs (all)
pm2 logs

# Logs (one instance)
pm2 logs btc-binance

# Full instance info
pm2 show btc-binance
```

### Restart

```bash
# Restart one (keep others running)
pm2 restart btc-binance

# Restart all
pm2 restart ecosystem.config.cjs

# Hard restart (kill + restart)
pm2 kill && pm2 start ecosystem.config.cjs
```

## Data Isolation

### Database Files

```
bot/data/
├── hype-mb/
│   ├── shannonfi.db          (trades, snapshots, tax, cost basis)
│   ├── shannonfi.db-shm      (SQLite WAL shared memory)
│   ├── shannonfi.db-wal      (SQLite Write-Ahead Log)
│   ├── trade_history.json    (15-day rolling backup)
│   ├── portfolio_snapshots.json
│   ├── tax_events.json
│   └── cost_basis.json
│
└── btc-binance/
    ├── shannonfi.db
    ├── ...
```

### Why Separate Databases?

1. **Isolation**: HYPE trades don't affect BTC database
2. **Atomic operations**: Each instance's trades are self-contained
3. **Scaling**: Can back up individual instances
4. **Recovery**: One corrupted DB doesn't take down all strategies
5. **Flexibility**: Can move instances to different machines

### Querying Across Instances

To see metrics across all instances:

```bash
# Sum all trades
sqlite3 bot/data/hype-mb/shannonfi.db "SELECT COUNT(*) FROM trades;" && \
sqlite3 bot/data/btc-binance/shannonfi.db "SELECT COUNT(*) FROM trades;"

# Total portfolio value
echo "HYPE-MB:"
sqlite3 bot/data/hype-mb/shannonfi.db "SELECT SUM(after_total_value) FROM trades WHERE status='FILLED';"
echo "BTC-BINANCE:"
sqlite3 bot/data/btc-binance/shannonfi.db "SELECT SUM(after_total_value) FROM trades WHERE status='FILLED';"
```

Or consolidate into a single DB (see [BACKUP_RECOVERY.md](./BACKUP_RECOVERY.md)).

## Resource Usage

### Memory

Each instance uses ~80-100MB RAM at startup (SQLite + Node runtime).

With 5 instances: ~500MB total.

Configure max memory per instance:
```javascript
max_memory_restart: '500M'  // Restart if exceeds 500MB
```

### CPU

Minimal — most time is sleeping between poll intervals.
- 1% CPU per instance during idle
- ~5% CPU during order execution
- ~2% CPU during price/balance fetch

### Disk

- SQLite DB: grows ~1-2MB per 1000 trades
- WAL files: temporary, cleaned up automatically
- JSON backups: 15 days rolling (old entries pruned)

10 instances with 1000 trades each: ~20-30MB total.

## Cross-Instance Coordination

Instances operate **independently** — no shared state.

If you need to coordinate (e.g., "don't trade if total portfolio > X"):
- Edit each instance config individually
- Or run a separate monitoring script

Example monitoring script:
```bash
#!/bin/bash
while true; do
  hype_val=$(sqlite3 bot/data/hype-mb/shannonfi.db \
    "SELECT SUM(after_total_value) FROM trades WHERE status='FILLED' LIMIT 1;")
  btc_val=$(sqlite3 bot/data/btc-binance/shannonfi.db \
    "SELECT SUM(after_total_value) FROM trades WHERE status='FILLED' LIMIT 1;")
  
  total=$((hype_val + btc_val))
  echo "Total portfolio: R$ $total"
  
  sleep 300
done
```

## Typical Workflows

### Add a New Strategy

```bash
# 1. Create config
cp bot/configs/template.yaml bot/configs/new-strategy.yaml
# 2. Edit with your parameters
# 3. Update ecosystem.config.cjs
# 4. Build and test
npm run build
DRY_RUN=true ./start-instance.sh new-strategy --once
# 5. Start
pm2 restart ecosystem.config.cjs
# 6. Monitor
pm2 logs new-strategy
```

### Pause an Instance

```bash
# Stop temporarily (data preserved)
pm2 stop btc-binance

# Later, resume
pm2 start btc-binance
```

### Remove an Instance

```bash
# Stop
pm2 stop btc-binance

# Remove from PM2
pm2 delete btc-binance

# Update ecosystem.config.cjs (remove the entry)

# Restart PM2
pm2 restart ecosystem.config.cjs

# Backup data (optional)
tar czf ~/backups/btc-binance-$(date +%Y%m%d).tar.gz bot/data/btc-binance/

# Delete data
rm -rf bot/data/btc-binance/
```

### Migrate Instance to Different Machine

```bash
# On source machine:
tar czf ~/btc-binance-backup.tar.gz bot/data/btc-binance/

# Copy to target machine:
scp ~/btc-binance-backup.tar.gz user@target:/tmp/

# On target machine:
cd /home/user/repos/shannonfi
tar xzf /tmp/btc-binance-backup.tar.gz
pm2 restart btc-binance
```

## Troubleshooting

### One instance won't start

```bash
# Check error
pm2 logs btc-binance

# Test directly
DRY_RUN=true ./start-instance.sh btc-binance --once

# Check config
cat bot/configs/btc-binance.yaml

# Check credentials
secret-tool lookup service binance key apiKey
```

### Instances interfering with each other

They shouldn't be — verify:
- Each has unique `dbPath`
- Each has unique `out_file` in ecosystem.config.cjs
- `pollIntervalSeconds` are staggered if desired (not required)

### Out of memory

```bash
# Increase per-instance limit
max_memory_restart: '1G'

# Monitor usage
pm2 monit
```

### Too many API calls

If hitting rate limits:
- Increase `pollIntervalSeconds` (poll less frequently)
- Disable `useAdaptiveThreshold` (skip candle fetches)
- Reduce number of instances

---

**Next**: See [PM2_GUIDE.md](./PM2_GUIDE.md) for PM2 operations, or [MONITORING.md](./MONITORING.md) to watch instances.
