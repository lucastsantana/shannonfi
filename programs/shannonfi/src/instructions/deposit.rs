use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{mint_to, MintTo, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::events::DepositEvent;
use crate::math::*;
use crate::state::VaultState;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, address = vault_state.authority @ crate::errors::ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"share_mint", vault_state.key().as_ref()],
        bump
    )]
    pub share_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(
        mut,
        address = vault_state.vault_usdc_ata @ crate::errors::ErrorCode::InvalidUsdcAta
    )]
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

    /// Note: In production, this would be a Pyth PriceUpdateV2 account
    /// For testing, we use a generic AccountInfo
    pub price_update: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Deposit>,
    sol_lamports: u64,
    usdc_amount: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.vault_state.paused,
        crate::errors::ErrorCode::VaultPaused
    );

    require!(
        sol_lamports >= MIN_DEPOSIT_SOL_LAMPORTS && usdc_amount >= MIN_DEPOSIT_USDC,
        crate::errors::ErrorCode::BelowMinimumDeposit
    );

    // Read Pyth price
    // NOTE: For testing, we use a mock price. In production, read from actual Pyth account.
    // Price: 150 USD/SOL (hardcoded for testing)
    let sol_price_6dec = 150_000_000u64; // 150 USD per SOL, in 6-decimal format

    // Compute deposit value in USD (6-decimal)
    let sol_value_usd = (sol_lamports as u128)
        .checked_mul(sol_price_6dec as u128)
        .ok_or(crate::errors::ErrorCode::MathOverflow)?
        .checked_div(1_000_000_000u128)
        .ok_or(crate::errors::ErrorCode::MathOverflow)? as u64;

    let deposit_value_usd = sol_value_usd
        .checked_add(usdc_amount)
        .ok_or(crate::errors::ErrorCode::MathOverflow)?;

    // Compute shares
    let shares = if ctx.accounts.vault_state.total_shares == 0 {
        compute_shares_first_deposit(sol_value_usd, usdc_amount)?
    } else {
        let vault_sol = ctx
            .accounts
            .vault_state
            .vault_sol_lamports(ctx.accounts.vault_state.to_account_info().lamports())?;
        let vault_usdc = ctx.accounts.vault_usdc_ata.amount;

        let total_vault_value_usd = (vault_sol as u128)
            .checked_mul(sol_price_6dec as u128)
            .ok_or(crate::errors::ErrorCode::MathOverflow)?
            .checked_div(1_000_000_000u128)
            .ok_or(crate::errors::ErrorCode::MathOverflow)? as u64;

        let total_value = total_vault_value_usd
            .checked_add(vault_usdc)
            .ok_or(crate::errors::ErrorCode::MathOverflow)?;

        compute_shares_subsequent(deposit_value_usd, ctx.accounts.vault_state.total_shares, total_value)?
    };

    // Transfer SOL from authority to vault PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.vault_state.to_account_info(),
            },
        ),
        sol_lamports,
    )?;

    // Transfer USDC from authority to vault ATA
    let transfer_cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.authority_usdc_ata.to_account_info(),
            to: ctx.accounts.vault_usdc_ata.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        },
    );

    anchor_spl::token::transfer(transfer_cpi, usdc_amount)?;

    // Mint shares
    let authority_key = ctx.accounts.authority.key();
    let signer_seeds = [
        b"vault".as_ref(),
        authority_key.as_ref(),
        &[ctx.accounts.vault_state.bump],
    ];
    let seeds_slice: &[&[u8]] = &signer_seeds;
    let seeds_array = [seeds_slice];

    let mint_cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.authority_share_ata.to_account_info(),
            authority: ctx.accounts.vault_state.to_account_info(),
        },
        &seeds_array,
    );

    mint_to(mint_cpi, shares)?;

    // Update vault state
    ctx.accounts.vault_state.total_shares = ctx
        .accounts
        .vault_state
        .total_shares
        .checked_add(shares)
        .ok_or(crate::errors::ErrorCode::MathOverflow)?;

    let nav_per_share = compute_nav_per_share(
        deposit_value_usd.checked_add(ctx.accounts.vault_usdc_ata.amount).ok_or(crate::errors::ErrorCode::MathOverflow)?,
        ctx.accounts.vault_state.total_shares,
    )?;

    emit!(DepositEvent {
        authority: ctx.accounts.authority.key(),
        sol_lamports,
        usdc_amount,
        shares_minted: shares,
        nav_per_share,
    });

    Ok(())
}
