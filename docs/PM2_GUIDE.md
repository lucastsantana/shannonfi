# PM2 Process Manager Guide

PM2 manages Shannon's Demon instances, handles auto-restart on crash, provides logging, and enables easy multi-instance orchestration.

## Installation

PM2 is already installed as a dev dependency. If missing:

```bash
npm install -g pm2
```

## Starting Instances

### Start all instances

```bash
pm2 start ecosystem.config.cjs
```

Or if already running:

```bash
pm2 restart ecosystem.config.cjs
```

### Start a specific instance

```bash
pm2 start hype-mb
```

### Start with custom config path

```bash
pm2 start ecosystem.config.js --env production
```

## Monitoring

### Dashboard (recommended)

```bash
pm2 monit
```

Real-time CPU, memory, restart count, uptime.

Navigation: ↑↓ to select, q to quit.

### Status overview

```bash
pm2 status
```

Quick snapshot (one-time output).

### Logs

```bash
pm2 logs                    # All instances, live
pm2 logs hype-mb            # One instance
pm2 logs --lines 100        # Last 100 lines (no follow)
pm2 logs --follow           # Follow in real-time
pm2 logs hype-mb --err      # Error output only
```

### Process info

```bash
pm2 show hype-mb            # Detailed info
pm2 info hype-mb            # Same as show
pm2 list                    # List all
```

## Starting/Stopping

### Start

```bash
pm2 start hype-mb
pm2 start ecosystem.config.cjs              # All
pm2 start ecosystem.config.cjs --only btc   # Only btc-binance
```

### Restart

```bash
pm2 restart hype-mb
pm2 restart ecosystem.config.cjs            # All
pm2 restart all
```

### Stop

```bash
pm2 stop hype-mb
pm2 stop all
pm2 stop ecosystem.config.cjs               # All
```

### Delete (remove from PM2)

```bash
pm2 delete hype-mb
pm2 delete all
```

### Kill PM2 daemon

```bash
pm2 kill                    # Stops all instances and exits PM2
```

## Auto-Start on Boot

Make instances auto-start when your machine reboots:

```bash
# Generate startup script
pm2 startup

# Output will show a command to run with sudo:
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup...

# Then save current state
pm2 save

# Verify
pm2 startup --status

# Later, to disable:
pm2 unstartup
```

## Logs Management

### Log locations

```
bot/logs/
├── hype-mb.log           # Standard output
├── hype-mb-error.log     # Error output
├── btc-binance.log
└── btc-binance-error.log
```

### View logs

```bash
# Follow live
tail -f bot/logs/hype-mb.log

# Last N lines
tail -50 bot/logs/hype-mb.log

# Search
grep "SELL_BASE" bot/logs/hype-mb.log

# Time range
grep "2026-05-30" bot/logs/hype-mb.log
```

### Clear logs

```bash
# Clear one instance's logs
pm2 log empty hype-mb

# Clear all
pm2 log empty all

# Manual deletion
rm bot/logs/*.log*
```

### Log rotation

PM2 doesn't auto-rotate logs by default. To auto-rotate:

```bash
npm install -g pm2-logrotate
pm2 install pm2-logrotate

# Configure
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 10
pm2 save
```

## Resource Limits

### Memory restart threshold

In `ecosystem.config.cjs`:

```javascript
{
  name: 'hype-mb',
  max_memory_restart: '500M',  // Restart if > 500MB
  // ...
}
```

### CPU monitoring

```bash
pm2 monit
# Watch CPU% column
```

If consistently high:
- Reduce `pollIntervalSeconds`
- Check logs for errors

## Health Checks

### Verify all running

```bash
pm2 status
# All should show "online"
```

### Check restart count

```bash
pm2 status
# ↺ column should be 0 (or low)
# High restart count = repeated crashes
```

### Check uptime

```bash
pm2 status
# uptime should be reasonable (weeks, months, years)
# Low uptime = frequent restarts
```

## Advanced Operations

### Watch for changes (auto-restart on file change)

```javascript
// In ecosystem.config.cjs
{
  name: 'hype-mb',
  watch: true,              // Watch for changes
  ignore_watch: ['node_modules', 'dist', 'logs'],
  // ...
}
```

Not recommended for production (will restart on every config change).

### Graceful shutdown timeout

```javascript
{
  name: 'hype-mb',
  kill_timeout: 5000,       // Wait 5s for graceful shutdown
  // ...
}
```

### Environment variables

```javascript
{
  name: 'hype-mb',
  env: {
    NODE_ENV: 'production',
    DEBUG: 'false',
  }
}
```

### Run multiple instances of same script

```javascript
{
  name: 'rebalancer',
  script: './bot.js',
  instances: 4,             // Run 4 copies (load balanced)
  exec_mode: 'cluster',
  // ...
}
```

Not applicable for Shannon's Demon (each instance has unique config).

## Troubleshooting

### Instance won't start

```bash
pm2 logs hype-mb --lines 100
# Check for errors

pm2 show hype-mb
# Check "exit code" (0 = success, non-zero = error)
```

**Common causes:**
- Config file not found: check `args: 'hype-mb'` matches config file name
- Credentials missing: `secret-tool lookup service mercadobitcoin key clientId`
- Port conflict: check nothing else using the port
- Permissions: check read access to config files

### Instance crashes repeatedly

```bash
# Check restart count
pm2 status | grep hype-mb
# If ↺ is increasing

# View error log
tail -100 bot/logs/hype-mb-error.log

# Test manually
DRY_RUN=true ./start-instance.sh hype-mb --once
```

### High memory usage

```bash
pm2 monit
# Watch MEM column

# Kill and restart
pm2 restart hype-mb

# Reduce cache size
# (May need to code change if leak)
```

### Logs filling disk

```bash
du -sh bot/logs/
# If > 1GB

# Clear logs
pm2 log empty all

# Or install logrotate
pm2 install pm2-logrotate
```

### Can't connect to PM2 daemon

```bash
# Daemon crashed
pm2 kill

# Restart
pm2 start ecosystem.config.cjs
```

## Backups

### Backup ecosystem state

```bash
cp ecosystem.config.cjs ecosystem.config.cjs.backup
```

### Backup logs

```bash
tar czf logs-backup-$(date +%Y%m%d).tar.gz bot/logs/
```

### Backup data

```bash
tar czf data-backup-$(date +%Y%m%d).tar.gz bot/data/
```

## Integration with Other Tools

### Monitor with external service

```bash
# Export PM2 monitoring to Prometheus
pm2 install pm2-prometheus

# Export to Datadog
pm2 install pm2-datadog-agent
```

### Slack notifications on crash

```bash
pm2 install pm2-slack-hook

pm2 set pm2-slack-hook slack_url https://hooks.slack.com/...
pm2 save
```

### Email notifications

```bash
pm2 install pm2-email
pm2 set pm2-email pm2_email_from email@example.com
pm2 set pm2-email pm2_email_to admin@example.com
pm2 save
```

## Best Practices

1. **Always use ecosystem file** — Don't start instances manually
2. **Save state** — Run `pm2 save` after config changes
3. **Monitor regularly** — Check `pm2 status` daily
4. **Review logs** — Search for errors periodically
5. **Auto-start** — Use `pm2 startup` for production
6. **Backup logs** — Archive old logs to avoid disk fill
7. **Test configs** — Dry-run before restarting in prod

## Reference

| Task | Command |
|------|---------|
| Start all | `pm2 start ecosystem.config.cjs` |
| Status | `pm2 status` |
| Logs | `pm2 logs hype-mb` |
| Restart one | `pm2 restart hype-mb` |
| Restart all | `pm2 restart all` |
| Stop one | `pm2 stop hype-mb` |
| Monitor | `pm2 monit` |
| Delete one | `pm2 delete hype-mb` |
| Save state | `pm2 save` |
| Auto-start | `pm2 startup` |
| Kill daemon | `pm2 kill` |

---

**Next**: See [MONITORING.md](./MONITORING.md) for debugging, or [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues.
