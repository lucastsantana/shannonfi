import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaxService } from '../src/tracker/tax';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPath(): string {
  return path.join(os.tmpdir(), `mb-tax-test-${Date.now()}-${Math.random()}.json`);
}

describe('TaxService (domestic exchange — sells-only exemption)', () => {
  let filePath: string;
  let svc: TaxService;

  beforeEach(() => {
    filePath = tmpPath();
    svc = new TaxService(filePath);
  });

  afterEach(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  function makeSell(monthBRT: string, gainBrl: number, volumeBrl: number) {
    return svc.buildTaxEvent({
      tradeId: `trade-${Math.random()}`,
      tradeDateBRT: `${monthBRT}-15`,
      direction: 'SELL_SOL',
      tradedVolumeBrl: volumeBrl,
      grossProceedsBrl: volumeBrl,
      costBasisBrl: volumeBrl - gainBrl,
      realizedGainBrl: gainBrl,
    });
  }

  function makeBuy(monthBRT: string) {
    return svc.buildTaxEvent({
      tradeId: `trade-${Math.random()}`,
      tradeDateBRT: `${monthBRT}-20`,
      direction: 'BUY_SOL',
      tradedVolumeBrl: 0,
      grossProceedsBrl: 0,
      costBasisBrl: 0,
      realizedGainBrl: 0,
    });
  }

  it('starts with no events', () => {
    expect(svc.readEvents()).toHaveLength(0);
  });

  it('persists tax events', () => {
    const event = makeSell('2026-05', 1000, 5000);
    svc.appendTaxEvent(event);
    expect(svc.readEvents()).toHaveLength(1);
  });

  it('getMonthlySalesBrl counts only SELL trades', () => {
    svc.appendTaxEvent(makeSell('2026-05', 1000, 10000));
    svc.appendTaxEvent(makeBuy('2026-05'));
    // BUY has tradedVolumeBrl=0, so sales = 10000
    expect(svc.getMonthlySalesBrl('2026-05')).toBeCloseTo(10000, 2);
  });

  it('BUY events do NOT count toward exemption threshold', () => {
    // Add R$30,000 in sales
    svc.appendTaxEvent(makeSell('2026-05', 3000, 30000));
    // Add BUY — should not push sales over limit
    svc.appendTaxEvent(makeBuy('2026-05'));
    // Next sell event: cumMonthlySalesBrl should still be 30,000
    const event = makeSell('2026-05', 1000, 4000);
    expect(event.cumMonthlySalesBrl).toBeCloseTo(34000, 2);
    expect(event.exempt).toBe(true); // 34k < 35k
  });

  it('exemption flips when SELL sales exceed R$35,000', () => {
    svc.appendTaxEvent(makeSell('2026-05', 3000, 30000));
    const event = makeSell('2026-05', 600, 6000); // 30k + 6k = 36k
    expect(event.cumMonthlySalesBrl).toBeCloseTo(36000, 2);
    expect(event.exempt).toBe(false);
    expect(event.paymentDeadline).not.toBeNull();
  });

  it('exemption resets each month', () => {
    svc.appendTaxEvent(makeSell('2026-05', 3600, 36000));
    const june = makeSell('2026-06', 500, 5000);
    expect(june.exempt).toBe(true);
  });

  it('getMonthlySalesBrl returns 0 for different month', () => {
    svc.appendTaxEvent(makeSell('2026-05', 1000, 5000));
    expect(svc.getMonthlySalesBrl('2026-06')).toBe(0);
  });

  it('getMonthlyGainBrl sums only SELL gains', () => {
    svc.appendTaxEvent(makeSell('2026-05', 2000, 10000));
    svc.appendTaxEvent(makeBuy('2026-05'));
    expect(svc.getMonthlyGainBrl('2026-05')).toBeCloseTo(2000, 2);
  });

  it('computePaymentDeadline: April 2026 → last business day of May 2026', () => {
    // May 31 = Sunday, May 30 = Saturday → May 29 = Friday
    expect(svc.computePaymentDeadline('2026-04')).toBe('2026-05-29');
  });

  it('computePaymentDeadline: December 2026 → last business day of January 2027', () => {
    // Jan 31, 2027 = Sunday, Jan 30 = Saturday → Jan 29 = Friday
    expect(svc.computePaymentDeadline('2026-12')).toBe('2027-01-29');
  });

  it('getMonthlySummary aggregates correctly', () => {
    svc.appendTaxEvent(makeSell('2026-07', 5000, 20000));
    svc.appendTaxEvent(makeBuy('2026-07'));
    const summary = svc.getMonthlySummary('2026-07');
    expect(summary.totalSalesBrl).toBeCloseTo(20000, 2);
    expect(summary.totalRealizedGainBrl).toBeCloseTo(5000, 2);
    expect(summary.tradeCount).toBe(2);
    expect(summary.exempt).toBe(true); // 20k < 35k
  });
});
