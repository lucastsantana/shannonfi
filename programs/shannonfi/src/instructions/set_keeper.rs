use anchor_lang::prelude::*;

use crate::events::KeeperUpdated;
use crate::state::VaultState;

#[derive(Accounts)]
pub struct SetKeeper<'info> {
    #[account(address = vault_state.authority @ crate::errors::ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,
}

pub fn handler(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
    let old_keeper = ctx.accounts.vault_state.keeper;
    ctx.accounts.vault_state.keeper = new_keeper;

    emit!(KeeperUpdated {
        authority: ctx.accounts.authority.key(),
        old_keeper,
        new_keeper,
    });

    Ok(())
}
