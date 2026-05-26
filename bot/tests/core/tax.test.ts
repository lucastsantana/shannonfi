import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaxService } from '../../src/core/tracker/tax';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPath(): string {
  return path.join(os.tmpdir(), `bot-tax-test-${Date.now()}-${Math.random()}.json`);
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

  const sellEvent = (overrides = {}) =>
    svc.buildTaxEvent({
      tradeId: 'trade-1',
      tradeDateBRT: '2026-04-15',
      direction: 'SELL_SOL',
      tradedVolumeBrl: 10_000,
      grossProceedsBrl: 10_000,
      costBasisBrl: 8_000,
      realizedGainBrl: 2_000,
      exchange: 'mercadobitcoin',
      ...overrides,
    });

  it('starts empty', () => {
    expect(svc.readEvents()).toHaveLength(0);
  });

  it('appends and reads tax events', () => {
    const event = sellEvent();
    svc.appendTaxEvent(event);
    expect(svc.readEvents()).toHaveLength(1);
  });

  it('getMonthlySalesBrl sums SELL proceeds for the month', () => {
    svc.appendTaxEvent(sellEvent({ tradedVolumeBrl: 10_000, tradeDateBRT: '2026-04-15' }));
    svc.appendTaxEvent(
      svc.buildTaxEvent({
        tradeId: 'trade-2',
        tradeDateBRT: '2026-04-20',
        direction: 'SELL_SOL',
        tradedVolumeBrl: 5_000,
        grossProceedsBrl: 5_000,
        costBasisBrl: 4_000,
        realizedGainBrl: 1_000,
        exchange: 'mercadobitcoin',
      }),
    );
    expect(svc.getMonthlySalesBrl('2026-04')).toBeCloseTo(15_000, 2);
  });

  it('getMonthlySalesBrl ignores BUY trades', () => {
    svc.appendTaxEvent(
      svc.buildTaxEvent({
        tradeId: 'trade-buy',
        tradeDateBRT: '2026-04-15',
        direction: 'BUY_SOL',
        tradedVolumeBrl: 5_000,
        grossProceedsBrl: 0,
        costBasisBrl: 0,
        realizedGainBrl: 0,
        exchange: 'mercadobitcoin',
      }),
    );
    expect(svc.getMonthlySalesBrl('2026-04')).toBe(0);
  });

  it('buildTaxEvent marks exempt when cumulative sales ≤ R$35,000', () => {
    const event = sellEvent({ tradedVolumeBrl: 20_000 });
    expect(event.exempt).toBe(true);
    expect(event.paymentDeadline).toBeNull();
  });

  it('buildTaxEvent marks non-exempt when cumulative sales > R$35,000', () => {
    svc.appendTaxEvent(sellEvent({ tradedVolumeBrl: 30_000 }));
    const event = svc.buildTaxEvent({
      tradeId: 'trade-over',
      tradeDateBRT: '2026-04-25',
      direction: 'SELL_SOL',
      tradedVolumeBrl: 10_000,
      grossProceedsBrl: 10_000,
      costBasisBrl: 8_000,
      realizedGainBrl: 2_000,
      exchange: 'mercadobitcoin',
    });
    expect(event.exempt).toBe(false);
    expect(event.paymentDeadline).toBeTruthy();
    expect(event.cumMonthlySalesBrl).toBeCloseTo(40_000, 2);
  });

  it('cumMonthlySalesBrl is cumulative across events in the same month', () => {
    svc.appendTaxEvent(sellEvent({ tradedVolumeBrl: 10_000, tradeId: 't1' }));
    const event2 = svc.buildTaxEvent({
      tradeId: 't2',
      tradeDateBRT: '2026-04-20',
      direction: 'SELL_SOL',
      tradedVolumeBrl: 8_000,
      grossProceedsBrl: 8_000,
      costBasisBrl: 6_000,
      realizedGainBrl: 2_000,
      exchange: 'mercadobitcoin',
    });
    expect(event2.cumMonthlySalesBrl).toBeCloseTo(18_000, 2);
  });

  it('computePaymentDeadline returns a weekday not in BR_HOLIDAYS', () => {
    const deadline = svc.computePaymentDeadline('2026-04');
    // Deadline should be in May 2026
    expect(deadline).toMatch(/^2026-05-/);
    const dow = new Date(`${deadline}T12:00:00Z`).getUTCDay();
    expect(dow).not.toBe(0); // not Sunday
    expect(dow).not.toBe(6); // not Saturday
  });

  it('getMonthlyVolumeBrl counts both directions', () => {
    svc.appendTaxEvent(sellEvent({ tradedVolumeBrl: 10_000, tradeId: 't1' }));
    svc.appendTaxEvent(
      svc.buildTaxEvent({
        tradeId: 't2',
        tradeDateBRT: '2026-04-20',
        direction: 'BUY_SOL',
        tradedVolumeBrl: 5_000, // Coinbase: buys count toward volume cap
        grossProceedsBrl: 0,
        costBasisBrl: 0,
        realizedGainBrl: 0,
        exchange: 'coinbase',
      }),
    );
    expect(svc.getMonthlyVolumeBrl('2026-04')).toBeCloseTo(15_000, 2);
  });
});
