# Shannon's Demon

[Shannon's Demon](https://en.wikipedia.org/wiki/Entropy_and_second_law_of_thermodynamics) is a volatility-harvesting strategy: hold two assets in a fixed 50/50 ratio by value and rebalance whenever the ratio drifts. Each rebalance systematically sells the outperformer and buys the underperformer, generating excess return from volatility over time.

This repository provides a production-ready implementation running on **Mercado Bitcoin (SOL/BRL)**.

---

## Getting Started

A fully operational rebalancer for your Mercado Bitcoin account running the Shannon's Demon strategy on SOL/BRL — no smart contract deployment, no Solana toolchain, no blockchain fees.

**Key facts:**
- Funds stay in your Mercado Bitcoin account (no on-chain custody)
- Trades SOL/BRL natively via Mercado Bitcoin REST API (market orders)
- Automatic Brazilian tax compliance tracking (Lei 9.250/1995 Art. 21)
- Cooldown and trade history persists across restarts via local JSON files
- 5+ unit tests, TypeScript, dry-run mode, PM2 for continuous operation
- Mercado Bitcoin taker fees (~0.3%) apply per rebalance
- Volatility-adaptive rebalance threshold for regime-responsive timing

**Full documentation, setup guide, and configuration reference:** **[bot/README.md](./bot/README.md)**

**Quick start:**
```bash
cd bot
cp shannonfi.config.yaml.example shannonfi.config.yaml
npm install && npm run build
npm run setup-check     # validate credentials and account
DRY_RUN=true node dist/index.js --once   # test without real orders
bash start.sh           # run continuously with credentials from keyring
```

---

## Deployment

### Local (PM2)

**Prerequisites:** Node.js 20+, GNOME Keyring (WSL2/Linux)

1. Store credentials:
   ```bash
   secret-tool store service mercadobitcoin key clientId <your-mb-client-id>
   secret-tool store service mercadobitcoin key clientSecret <your-mb-client-secret>
   ```

2. Build and run:
   ```bash
   cd bot
   npm install && npm run build
   bash start.sh --once        # test dry-run first
   pm2 start ./start.sh --name shannonfi  # run continuously
   ```

3. Monitor:
   ```bash
   pm2 logs shannonfi
   pm2 show shannonfi
   ```

See **[bot/README.md](./bot/README.md)** for full setup guide, tuning options, and troubleshooting.

### GitHub Actions (Scheduled)

Deploy via **[`.github/workflows/rebalancer.yml`](./.github/workflows/rebalancer.yml)** — runs every 15 minutes.

**Required Secrets:**
- `MB_CLIENT_ID` — Mercado Bitcoin OAuth client ID
- `MB_CLIENT_SECRET` — Mercado Bitcoin OAuth client secret
- `SLACK_WEBHOOK_URL` (optional) — Slack failure notifications

**Configuration Variables:**
- `REBALANCE_THRESHOLD_BPS` (default: 100 = 1%)
- `MAX_SLIPPAGE_BPS` (default: 100 = 1%)
- `VOLATILITY_MULTIPLIER` (default: 1.5)
- `VOLATILITY_WINDOW_DAYS` (default: 30)
- `NEVER_EXCEED_EXEMPTION_LIMIT` (default: false)

---

## Dependency Map

```
Node.js 20
├── bot/package.json
│   ├── axios — HTTP client for Mercado Bitcoin REST API
│   ├── zod — Config schema validation
│   ├── winston — Structured logging
│   ├── @types/node, typescript — Build tools
│   └── vitest — Unit test framework
├── Mercado Bitcoin API v4
│   └── OAuth2 (client credentials) → SOL/BRL market orders, price candles
└── GNOME Keyring (local only)
    └── secret-tool lookup → store/retrieve credentials
```

---

## Resources

- [Shannon's Demon Strategy](https://en.wikipedia.org/wiki/Entropy_and_second_law_of_thermodynamics) — The volatility-harvesting concept
- [Mercado Bitcoin API](https://www.mercadobitcoin.com.br) — Official exchange
- [Lei 9.250/1995 Art. 21](https://www.gov.br/receita/pt-br) — Brazilian tax exemption for domestic crypto trading

---

**Last Updated:** 2026-05-26
