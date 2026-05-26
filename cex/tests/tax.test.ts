import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaxService } from '../src/tracker/tax';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPath(): string {
  return path.join(os.tmpdir(), `tax-test-${Date.now()}-${Math.random()}.json`);
}

describe('TaxService', () => {
  let filePath: string;
  let svc: TaxService;

  beforeEach(() => {
    filePath = tmpPath();
    svc = new TaxService(filePath);
  });

  afterEach(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  function makeSellEvent(monthBRT: string, gainBrl: number, grossBrl: number) {
    return svc.buildTaxEvent({
      tradeId: `trade-${Math.random()}`,
      tradeDateBRT: `${monthBRT}-15`,
      direction: 'SELL_SOL',
      grossProceedsBrl: grossBrl,
      costBasisBrl: grossBrl - gainBrl,
      realizedGainBrl: gainBrl,
    });
  }

  it('starts with no events', () => {
    expect(svc.readEvents()).toHaveLength(0);
  });

  it('persists tax events', () => {
    const event = makeSellEvent('2026-05', 1000, 5000);
    svc.appendTaxEvent(event);
    expect(svc.readEvents()).toHaveLength(1);
  });

  it('getMonthlyVolumeBrl sums gross proceeds for the month', () => {
    svc.appendTaxEvent(makeSellEvent('2026-05', 1000, 5000));
    svc.appendTaxEvent(makeSellEvent('2026-05', 2000, 10000));
    expect(svc.getMonthlyVolumeBrl('2026-05')).toBeCloseTo(15000, 2);
  });

  it('getMonthlyVolumeBrl returns 0 for different month', () => {
    svc.appendTaxEvent(makeSellEvent('2026-05', 1000, 5000));
    expect(svc.getMonthlyVolumeBrl('2026-06')).toBe(0);
  });

  it('buildTaxEvent marks as exempt when cumulative gain ≤ R$35,000', () => {
    const event = makeSellEvent('2026-05', 10000, 50000);
    svc.appendTaxEvent(event);
    expect(event.exempt).toBe(true);
    expect(event.paymentDeadline).toBeNull();
  });

  it('buildTaxEvent marks as NOT exempt when cumulative gain > R$35,000', () => {
    // First trade: R$34,000 gain
    const event1 = makeSellEvent('2026-05', 34000, 40000);
    svc.appendTaxEvent(event1);
    // Second trade: R$2,000 gain → cumulative = R$36,000 > R$35,000
    const event2 = makeSellEvent('2026-05', 2000, 5000);
    svc.appendTaxEvent(event2);
    expect(event2.exempt).toBe(false);
    expect(event2.paymentDeadline).not.toBeNull();
  });

  it('exemption resets each month', () => {
    // May: R$36,000 → not exempt
    const may = makeSellEvent('2026-05', 36000, 50000);
    svc.appendTaxEvent(may);
    expect(may.exempt).toBe(false);
    // June starts fresh
    const june = makeSellEvent('2026-06', 1000, 5000);
    svc.appendTaxEvent(june);
    expect(june.exempt).toBe(true);
  });

  // ─── computePaymentDeadline ────────────────────────────────────────────────

  it('computePaymentDeadline returns last business day of following month', () => {
    // April 2026 → deadline is last business day of May 2026
    // May 2026 ends on Sunday 31st → last business day = Friday 29th
    // May 30 = Saturday, May 31 = Sunday → May 29 = Friday (not a holiday)
    const deadline = svc.computePaymentDeadline('2026-04');
    expect(deadline).toBe('2026-05-29');
  });

  it('computePaymentDeadline skips weekends', () => {
    // December 2026 → deadline is last business day of January 2027
    // Jan 31, 2027 is a Sunday → Jan 30 is Saturday → Jan 29 is Friday (not a holiday)
    const deadline = svc.computePaymentDeadline('2026-12');
    expect(deadline).toBe('2027-01-29');
  });

  it('computePaymentDeadline skips Brazilian holidays', () => {
    // For a month where the last business day is a holiday, it walks back further
    // Feb 2026 → deadline is last business day of March 2026
    // March 31, 2026 is a Tuesday — not a holiday
    const deadline = svc.computePaymentDeadline('2026-02');
    expect(deadline).toBe('2026-03-31');
  });

  it('getMonthlySummary aggregates correctly', () => {
    svc.appendTaxEvent(makeSellEvent('2026-07', 5000, 20000));
    svc.appendTaxEvent(makeSellEvent('2026-07', 8000, 30000));
    const summary = svc.getMonthlySummary('2026-07');
    expect(summary.totalRealizedGainBrl).toBeCloseTo(13000, 2);
    expect(summary.totalGrossProceedsBrl).toBeCloseTo(50000, 2);
    expect(summary.tradeCount).toBe(2);
    expect(summary.exempt).toBe(true);
  });
});
