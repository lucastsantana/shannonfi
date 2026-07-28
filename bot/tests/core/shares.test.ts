import { describe, it, expect, beforeEach } from 'vitest';
import { ShareLedgerService } from '../../src/core/tracker/shares';

function uniqueMemDbPath(): string {
  return `:memory:?mode=memory&cache=shared&hash=${Math.random()}`;
}

describe('ShareLedgerService', () => {
  let svc: ShareLedgerService;

  beforeEach(() => {
    svc = new ShareLedgerService(uniqueMemDbPath(), 0);
  });

  it('bootstraps at a fixed 100 shares for a brand-new instance with existing value', () => {
    const state = svc.getShareState(6000);
    expect(state.sharesOutstanding).toBe(100);
    expect(state.navPerShare).toBeCloseTo(60, 6);
  });

  it('bootstraps to zero shares (nav/share still 1.00) when there is no value yet', () => {
    // navPerShare stays 1.00 even at zero value so a genesis deposit right after this
    // (see the next test) has a defined nav/share to issue shares against.
    const state = svc.getShareState(0);
    expect(state.sharesOutstanding).toBe(0);
    expect(state.navPerShare).toBe(1.0);
  });

  it('a genesis deposit into an empty portfolio sets nav/share to 1.00', () => {
    const record = svc.recordCapitalFlow({
      type: 'DEPOSIT',
      brlAmount: 5000,
      currentTotalValueBrl: 0,
      exchange: 'mercadobitcoin',
    });
    expect(record.navPerShareBefore).toBe(1.0);
    expect(record.sharesDelta).toBeCloseTo(5000, 5);
    expect(record.totalSharesAfter).toBeCloseTo(5000, 5);
  });

  it('a deposit does not move nav/share, only shares outstanding', () => {
    // Establish a baseline of 6000 shares directly (independent of the bootstrap
    // default) so this test's math is about the deposit, not the bootstrap constant.
    const db = (svc as any).db;
    db.prepare(
      `INSERT INTO portfolio_snapshots (date_brt, timestamp, total_value_brl, base_balance, brl_balance, base_price, base_ratio_bps, effective_threshold_bps, rebalanced_today, exchange, total_shares_outstanding, nav_per_share) VALUES ('2026-07-01', '2026-07-01T00:00:00Z', 6000, 15, 3000, 400, 5000, 100, 0, 'mercadobitcoin', 6000, 1.0)`,
    ).run();

    // Portfolio has since grown to R$8000 via trading (nav/share should now be 8000/6000).
    const preFlow = svc.getShareState(8000);
    expect(preFlow.navPerShare).toBeCloseTo(8000 / 6000, 6);

    // Deposit R$2000 BEFORE moving the money — currentTotalValueBrl is still the pre-flow R$8000.
    const record = svc.recordCapitalFlow({
      type: 'DEPOSIT',
      brlAmount: 2000,
      currentTotalValueBrl: 8000,
      exchange: 'mercadobitcoin',
    });
    expect(record.navPerShareBefore).toBeCloseTo(8000 / 6000, 6);
    const expectedSharesIssued = 2000 / (8000 / 6000);
    expect(record.sharesDelta).toBeCloseTo(expectedSharesIssued, 5);

    // nav/share right after the deposit lands should be unchanged.
    const postFlowState = svc.getShareState(10000);
    expect(postFlowState.navPerShare).toBeCloseTo(8000 / 6000, 6);
  });

  it('supports --already-moved by backing the amount out of the live value', () => {
    const db = (svc as any).db;
    db.prepare(
      `INSERT INTO portfolio_snapshots (date_brt, timestamp, total_value_brl, base_balance, brl_balance, base_price, base_ratio_bps, effective_threshold_bps, rebalanced_today, exchange, total_shares_outstanding, nav_per_share) VALUES ('2026-07-01', '2026-07-01T00:00:00Z', 6000, 15, 3000, 400, 5000, 100, 0, 'mercadobitcoin', 6000, 1.0)`,
    ).run();

    // Money already deposited — live value is now 8000, of which 2000 is the flow itself.
    const record = svc.recordCapitalFlow({
      type: 'DEPOSIT',
      brlAmount: 2000,
      currentTotalValueBrl: 8000,
      alreadyApplied: true,
      exchange: 'mercadobitcoin',
    });
    expect(record.totalValueBrlBefore).toBe(6000);
    expect(record.navPerShareBefore).toBeCloseTo(1.0, 6);
  });

  it('a withdrawal redeems shares without moving nav/share', () => {
    svc.recordCapitalFlow({ type: 'DEPOSIT', brlAmount: 5000, currentTotalValueBrl: 0, exchange: 'mercadobitcoin' });
    // nav/share is 1.00, 5000 shares outstanding. Withdraw 1000 BRL before moving it out.
    const record = svc.recordCapitalFlow({
      type: 'WITHDRAWAL',
      brlAmount: 1000,
      currentTotalValueBrl: 5000,
      exchange: 'mercadobitcoin',
    });
    expect(record.sharesDelta).toBeCloseTo(-1000, 5);
    expect(record.totalSharesAfter).toBeCloseTo(4000, 5);
    expect(record.totalValueBrlAfter).toBeCloseTo(4000, 5);
  });

  it('rejects a non-positive brlAmount', () => {
    expect(() =>
      svc.recordCapitalFlow({ type: 'DEPOSIT', brlAmount: 0, currentTotalValueBrl: 1000, exchange: 'mercadobitcoin' }),
    ).toThrow();
  });

  it('readCapitalFlows returns recorded flows in chronological order', () => {
    svc.recordCapitalFlow({ type: 'DEPOSIT', brlAmount: 1000, currentTotalValueBrl: 0, exchange: 'mercadobitcoin' });
    svc.recordCapitalFlow({ type: 'DEPOSIT', brlAmount: 500, currentTotalValueBrl: 1000, exchange: 'mercadobitcoin' });
    const flows = svc.readCapitalFlows();
    expect(flows).toHaveLength(2);
    expect(flows[0]!.brlAmount).toBe(1000);
    expect(flows[1]!.brlAmount).toBe(500);
  });
});
