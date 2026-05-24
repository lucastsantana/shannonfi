pub const MIN_DEPOSIT_SOL_LAMPORTS: u64 = 1_000_000; // 0.001 SOL
pub const MIN_DEPOSIT_USDC: u64 = 1_000_000; // 1 USDC (6 decimals)
pub const DEFAULT_REBALANCE_INTERVAL: u64 = 432_000; // ~2 days
pub const DEFAULT_KEEPER_FEE_BPS: u16 = 10; // 0.1%
pub const DEFAULT_REBALANCE_THRESHOLD_BPS: u16 = 100; // 1%
pub const MAX_KEEPER_FEE_BPS: u16 = 50; // 0.5% max
pub const MAX_SLIPPAGE_BPS: u16 = 100; // 1% max slippage
pub const PYTH_STALENESS_THRESHOLD: u64 = 60; // 60 seconds

// Pyth SOL/USD feed ID (mainnet)
// This is the feed ID for SOL/USD on Pyth mainnet
pub const SOL_USD_FEED_ID: &str = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Share token decimals - matches USDC (6)
pub const SHARE_DECIMALS: u8 = 6;
