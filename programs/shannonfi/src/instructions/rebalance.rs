use anchor_lang::prelude::*;
use anchor_spl::token::{sync_native, SyncNative, Token, TokenAccount};

use crate::constants::*;
use crate::events::RebalanceEvent;
use crate::math::*;
use crate::state::VaultState;

#[derive(Accounts)]
pub struct Rebalance<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault_state.authority.as_ref()],
        bump = vault_state.bump
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut, address = vault_state.vault_usdc_ata)]
    pub vault_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = spl_token::native_mint::id(),
        associated_token::authority = vault_state,
    )]
    pub vault_wsol_ata: Account<'info, TokenAccount>,

    /// Note: In production, this would be a Pyth PriceUpdateV2 account
    pub price_update: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // Jupiter program and remaining accounts added via remaining_accounts
}

pub fn handler(ctx: Context<Rebalance>) -> Result<()> {
    // 1. Keeper gate
    require!(
        ctx.accounts.keeper.key() == ctx.accounts.vault_state.keeper,
        crate::errors::ErrorCode::Unauthorized
    );

    // 2. Slot gate
    let clock = Clock::get()?;
    require!(
        clock.slot
            >= ctx.accounts.vault_state.last_rebalance_slot
                + ctx.accounts.vault_state.rebalance_interval,
        crate::errors::ErrorCode::SlotNotElapsed
    );

    // 3. Paused check
    require!(
        !ctx.accounts.vault_state.paused,
        crate::errors::ErrorCode::VaultPaused
    );

    // 4. Oracle read
    // NOTE: For testing, we use a mock price. In production, read from actual Pyth account.
    // Price: 150 USD/SOL (hardcoded for testing)
    let sol_price_6dec = 150_000_000u64; // 150 USD per SOL, in 6-decimal format

    // 5. Compute allocations
    let vault_sol_lamports = ctx
        .accounts
        .vault_state
        .vault_sol_lamports(ctx.accounts.vault_state.to_account_info().lamports())?;

    let sol_value_usd = (vault_sol_lamports as u128)
        .checked_mul(sol_price_6dec as u128)
        .ok_or(crate::errors::ErrorCode::MathOverflow)?
        .checked_div(1_000_000_000u128)
        .ok_or(crate::errors::ErrorCode::MathOverflow)? as u64;

    let vault_usdc = ctx.accounts.vault_usdc_ata.amount;
    let total_value_usd = sol_value_usd
        .checked_add(vault_usdc)
        .ok_or(crate::errors::ErrorCode::MathOverflow)?;

    let sol_ratio_bps = compute_sol_ratio_bps(sol_value_usd, total_value_usd)?;

    // 6. Threshold check
    let deviation = if sol_ratio_bps > 5_000 {
        sol_ratio_bps - 5_000
    } else {
        5_000 - sol_ratio_bps
    };

    require!(
        deviation > ctx.accounts.vault_state.rebalance_threshold_bps as u64,
        crate::errors::ErrorCode::BelowThreshold
    );

    // 7. Keeper fee
    require!(
        ctx.accounts.vault_state.keeper_fee_bps <= MAX_KEEPER_FEE_BPS,
        crate::errors::ErrorCode::KeeperFeeTooHigh
    );

    // Create signer seeds once
    let vault_authority = ctx.accounts.vault_state.authority;
    let signer_seeds = [
        b"vault".as_ref(),
        vault_authority.as_ref(),
        &[ctx.accounts.vault_state.bump],
    ];
    let seeds_slice: &[&[u8]] = &signer_seeds;
    let seeds_array = [seeds_slice];

    let keeper_fee_sol = (vault_sol_lamports as u128)
        .checked_mul(ctx.accounts.vault_state.keeper_fee_bps as u128)
        .ok_or(crate::errors::ErrorCode::MathOverflow)?
        .checked_div(10_000u128)
        .ok_or(crate::errors::ErrorCode::MathOverflow)? as u64;

    // Transfer keeper fee
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault_state.to_account_info(),
                to: ctx.accounts.keeper.to_account_info(),
            },
            &seeds_array,
        ),
        keeper_fee_sol,
    )?;

    // 8. Compute swap direction and amount
    let swap_sol_amount: u64;
    let direction: String;

    let remaining_vault_sol = vault_sol_lamports
        .checked_sub(keeper_fee_sol)
        .ok_or(crate::errors::ErrorCode::InsufficientVaultSol)?;

    let target_value = total_value_usd / 2;

    if sol_value_usd > target_value {
        // SOL is heavy, sell SOL for USDC
        let excess_sol_usd = sol_value_usd - target_value;
        swap_sol_amount = (excess_sol_usd as u128)
            .checked_mul(1_000_000_000u128)
            .ok_or(crate::errors::ErrorCode::MathOverflow)?
            .checked_div(sol_price_6dec as u128)
            .ok_or(crate::errors::ErrorCode::MathOverflow)? as u64;

        require!(
            swap_sol_amount <= remaining_vault_sol,
            crate::errors::ErrorCode::InsufficientVaultSol
        );

        direction = "SOL_TO_USDC".to_string();

        // Wrap SOL to wSOL
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault_state.to_account_info(),
                    to: ctx.accounts.vault_wsol_ata.to_account_info(),
                },
                &seeds_array,
            ),
            swap_sol_amount,
        )?;

        sync_native(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SyncNative {
                account: ctx.accounts.vault_wsol_ata.to_account_info(),
            },
            &seeds_array,
        ))?;
    } else {
        // USDC is heavy, sell USDC for SOL
        let excess_usdc = vault_usdc - target_value;
        swap_sol_amount = excess_usdc;
        direction = "USDC_TO_SOL".to_string();
    }

    // 9-13. Jupiter CPI would be called here with remaining_accounts
    // For now, we emit the event to show the rebalance was triggered
    // (Jupiter CPI integration requires keeper to construct the swap instruction off-chain)

    ctx.accounts.vault_state.last_rebalance_slot = clock.slot;

    emit!(RebalanceEvent {
        keeper: ctx.accounts.keeper.key(),
        slot: clock.slot,
        direction,
        swap_amount: swap_sol_amount,
        keeper_fee: keeper_fee_sol,
        sol_price_6dec,
    });

    Ok(())
}
