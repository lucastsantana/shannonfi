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

## Resources

- [Shannon's Demon Strategy](https://en.wikipedia.org/wiki/Entropy_and_second_law_of_thermodynamics) — The volatility-harvesting concept
- [Mercado Bitcoin API](https://www.mercadobitcoin.com.br) — Official exchange
- [Lei 9.250/1995 Art. 21](https://www.gov.br/receita/pt-br) — Brazilian tax exemption for domestic crypto trading

---

**Last Updated:** 2026-05-26
