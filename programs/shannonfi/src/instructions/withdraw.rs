use anchor_lang::prelude::*;
use anchor_spl::token::{burn, transfer, Burn, Token, TokenAccount, Transfer};

use crate::events::WithdrawEvent;
use crate::math::*;
use crate::state::VaultState;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, address = vault_state.authority @ crate::errors::ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut, seeds = [b"share_mint", vault_state.key().as_ref()], bump)]
    pub share_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut, address = vault_state.vault_usdc_ata)]
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = vault_state.usdc_mint,
        associated_token::authority = authority
    )]
    pub authority_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = authority
    )]
    pub authority_share_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Withdraw>, share_amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.vault_state.paused,
        crate::errors::ErrorCode::VaultPaused
    );

    require!(
        share_amount > 0 && share_amount <= ctx.accounts.vault_state.total_shares,
        crate::errors::ErrorCode::InsufficientShares
    );

    let vault_sol = ctx
        .accounts
        .vault_state
        .vault_sol_lamports(ctx.accounts.vault_state.to_account_info().lamports())?;
    let vault_usdc = ctx.accounts.vault_usdc_ata.amount;

    let (sol_out, usdc_out) = compute_withdrawal_amounts(
        vault_sol,
        vault_usdc,
        share_amount,
        ctx.accounts.vault_state.total_shares,
    )?;

    // Burn shares
    let burn_cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts.authority_share_ata.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        },
    );

    burn(burn_cpi, share_amount)?;

    // Create signer seeds once
    let authority_key = ctx.accounts.authority.key();
    let signer_seeds = [
        b"vault".as_ref(),
        authority_key.as_ref(),
        &[ctx.accounts.vault_state.bump],
    ];

    // Transfer SOL from vault to authority
    let seeds_slice: &[&[u8]] = &signer_seeds;
    let sol_seeds_array = [seeds_slice];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault_state.to_account_info(),
                to: ctx.accounts.authority.to_account_info(),
            },
            &sol_seeds_array,
        ),
        sol_out,
    )?;

    // Transfer USDC from vault ATA to authority
    let seeds_slice: &[&[u8]] = &signer_seeds;
    let seeds_array = [seeds_slice];
    let usdc_transfer_cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_usdc_ata.to_account_info(),
            to: ctx.accounts.authority_usdc_ata.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        },
        &seeds_array,
    );

    transfer(usdc_transfer_cpi, usdc_out)?;

    // Update vault state
    ctx.accounts.vault_state.total_shares = ctx
        .accounts
        .vault_state
        .total_shares
        .checked_sub(share_amount)
        .ok_or(crate::errors::ErrorCode::MathOverflow)?;

    let remaining_vault_usdc = ctx
        .accounts
        .vault_usdc_ata
        .amount
        .checked_sub(usdc_out)
        .ok_or(crate::errors::ErrorCode::MathOverflow)?;

    let nav_per_share = if ctx.accounts.vault_state.total_shares > 0 {
        let remaining_vault_sol = vault_sol
            .checked_sub(sol_out)
            .ok_or(crate::errors::ErrorCode::MathOverflow)?;
        let total_value = remaining_vault_sol
            .checked_add(remaining_vault_usdc)
            .ok_or(crate::errors::ErrorCode::MathOverflow)?;
        compute_nav_per_share(total_value, ctx.accounts.vault_state.total_shares)?
    } else {
        0 // No shares left
    };

    emit!(WithdrawEvent {
        authority: ctx.accounts.authority.key(),
        shares_burned: share_amount,
        sol_out,
        usdc_out,
        nav_per_share,
    });

    Ok(())
}
