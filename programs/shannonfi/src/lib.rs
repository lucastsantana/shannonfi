use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("4EYp2gXhDcPVZYcaQfT2tBUfT6L8jSfPMd6a4P8EX2Qx");

#[program]
pub mod shannonfi {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        keeper: Pubkey,
        rebalance_interval: Option<u64>,
        keeper_fee_bps: Option<u16>,
        rebalance_threshold_bps: Option<u16>,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            keeper,
            rebalance_interval,
            keeper_fee_bps,
            rebalance_threshold_bps,
        )
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        sol_lamports: u64,
        usdc_amount: u64,
    ) -> Result<()> {
        instructions::deposit::handler(ctx, sol_lamports, usdc_amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, share_amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, share_amount)
    }

    pub fn set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
        instructions::set_keeper::handler(ctx, new_keeper)
    }

    pub fn rebalance(ctx: Context<Rebalance>) -> Result<()> {
        instructions::rebalance::handler(ctx)
    }
}
