use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub keeper: Pubkey,
    pub share_mint: Pubkey,
    pub usdc_mint: Pubkey,
}

#[event]
pub struct DepositEvent {
    pub authority: Pubkey,
    pub sol_lamports: u64,
    pub usdc_amount: u64,
    pub shares_minted: u64,
    pub nav_per_share: u64,
}

#[event]
pub struct WithdrawEvent {
    pub authority: Pubkey,
    pub shares_burned: u64,
    pub sol_out: u64,
    pub usdc_out: u64,
    pub nav_per_share: u64,
}

#[event]
pub struct RebalanceEvent {
    pub keeper: Pubkey,
    pub slot: u64,
    pub direction: String, // "SOL_TO_USDC" or "USDC_TO_SOL"
    pub swap_amount: u64,
    pub keeper_fee: u64,
    pub sol_price_6dec: u64,
}

#[event]
pub struct KeeperUpdated {
    pub authority: Pubkey,
    pub old_keeper: Pubkey,
    pub new_keeper: Pubkey,
}
