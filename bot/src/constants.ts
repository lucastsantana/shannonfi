// Ported from programs/shannonfi/src/constants.rs where noted.

export const BPS_DENOMINATOR = 10_000;
export const TARGET_ALLOCATION_BPS = 5_000;   // 50%

// ─── Coinbase ─────────────────────────────────────────────────────────────────
export const COINBASE_PRODUCT_ID = 'SOL-USD';
export const COINBASE_API_BASE = 'https://api.coinbase.com';
export const COINBASE_BROKERAGE_PATH = '/api/v3/brokerage';
export const COINBASE_JWT_TTL_SECONDS = 120;
export const COINBASE_PRIVATE_RATE_LIMIT_RPS = 10;
export const COINBASE_BACKTEST_GRANULARITY = 'ONE_DAY' as const;
export const COINBASE_BACKTEST_MAX_CANDLES = 300;

// ─── Mercado Bitcoin ──────────────────────────────────────────────────────────
export const MB_SYMBOL = 'SOL-BRL';
export const MB_API_BASE = 'https://api.mercadobitcoin.net/api/v4';
export const MB_TOKEN_REFRESH_BUFFER_MS = 60_000;

// ─── Shared trading ───────────────────────────────────────────────────────────
export const DEFAULT_REBALANCE_THRESHOLD_BPS = 100;  // 1%
export const MAX_SLIPPAGE_BPS = 100;

// Fill polling — Coinbase (market orders may take a few seconds)
export const FILL_POLL_INTERVAL_MS = 2_000;
export const FILL_POLL_MAX_ATTEMPTS = 30;            // 60s total

// Fill polling — Mercado Bitcoin (SOL-BRL market orders fill near-instantly)
export const MB_FILL_POLL_INTERVAL_MS = 3_000;
export const MB_FILL_POLL_MAX_ATTEMPTS = 10;         // 30s total

// ─── Volatility-adaptive threshold ───────────────────────────────────────────
export const DEFAULT_VOLATILITY_MULTIPLIER = 1.5;
export const DEFAULT_VOLATILITY_WINDOW_DAYS = 30;
export const MIN_ADAPTIVE_THRESHOLD_BPS = 50;        // 0.5% floor
export const MAX_ADAPTIVE_THRESHOLD_BPS = 500;       // 5.0% ceiling

// ─── Brazilian tax constants ──────────────────────────────────────────────────
export const BR_MONTHLY_EXEMPTION_LIMIT_BRL = 35_000;
export const BR_EXEMPTION_SAFE_BUFFER_BRL = 350;     // 1% safety buffer
export const BR_EFFECTIVE_LIMIT_BRL =
  BR_MONTHLY_EXEMPTION_LIMIT_BRL - BR_EXEMPTION_SAFE_BUFFER_BRL; // 34,650

// Brazilian national holidays 2026–2027 (YYYY-MM-DD). Used to compute payment deadlines.
// Source: Lei 9.093/1995.
export const BR_HOLIDAYS = new Set<string>([
  // 2026
  '2026-01-01', // Ano Novo
  '2026-02-16', // Carnaval (segunda)
  '2026-02-17', // Carnaval (terça)
  '2026-04-03', // Sexta-feira Santa
  '2026-04-21', // Tiradentes
  '2026-05-01', // Dia do Trabalho
  '2026-06-04', // Corpus Christi
  '2026-09-07', // Independência
  '2026-10-12', // N. Sra. Aparecida
  '2026-11-02', // Finados
  '2026-11-15', // Proclamação da República
  '2026-11-20', // Consciência Negra
  '2026-12-25', // Natal
  // 2027
  '2027-01-01', // Ano Novo
  '2027-03-01', // Carnaval (segunda)
  '2027-03-02', // Carnaval (terça)
  '2027-03-26', // Sexta-feira Santa
  '2027-04-21', // Tiradentes
  '2027-05-01', // Dia do Trabalho
  '2027-05-27', // Corpus Christi
  '2027-09-07', // Independência
  '2027-10-12', // N. Sra. Aparecida
  '2027-11-02', // Finados
  '2027-11-15', // Proclamação da República
  '2027-11-20', // Consciência Negra
  '2027-12-25', // Natal
]);
