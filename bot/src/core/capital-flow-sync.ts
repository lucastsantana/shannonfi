/**
 * Auto-detects BRL deposits/withdrawals made directly on Mercado Bitcoin (e.g. a PIX
 * transfer, or a withdrawal via MB's own app) and records them in capital_flows — so
 * an instance's NAV/share accounting (see ShareLedgerService) stays correct without a
 * manual `record-flow` CLI call for every top-up.
 *
 * Mercado Bitcoin-only: MB's wallet API exposes list endpoints for both directions
 * (GET .../wallet/fiat/BRL/deposits, GET .../wallet/BRL/withdraw) that return every
 * deposit/withdrawal on the account, not just ones the API itself initiated. No
 * equivalent has been found/wired up for Binance or Coinbase.
 *
 * Called every cycle from RebalancerBot.checkAndRebalance() when config.exchange is
 * 'mercadobitcoin' — cheap (two small paginated list requests) and needs to run
 * regardless of whether a rebalance is imminent, since a deposit should be reflected
 * in the instance's share accounting as soon as possible, not only when a trade fires.
 */

import { ShareLedgerService } from './tracker/shares';
import { getDbConfig, setDbConfig } from './tracker/db';
import { logger } from './tracker/logger';

export interface MbFiatDepositLike {
  id: number;
  amount: string;
  status: string;
}

export interface MbWithdrawalLike {
  id: number;
  quantity: string;
  status: number;
}

// Narrow structural interface — only what this module needs from
// MercadoBitcoinAdapter, so it never imports the concrete adapter class (same
// approach as ScannerAdapter in scanner/scanner.ts).
export interface MbCapitalFlowAdapter {
  listFiatDeposits(limit?: number): Promise<MbFiatDepositLike[]>;
  listWithdrawals(pageSize?: number): Promise<MbWithdrawalLike[]>;
  getPortfolio(): Promise<{ totalValueBrl: number }>;
}

const DEPOSIT_CHECKPOINT_KEY = 'mb_last_synced_deposit_id';
const WITHDRAWAL_CHECKPOINT_KEY = 'mb_last_synced_withdrawal_id';
// MB's max page size for both endpoints — deposits/withdrawals are rare enough that a
// single page comfortably covers everything new since the last cycle.
const SYNC_BATCH_SIZE = 50;

export async function syncMbCapitalFlows(
  adapter: MbCapitalFlowAdapter,
  shares: ShareLedgerService,
  dbPath: string | undefined,
  exchange: string,
): Promise<void> {
  await syncDeposits(adapter, shares, dbPath, exchange);
  await syncWithdrawals(adapter, shares, dbPath, exchange);
}

export async function syncDeposits(
  adapter: MbCapitalFlowAdapter,
  shares: ShareLedgerService,
  dbPath: string | undefined,
  exchange: string,
): Promise<void> {
  const lastSyncedId = Number(getDbConfig(DEPOSIT_CHECKPOINT_KEY, '0', dbPath));
  const deposits = await adapter.listFiatDeposits(SYNC_BATCH_SIZE);
  const newOnes = deposits
    .filter((d) => d.status === 'CREDITED' && d.id > lastSyncedId)
    .sort((a, b) => a.id - b.id);

  if (newOnes.length === 0) return;

  // Fetched once and reused for every new item in this batch (deposits are rare —
  // almost always 0 or 1 per cycle — so re-fetching live value per item isn't
  // worth another authenticated request; see recordCapitalFlow's alreadyApplied
  // mode, which this always uses since the deposit already landed by the time we see it).
  let livePortfolio: { totalValueBrl: number } | null = null;

  for (const deposit of newOnes) {
    const brlAmount = parseFloat(deposit.amount);
    if (!Number.isFinite(brlAmount) || brlAmount <= 0) {
      logger.warn('Skipping malformed MB deposit during capital-flow sync', {
        id: deposit.id,
        amount: deposit.amount,
      });
      setDbConfig(DEPOSIT_CHECKPOINT_KEY, String(deposit.id), dbPath);
      continue;
    }

    livePortfolio ??= await adapter.getPortfolio();
    const record = shares.recordCapitalFlow({
      type: 'DEPOSIT',
      brlAmount,
      currentTotalValueBrl: livePortfolio.totalValueBrl,
      alreadyApplied: true,
      exchange,
      note: `Auto-detected via Mercado Bitcoin API (deposit id=${deposit.id})`,
    });
    logger.info('Auto-recorded MB deposit as capital flow', {
      depositId: deposit.id,
      brlAmount: brlAmount.toFixed(2),
      sharesIssued: record.sharesDelta.toFixed(6),
    });
    setDbConfig(DEPOSIT_CHECKPOINT_KEY, String(deposit.id), dbPath);
  }
}

export async function syncWithdrawals(
  adapter: MbCapitalFlowAdapter,
  shares: ShareLedgerService,
  dbPath: string | undefined,
  exchange: string,
): Promise<void> {
  const lastSyncedId = Number(getDbConfig(WITHDRAWAL_CHECKPOINT_KEY, '0', dbPath));
  const withdrawals = await adapter.listWithdrawals(SYNC_BATCH_SIZE);
  // status 2 = done. A withdrawal still open (1) or canceled (3) is left unprocessed —
  // an open one will be picked up on a later cycle once it settles, since it's simply
  // excluded from newOnes rather than having the checkpoint advanced past it.
  const newOnes = withdrawals
    .filter((w) => w.status === 2 && w.id > lastSyncedId)
    .sort((a, b) => a.id - b.id);

  if (newOnes.length === 0) return;

  let livePortfolio: { totalValueBrl: number } | null = null;

  for (const withdrawal of newOnes) {
    // quantity is the gross amount debited from the account (what actually left this
    // fund's value) — net_quantity is smaller, what arrived at the destination after
    // the MB withdrawal fee, and would understate the reduction in portfolio value.
    const brlAmount = parseFloat(withdrawal.quantity);
    if (!Number.isFinite(brlAmount) || brlAmount <= 0) {
      logger.warn('Skipping malformed MB withdrawal during capital-flow sync', {
        id: withdrawal.id,
        quantity: withdrawal.quantity,
      });
      setDbConfig(WITHDRAWAL_CHECKPOINT_KEY, String(withdrawal.id), dbPath);
      continue;
    }

    livePortfolio ??= await adapter.getPortfolio();
    const record = shares.recordCapitalFlow({
      type: 'WITHDRAWAL',
      brlAmount,
      currentTotalValueBrl: livePortfolio.totalValueBrl,
      alreadyApplied: true,
      exchange,
      note: `Auto-detected via Mercado Bitcoin API (withdrawal id=${withdrawal.id})`,
    });
    logger.info('Auto-recorded MB withdrawal as capital flow', {
      withdrawalId: withdrawal.id,
      brlAmount: brlAmount.toFixed(2),
      sharesRedeemed: Math.abs(record.sharesDelta).toFixed(6),
    });
    setDbConfig(WITHDRAWAL_CHECKPOINT_KEY, String(withdrawal.id), dbPath);
  }
}
