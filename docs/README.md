# Shannon's Demon Documentation

Welcome! This directory contains comprehensive documentation for running Shannon's Demon, a volatility-harvesting trading bot that maintains a 50/50 portfolio allocation and rebalances when drift exceeds a threshold.

## 📚 Documentation Structure

### Getting Started
- **[QUICKSTART.md](./QUICKSTART.md)** — Get running in 5 minutes (existing portfolio)
- **[SETUP.md](./SETUP.md)** — Complete setup from scratch

### Understanding the Strategy
- **[STRATEGY.md](./STRATEGY.md)** — How Shannon's Demon works (mathematical foundation)
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Codebase structure and components

### Configuration & Deployment
- **[CONFIGURATION.md](./CONFIGURATION.md)** — Config file format and parameters
- **[MULTI_INSTANCE.md](./MULTI_INSTANCE.md)** — Running multiple strategies in parallel
- **[PM2_GUIDE.md](./PM2_GUIDE.md)** — Using PM2 for process management

### Exchange Integrations
- **[MERCADO_BITCOIN.md](./MERCADO_BITCOIN.md)** — Mercado Bitcoin adapter setup & tuning
- **[BINANCE_ADAPTER.md](./BINANCE_ADAPTER.md)** — Binance adapter architecture
- **[BINANCE_SETUP.md](./BINANCE_SETUP.md)** — Binance setup from scratch

### Operations & Troubleshooting
- **[MONITORING.md](./MONITORING.md)** — Watching and debugging running instances
- **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** — Common issues and solutions
- **[BACKUP_RECOVERY.md](./BACKUP_RECOVERY.md)** — Data persistence and recovery

### Tax & Compliance
- **[BRAZILIAN_TAX.md](./BRAZILIAN_TAX.md)** — Lei 9.250/1995 compliance

## 🚀 Quick Navigation

**I want to...**

- ✅ **Start my existing portfolio** → [QUICKSTART.md](./QUICKSTART.md)
- ✅ **Set up from scratch** → [SETUP.md](./SETUP.md)
- ✅ **Understand how it works** → [STRATEGY.md](./STRATEGY.md)
- ✅ **Configure a new instance** → [CONFIGURATION.md](./CONFIGURATION.md)
- ✅ **Add a Binance strategy** → [BINANCE_SETUP.md](./BINANCE_SETUP.md)
- ✅ **Run multiple strategies** → [MULTI_INSTANCE.md](./MULTI_INSTANCE.md)
- ✅ **Deploy to production** → [PM2_GUIDE.md](./PM2_GUIDE.md)
- ✅ **Monitor running bots** → [MONITORING.md](./MONITORING.md)
- ✅ **Handle taxes in Brazil** → [BRAZILIAN_TAX.md](./BRAZILIAN_TAX.md)

## 📋 System Overview

```
Shannon's Demon Bot
├── Mercado Bitcoin (MB)
│   └── HYPE-BRL strategy (50/50 rebalancing)
│
└── Binance.com
    └── BTC-BRL strategy (50/50 rebalancing)

Features:
- Volatility-harvesting strategy (sell high, buy low automatically)
- Multi-exchange support (MB + Binance, extensible)
- Automatic rebalancing (when drift > threshold)
- Tax tracking (Brazilian Lei 9.250/1995)
- Cost basis tracking (AVCO method)
- Multi-instance orchestration (PM2)
- SQLite persistence + JSON backups
```

## 🔐 Security Checklist

- ✅ Credentials stored in GNOME Keyring (never on disk)
- ✅ API keys IP-whitelisted on exchange
- ✅ No withdrawals enabled on trading API keys
- ✅ Separate databases per instance (data isolation)
- ✅ Git ignores all sensitive files

## 📊 Current Instances

| Instance | Symbol | Exchange | Config | Data Dir |
|----------|--------|----------|--------|----------|
| hype-mb | HYPE-BRL | Mercado Bitcoin | `bot/configs/hype-mb.yaml` | `bot/data/hype-mb/` |
| btc-binance | BTC-BRL | Binance | `bot/configs/btc-binance.yaml` | `bot/data/btc-binance/` |

## 🎯 Default Parameters (Both Instances)

| Parameter | Value | Notes |
|-----------|-------|-------|
| **Rebalance Threshold** | 100 bps (1%) | Drift trigger for rebalancing |
| **Poll Interval** | 300s (5 min) | How often to check price |
| **Volatility Multiplier** | 1.25 | Adaptive threshold scaling |
| **Min Portfolio Value** | R$10 | Skip if below this |
| **Min Trade Size** | R$1 | Skip tiny trades |
| **Max Slippage** | 100 bps (1%) | Fill price tolerance |

## 📖 For New Users

1. Start with [QUICKSTART.md](./QUICKSTART.md) if you have an existing portfolio
2. Or follow [SETUP.md](./SETUP.md) for a complete walkthrough
3. Read [STRATEGY.md](./STRATEGY.md) to understand how the bot makes decisions
4. Check [CONFIGURATION.md](./CONFIGURATION.md) for parameter tuning

## 📖 For Developers

1. Read [ARCHITECTURE.md](./ARCHITECTURE.md) for codebase structure
2. See [BINANCE_ADAPTER.md](./BINANCE_ADAPTER.md) for how adapters work
3. Check `/bot/README.md` for technical implementation details

## 🆘 Support

- Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues
- Check [MONITORING.md](./MONITORING.md) to debug running instances
- Read the in-code comments in `bot/src/` for implementation details

---

**Last Updated:** 2026-05-30  
**Bot Version:** 2.0 (Multi-exchange, multi-instance)  
**Status:** Production Ready
