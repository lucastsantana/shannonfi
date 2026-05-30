# Quick Start — Shannon's Demon Multi-Instance

Your HYPE-BRL Mercado Bitcoin portfolio has been preserved and reorganized for multi-instance management.

## Start Your Existing Instance Now

```bash
cd /home/user/repos/shannonfi/bot

# Build once
npm run build

# Option A: Via PM2 (Recommended — survives reboot, auto-restart)
pm2 start ecosystem.config.cjs
pm2 logs hype-mb            # Watch logs
pm2 monit                   # Dashboard

# Option B: Direct command (for testing)
./start-instance.sh hype-mb
```

Your portfolio history is preserved in: `bot/data/hype-mb/shannonfi.db`

## Add a Binance Instance (Optional)

### 1. Store Binance credentials

```bash
secret-tool store service binance key apiKey
# Paste your Binance API key, then Ctrl+D

secret-tool store service binance key apiSecret
# Paste your Binance API secret, then Ctrl+D
```

### 2. Create the config

```bash
cd /home/user/repos/shannonfi/bot
cp configs/sol-binance.yaml.template configs/sol-binance.yaml
# Edit configs/sol-binance.yaml if you want custom parameters
```

### 3. Enable in PM2

Uncomment the `sol-binance` section in `/home/user/repos/shannonfi/ecosystem.config.cjs`

### 4. Start

```bash
pm2 restart ecosystem.config.cjs
pm2 logs sol-binance
```

## File Structure

```
/home/user/repos/shannonfi/
├── bot/
│   ├── dist/                    ← Compiled TypeScript
│   ├── src/
│   ├── configs/
│   │   ├── hype-mb.yaml         ← HYPE-BRL on Mercado Bitcoin
│   │   ├── sol-binance.yaml     ← (Optional) SOL-BRL on Binance
│   │   └── sol-binance.yaml.template
│   ├── data/
│   │   └── hype-mb/
│   │       ├── shannonfi.db     ← Your trade history
│   │       ├── trade_history.json
│   │       ├── tax_events.json
│   │       └── cost_basis.json
│   ├── logs/                    ← PM2 logs
│   ├── start-instance.sh        ← Wrapper: loads credentials from keyring
│   └── package.json
│
├── ecosystem.config.cjs          ← PM2 configuration for all instances
├── INSTANCES.md                  ← Full documentation
├── QUICK_START.md                ← This file
├── BINANCE_SETUP.md              ← Binance-specific setup guide
└── bot/BINANCE_SETUP.md
```

## PM2 Commands

```bash
pm2 status              # See all instances
pm2 logs hype-mb        # Stream logs for one instance
pm2 restart ecosystem.config.cjs  # Restart all
pm2 stop hype-mb        # Stop one
pm2 save                # Save state (survives reboot)
pm2 startup             # Auto-start on boot
```

## Verify Everything Works

```bash
# Test your existing HYPE-MB instance
DRY_RUN=true ./start-instance.sh hype-mb --once

# Expected output includes:
# "Using Mercado Bitcoin adapter (HYPE-BRL, Lei 9.250/1995)"
# "Opening SQLite database ... hype-mb/shannonfi.db"
# "Restored rebalance state from history"
```

## Next Steps

1. ✅ **HYPE-MB is ready** — start via PM2
2. (Optional) **Add SOL-BRL on Binance** — follow "Add a Binance Instance" above
3. **Monitor** — use `pm2 logs` or `pm2 monit`
4. **Backup** — `tar czf backup-$(date +%Y%m%d).tar.gz bot/data/`

---

For more details, see:
- `INSTANCES.md` — comprehensive multi-instance guide
- `BINANCE_SETUP.md` — Binance-specific configuration
- `bot/README.md` — bot architecture and tuning

**Data is safe** — Your HYPE-BRL history is in `bot/data/hype-mb/` and survives restarts.
