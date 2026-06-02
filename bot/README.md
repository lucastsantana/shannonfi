# Bot Configuration Reference

See the root `README.md` for setup and deployment instructions.

---

## Config parameters

| Parameter | Default | Description |
|---|---|---|
| `exchange` | — | `mercadobitcoin` (required) |
| `symbol` | `SOL-BRL` | Trading pair, e.g. `HYPE-BRL` |
| `dbPath` | `./data/shannonfi.db` | SQLite database path |
| `rebalanceThresholdBps` | `100` | Minimum drift (bps) to trigger rebalance |
| `maxSlippageBps` | `100` | Maximum acceptable fill slippage |
| `minPortfolioValueBrl` | `200` | Skip rebalance if portfolio below this |
| `minTradeSizeBrl` | `20` | Skip rebalance if trade amount below this |
| `useAdaptiveThreshold` | `true` | Scale threshold with realized volatility |
| `thresholdVolatilityMultiplier` | `1.5` | MAD multiplier for adaptive threshold |
| `volatilityWindowDays` | `30` | Days of candles used to compute MAD |
| `pollIntervalSeconds` | `900` | Seconds between price checks |
| `minRebalanceIntervalSeconds` | `7200` | Minimum cooldown between rebalances |
| `neverExceedExemptionLimit` | `false` | Cap SELL trades at R$35k/month (Lei 9.250) |
| `dryRun` | `false` | Log trades without executing |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |
| `jsonRetentionDays` | `15` | Days of rolling JSON backup to keep |
| `telegram.chatId` | — | Telegram chat ID for notifications |

---

## Adaptive threshold

When `useAdaptiveThreshold: true`, the effective threshold is:

```
threshold_bps = clamp(MAD × multiplier × 10000, min=50, max=500)
```

Where MAD is the mean absolute daily return over `volatilityWindowDays`. Cached once per UTC day.

---

## Scripts

```bash
npm run build           # compile TypeScript
npm test                # run vitest suite
npm run scan            # run MB asset scanner (requires --config)
```

---

## Tax compliance (Lei 9.250/1995 Art. 21)

- SELL proceeds ≤ R$35,000/month → exempt from capital gains tax
- Set `neverExceedExemptionLimit: true` to skip SELLs that would push monthly total over the threshold
- Payment deadline (when taxable): last business day of following month
