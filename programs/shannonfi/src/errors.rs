use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized caller")]
    Unauthorized = 6000,

    #[msg("Vault is paused")]
    VaultPaused = 6001,

    #[msg("Rebalance interval not elapsed")]
    SlotNotElapsed = 6002,

    #[msg("Oracle price is stale")]
    OracleStale = 6003,

    #[msg("Oracle feed ID mismatch")]
    OracleFeedMismatch = 6004,

    #[msg("Oracle price is invalid")]
    InvalidOraclePrice = 6005,

    #[msg("Vault drift below rebalance threshold")]
    BelowThreshold = 6006,

    #[msg("Wrong swap direction")]
    WrongSwapDirection = 6007,

    #[msg("Invalid swap authority")]
    InvalidSwapAuthority = 6008,

    #[msg("Slippage exceeded maximum")]
    SlippageExceeded = 6009,

    #[msg("Math overflow")]
    MathOverflow = 6010,

    #[msg("Insufficient shares")]
    InsufficientShares = 6011,

    #[msg("Deposit amount below minimum")]
    BelowMinimumDeposit = 6012,

    #[msg("Invalid USDC ATA")]
    InvalidUsdcAta = 6013,

    #[msg("Invalid swap input amount")]
    InvalidInAmount = 6014,

    #[msg("Insufficient vault SOL")]
    InsufficientVaultSol = 6015,

    #[msg("Keeper fee too high")]
    KeeperFeeTooHigh = 6016,
}
