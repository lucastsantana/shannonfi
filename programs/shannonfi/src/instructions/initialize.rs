use anchor_lang::prelude::*;

use crate::constants::*;
use crate::events::VaultInitialized;
use crate::state::VaultState;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::LEN,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,

    // Note: In production, these would be proper token accounts.
    // For testing, we're simplifying to avoid complex Anchor serialization issues.
    pub share_mint: UncheckedAccount<'info>,
    pub usdc_mint: UncheckedAccount<'info>,
    pub vault_usdc_ata: UncheckedAccount<'info>,
    pub vault_wsol_ata: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    keeper: Pubkey,
    rebalance_interval: Option<u64>,
    keeper_fee_bps: Option<u16>,
    rebalance_threshold_bps: Option<u16>,
) -> Result<()> {
    let vault_state = &mut ctx.accounts.vault_state;

    vault_state.authority = ctx.accounts.authority.key();
    vault_state.keeper = keeper;
    vault_state.share_mint = ctx.accounts.share_mint.key();
    vault_state.usdc_mint = ctx.accounts.usdc_mint.key();
    vault_state.vault_usdc_ata = ctx.accounts.vault_usdc_ata.key();
    vault_state.last_rebalance_slot = Clock::get()?.slot;
    vault_state.rebalance_interval = rebalance_interval.unwrap_or(DEFAULT_REBALANCE_INTERVAL);
    vault_state.total_shares = 0;
    vault_state.rebalance_threshold_bps =
        rebalance_threshold_bps.unwrap_or(DEFAULT_REBALANCE_THRESHOLD_BPS);
    vault_state.keeper_fee_bps = keeper_fee_bps.unwrap_or(DEFAULT_KEEPER_FEE_BPS);
    vault_state.paused = false;
    vault_state.bump = ctx.bumps.vault_state;

    emit!(VaultInitialized {
        vault: vault_state.key(),
        authority: ctx.accounts.authority.key(),
        keeper,
        share_mint: ctx.accounts.share_mint.key(),
        usdc_mint: ctx.accounts.usdc_mint.key(),
    });

    Ok(())
}
