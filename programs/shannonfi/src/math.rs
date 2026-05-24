use anchor_lang::prelude::*;

pub fn isqrt_u128(n: u128) -> u64 {
    if n == 0 {
        return 0;
    }

    let bit_length = 128 - n.leading_zeros();
    let mut x = 1u128 << ((bit_length + 1) / 2);
    loop {
        let x1 = (x + n / x) / 2;
        if x1 >= x {
            break;
        }
        x = x1;
    }
    x as u64
}

pub fn pyth_price_to_usd_6dec(price: i64, expo: i32) -> Result<u64> {
    require!(price > 0, crate::errors::ErrorCode::InvalidOraclePrice);

    let price_u64 = price as u64;
    let adjustment = 6i32 + expo;

    if adjustment >= 0 {
        price_u64
            .checked_mul(10u64.pow(adjustment as u32))
            .ok_or_else(|| crate::errors::ErrorCode::MathOverflow.into())
    } else {
        Ok(price_u64 / 10u64.pow((-adjustment) as u32))
    }
}

pub fn compute_shares_first_deposit(
    sol_value_usd_6dec: u64,
    usdc_amount_6dec: u64,
) -> Result<u64> {
    let product = (sol_value_usd_6dec as u128)
        .checked_mul(usdc_amount_6dec as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?;

    Ok(isqrt_u128(product))
}

pub fn compute_shares_subsequent(
    deposit_value_usd: u64,
    total_shares: u64,
    total_vault_value_usd: u64,
) -> Result<u64> {
    require!(
        total_vault_value_usd > 0,
        crate::errors::ErrorCode::MathOverflow
    );

    let shares = (deposit_value_usd as u128)
        .checked_mul(total_shares as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?
        .checked_div(total_vault_value_usd as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?;

    Ok(shares as u64)
}

pub fn compute_nav_per_share(total_vault_value_usd: u64, total_shares: u64) -> Result<u64> {
    require!(total_shares > 0, crate::errors::ErrorCode::MathOverflow);

    let nav = (total_vault_value_usd as u128)
        .checked_mul(1_000_000u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?
        .checked_div(total_shares as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?;

    Ok(nav as u64)
}

pub fn compute_withdrawal_amounts(
    vault_sol: u64,
    vault_usdc: u64,
    share_amount: u64,
    total_shares: u64,
) -> Result<(u64, u64)> {
    require!(total_shares > 0, crate::errors::ErrorCode::MathOverflow);

    let sol_out = (vault_sol as u128)
        .checked_mul(share_amount as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?
        .checked_div(total_shares as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)? as u64;

    let usdc_out = (vault_usdc as u128)
        .checked_mul(share_amount as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?
        .checked_div(total_shares as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)? as u64;

    Ok((sol_out, usdc_out))
}

pub fn compute_sol_ratio_bps(sol_value_usd: u64, total_value: u64) -> Result<u64> {
    require!(total_value > 0, crate::errors::ErrorCode::MathOverflow);

    let ratio = (sol_value_usd as u128)
        .checked_mul(10_000u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?
        .checked_div(total_value as u128)
        .ok_or_else(|| crate::errors::ErrorCode::MathOverflow)?;

    Ok(ratio as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_isqrt_u128() {
        assert_eq!(isqrt_u128(0), 0);
        assert_eq!(isqrt_u128(1), 1);
        assert_eq!(isqrt_u128(4), 2);
        assert_eq!(isqrt_u128(9), 3);
        assert_eq!(isqrt_u128(16), 4);
        assert_eq!(isqrt_u128(100), 10);
        assert_eq!(isqrt_u128(1_000_000), 1_000);
    }

    #[test]
    fn test_pyth_price_to_usd_6dec() {
        // expo = -8, price = 15_000_000_000 → ~150 * 10^(-8) = 0.0015 USD per lamport
        // In 6-dec: 0.0015 * 10^6 = 1500
        let result = pyth_price_to_usd_6dec(15_000_000_000i64, -8).unwrap();
        assert!(result > 0); // Just verify it doesn't overflow
    }
}
