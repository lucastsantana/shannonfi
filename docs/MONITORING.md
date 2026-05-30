# Monitoring & Debugging

## Real-Time Monitoring

### Dashboard (Recommended)

```bash
pm2 monit
```

Shows CPU, memory, restart count, uptime for all instances. Updates every 1-2 seconds.

### Status Check

```bash
pm2 status
```

Quick snapshot of all instances:
```
id │ name        │ status  │ uptime │ ↺ (restarts)
───┼─────────────┼─────────┼────────┼──────────────
0  │ hype-mb     │ online  │ 2m 30s │ 0
1  │ btc-binance │ online  │ 1m 15s │ 0
```

### Logs (Live Streaming)

```bash
# All instances
pm2 logs

# One instance
pm2 logs hype-mb

# Last N lines
pm2 logs --lines 50

# Follow (like tail -f)
pm2 logs --follow
```

## Log Levels

Logs show different detail based on `logLevel` config:

### `logLevel: info` (Recommended)

Shows price checks, rebalance decisions, trade execution:

```
[info] Price check {"exchange":"binance","basePriceBrl":"245.50"}
[info] Portfolio snapshot {"baseBalance":"1.50","brlBalance":"500.00"}
[info] No rebalance needed (price-only estimate) {"deviationBps":50,"thresholdBps":100}
```

### `logLevel: warn`

Only shows warnings and errors:

```
[warn] Slippage exceeded threshold {"expectedBrl":245.50,"fillBrl":247.20}
[warn] Portfolio below minimum size
[error] HTTP error 429 Rate limited
```

### `logLevel: debug`

Verbose internal state:

```
[debug] Cached LOT_SIZE {"symbol":"BTCBRL","stepSize":"0.00000001"}
[debug] Polling Binance order fill {"orderId":12345,"status":"PARTIALLY_FILLED"}
[debug] OAuth2 token refreshed {"expiresIn":3600}
```

## What to Look For

### Healthy Instance

```
[info] Price check {"exchange":"binance","basePriceBrl":"245.50"}
[info] Portfolio snapshot {"baseBalance":"1.50","totalValueBrl":"5000.00"}
[info] No rebalance needed (price-only estimate)
...
[info] Price check {"exchange":"binance","basePriceBrl":"245.75"}
```

✅ Cycles every poll interval, no errors

### Rebalancing Normally

```
[info] Price check {"exchange":"binance","basePriceBrl":"245.50"}
[info] Rebalance triggered {"direction":"SELL_BASE","brlAmount":"100.00"}
[info] Placing Binance order {"direction":"SELL_BASE","brlAmount":"100.00"}
[info] Binance order filled {"baseFilled":"0.408","brlFilled":"100.20","fillPrice":"245.59"}
[info] Tax event recorded (SELL_BASE) {"tradedVolumeBrl":"100.20","exempt":true}
[info] Portfolio snapshot ... (after trade)
```

✅ Trade completed, tax tracked, portfolio updated

### Auth Failure

```
[error] HTTP error 401 {"path":"/api/v3/account","msg":"API-key format invalid"}
[error] Fatal error {"error":"Request failed with status code 401"}
```

❌ **Fix:**
- Check credentials in keyring
- Check API key is active on exchange
- Check IP is whitelisted
- Check system time is synced

### Rate Limited

```
[warn] Error polling order status, will retry {"attempt":1}
[warn] Error polling order status, will retry {"attempt":2}
[info] Mercado Bitcoin order filled
```

✅ Normal — auto-retries with backoff

If persists repeatedly:
- Increase `pollIntervalSeconds`
- Check if other services calling same API
- Wait 15 minutes for rate limit window to reset

### Order Fill Slow

```
[info] Placing Binance order
[debug] Polling Binance order fill {"status":"PARTIALLY_FILLED","attempt":1}
[debug] Polling Binance order fill {"status":"PARTIALLY_FILLED","attempt":2}
[info] Binance order filled
```

✅ Normal — market orders sometimes take a few seconds

## Instance-Specific Monitoring

### Get detailed info

```bash
pm2 show hype-mb
```

```
┌──────────────────────┬────────────────────────────────┐
│ app name             │ hype-mb                        │
│ pid                  │ 12345                          │
│ uptime               │ 2h 30m                         │
│ restarts             │ 0                              │
│ watch mode           │ disabled                       │
│ exit code            │ 0                              │
│ cpu                  │ 0.5%                           │
│ memory               │ 95 MB                          │
│ status               │ online                         │
│ node env             │ production                     │
│ node version         │ v18.0.0                        │
│ script path          │ /bot/start-instance.sh         │
│ args                 │ hype-mb                        │
│ output log path      │ /bot/logs/hype-mb.log          │
│ error log path       │ /bot/logs/hype-mb-error.log    │
│ username             │ user                           │
│ created at           │ 2026-05-30 00:51:00 UTC        │
└──────────────────────┴────────────────────────────────┘
```

## Database Inspection

### Check trade count

```bash
sqlite3 bot/data/hype-mb/shannonfi.db "SELECT COUNT(*) FROM trades WHERE status='FILLED';"
```

### Recent trades

```bash
sqlite3 bot/data/hype-mb/shannonfi.db \
  "SELECT timestamp, direction, brl_amount_filled, fill_price FROM trades
   WHERE status='FILLED'
   ORDER BY timestamp DESC
   LIMIT 10;"
```

### Current cost basis

```bash
sqlite3 bot/data/hype-mb/shannonfi.db \
  "SELECT * FROM cost_basis WHERE asset='HYPE';"
```

### Monthly tax summary

```bash
sqlite3 bot/data/hype-mb/shannonfi.db \
  "SELECT month_brt, SUM(traded_volume_brl) as sales, SUM(realized_gain_brl) as gains, MAX(exempt)
   FROM tax_events
   GROUP BY month_brt;"
```

### Latest portfolio snapshot

```bash
sqlite3 bot/data/hype-mb/shannonfi.db \
  "SELECT * FROM portfolio_snapshots ORDER BY date_brt DESC LIMIT 1;"
```

## Troubleshooting

### Instance crashed (high restart count)

```bash
pm2 show btc-binance
# If ↺ (restarts) > 0
```

**Steps:**
1. Check error log: `tail -50 bot/logs/btc-binance-error.log`
2. Check main log: `pm2 logs btc-binance --lines 100`
3. Test manually: `DRY_RUN=true ./start-instance.sh btc-binance --once`
4. Check config: `cat bot/configs/btc-binance.yaml`
5. Check credentials: `secret-tool lookup service binance key apiKey`

### Instance consuming too much memory

```bash
pm2 monit
# If memory keeps growing
```

**Normal**: SQLite caches in memory, may be 100+ MB
**Abnormal**: Growing every minute

**Fix:**
```bash
pm2 restart btc-binance
```

If happens repeatedly, there may be a memory leak. Report with logs.

### Missing trades or old data

**Check which instance the config points to:**
```bash
grep dbPath bot/configs/hype-mb.yaml
# ./data/hype-mb/shannonfi.db

# Verify database exists and has data
ls -lh bot/data/hype-mb/shannonfi.db
sqlite3 bot/data/hype-mb/shannonfi.db "SELECT COUNT(*) FROM trades;"
```

**If database is empty but you expected trades:**
1. Check if instance was ever running: `pm2 logs hype-mb`
2. Check if rebalance threshold was too high: `grep rebalanceThreshold bot/configs/hype-mb.yaml`
3. Check portfolio size: `pm2 logs hype-mb | grep "Portfolio below minimum"`

## Performance Optimization

### Reduce log volume

```yaml
logLevel: warn    # Instead of info
```

Saves CPU/disk from parsing/writing logs.

### Check API quota usage

For Binance (1200 requests/min limit):
```bash
# Count API calls in last hour (rough estimate)
pm2 logs hype-mb --lines 1000 | grep -E "Price check|order filled|Portfolio" | wc -l
```

If > 1200 calls/min:
- Increase `pollIntervalSeconds`
- Disable `useAdaptiveThreshold` (saves candle fetches)

### Monitor disk usage

```bash
du -sh bot/data/*/
du -sh bot/logs/
```

If growing rapidly:
- `jsonRetentionDays: 7` (instead of 15) to keep less backup
- Archive old logs: `tar czf logs-backup.tar.gz bot/logs/ && rm bot/logs/*.log*`

## Health Checks

### Daily checklist

```bash
#!/bin/bash
echo "=== Instance Status ==="
pm2 status

echo "=== Recent Trades ==="
for dir in bot/data/*/; do
  instance=$(basename "$dir")
  count=$(sqlite3 "$dir/shannonfi.db" "SELECT COUNT(*) FROM trades WHERE timestamp > datetime('now', '-1 day');")
  echo "$instance: $count trades in last 24h"
done

echo "=== Disk Usage ==="
du -sh bot/data/ bot/logs/

echo "=== Error Check ==="
for log in bot/logs/*-error.log; do
  if [ -s "$log" ]; then
    echo "$log has errors:"
    tail -5 "$log"
  fi
done
```

---

**Next**: See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues, or [PM2_GUIDE.md](./PM2_GUIDE.md) for PM2 operations.
