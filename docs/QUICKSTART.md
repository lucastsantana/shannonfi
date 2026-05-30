# Quick Start — Shannon's Demon

Get your existing Shannon's Demon portfolio running in 5 minutes.

## Prerequisites

- ✅ Existing portfolio (HYPE-BRL on Mercado Bitcoin)
- ✅ Mercado Bitcoin credentials stored in GNOME Keyring
- ✅ Node.js 18+ and npm installed

## Start (3 Steps)

### 1. Build

```bash
cd /home/user/repos/shannonfi/bot
npm run build
```

### 2. Start via PM2

```bash
cd /home/user/repos/shannonfi
pm2 restart ecosystem.config.cjs
pm2 logs hype-mb
```

### 3. Verify

Watch the logs. You should see:
```
[info] Using Mercado Bitcoin adapter (HYPE-BRL, Lei 9.250/1995)
[info] Price check ... basePriceBrl: "333.75"
[info] Portfolio snapshot ... baseBalance: X.XXXXXX, brlBalance: Y.YY
```

✅ **Done!** Your bot is running and rebalancing every 5 minutes.

## Next Steps

- **Monitor**: `pm2 logs hype-mb` (watch in real-time)
- **Status**: `pm2 status` (see all instances)
- **Dashboard**: `pm2 monit` (real-time dashboard)
- **Add another strategy**: Read [MULTI_INSTANCE.md](./MULTI_INSTANCE.md)
- **Understand the strategy**: Read [STRATEGY.md](./STRATEGY.md)

## Common Commands

```bash
pm2 logs hype-mb              # Watch logs
pm2 show hype-mb              # Instance details
pm2 restart hype-mb           # Restart one instance
pm2 stop hype-mb              # Stop temporarily
pm2 delete hype-mb            # Remove from PM2
```

## Troubleshooting

**Bot won't start?**
```bash
npm run build          # Rebuild
DRY_RUN=true ./start-instance.sh hype-mb --once  # Test
```

**Missing credentials?**
```bash
secret-tool lookup service mercadobitcoin key clientId
secret-tool lookup service mercadobitcoin key clientSecret
```

**Check logs:**
```bash
pm2 logs hype-mb
cat bot/logs/hype-mb.log
```

---

For full documentation, see [docs/README.md](./README.md)
