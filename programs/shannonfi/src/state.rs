use anchor_lang::prelude::*;

#[account]
pub struct VaultState {
    pub authority: Pubkey,               // 32
    pub keeper: Pubkey,                  // 32
    pub share_mint: Pubkey,              // 32
    pub usdc_mint: Pubkey,               // 32
    pub vault_usdc_ata: Pubkey,          // 32
    pub last_rebalance_slot: u64,        // 8
    pub rebalance_interval: u64,         // 8
    pub total_shares: u64,               // 8
    pub rebalance_threshold_bps: u16,    // 2
    pub keeper_fee_bps: u16,             // 2
    pub paused: bool,                    // 1
    pub bump: u8,                        // 1
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 2 + 2 + 1 + 1; // 198 bytes

    pub fn vault_sol_lamports(&self, total_lamports: u64) -> Result<u64> {
        let rent_exempt = Rent::get()?.minimum_balance(Self::LEN);
        total_lamports
            .checked_sub(rent_exempt)
            .ok_or_else(|| ProgramError::InsufficientFunds.into())
    }
}
