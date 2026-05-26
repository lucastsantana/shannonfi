// Ported from programs/shannonfi/src/constants.rs

export const DEFAULT_REBALANCE_THRESHOLD_BPS = 100;  // 1%
export const MAX_SLIPPAGE_BPS = 100;                  // 1%
export const DEFAULT_KEEPER_FEE_BPS = 10;             // 0.1% (not charged in CEX; kept for parity)
export const MAX_KEEPER_FEE_BPS = 50;                 // 0.5%
export const TARGET_ALLOCATION_BPS = 5_000;           // 50%
export const BPS_DENOMINATOR = 10_000;                // 100%

export const PRODUCT_ID = 'SOL-USD';
export const COINBASE_API_BASE = 'https://api.coinbase.com';
export const BROKERAGE_PATH = '/api/v3/brokerage';

export const JWT_TTL_SECONDS = 120;
export const PRIVATE_RATE_LIMIT_RPS = 10;
export const MAX_API_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1_000;

export const FILL_POLL_INTERVAL_MS = 2_000;
export const FILL_POLL_MAX_ATTEMPTS = 30;  // 60s total

export const BACKTEST_GRANULARITY = 'ONE_DAY' as const;
export const BACKTEST_MAX_CANDLES_PER_REQUEST = 300;
