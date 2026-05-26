import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CostBasisService } from '../src/tracker/costbasis';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPath(): string {
  return path.join(os.tmpdir(), `cb-test-${Date.now()}-${Math.random()}.json`);
}

describe('CostBasisService', () => {
  let filePath: string;
  let svc: CostBasisService;

  beforeEach(() => {
    filePath = tmpPath();
    svc = new CostBasisService(filePath);
  });

  afterEach(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  it('initializes with zero basis', () => {
    const l = svc.getLedger();
    expect(l.sol.totalSol).toBe(0);
    expect(l.sol.averageCostBrl).toBe(0);
    expect(l.usd.totalUsd).toBe(0);
  });

  it('updateAfterBuy sets correct AVCO for first purchase', () => {
    // Buy 10 SOL at R$800/SOL
    svc.updateAfterBuy(10, 160, 5.0, 800);
    const l = svc.getLedger();
    expect(l.sol.totalSol).toBe(10);
    expect(l.sol.averageCostBrl).toBeCloseTo(800, 4);
  });

  it('updateAfterBuy accumulates with AVCO on second purchase', () => {
    // First buy: 10 SOL @ R$800
    svc.updateAfterBuy(10, 160, 5.0, 800);
    // Second buy: 10 SOL @ R$1000
    svc.updateAfterBuy(10, 200, 5.0, 1000);
    const l = svc.getLedger();
    expect(l.sol.totalSol).toBeCloseTo(20, 6);
    expect(l.sol.averageCostBrl).toBeCloseTo(900, 4); // (8000 + 10000) / 20
  });

  it('updateAfterSell computes correct realized gain', () => {
    svc.updateAfterBuy(10, 160, 5.0, 800); // basis = R$800/SOL
    // Sell 5 SOL @ R$1000 → gain = (1000-800)*5 = R$1000
    const gain = svc.updateAfterSell(5, 1000, 5.0, 1000);
    expect(gain).toBeCloseTo(1000, 2);
  });

  it('updateAfterSell reduces SOL position', () => {
    svc.updateAfterBuy(10, 160, 5.0, 800);
    svc.updateAfterSell(4, 800, 5.0, 1000);
    const l = svc.getLedger();
    expect(l.sol.totalSol).toBeCloseTo(6, 6);
  });

  it('updateAfterSell adds to USD position with current FX basis', () => {
    svc.updateAfterBuy(10, 160, 5.0, 800);
    svc.updateAfterSell(5, 200, 5.0, 1000); // receive $200 at R$5/USD
    const l = svc.getLedger();
    expect(l.usd.totalUsd).toBeCloseTo(200, 2);
    expect(l.usd.averageCostBrl).toBeCloseTo(5.0, 4);
  });

  it('computeRealizedGainBrl is a pure function (no side effects)', () => {
    svc.updateAfterBuy(10, 160, 5.0, 800);
    const preview = svc.computeRealizedGainBrl(5, 1000);
    const l = svc.getLedger();
    // SOL position should be unchanged
    expect(l.sol.totalSol).toBeCloseTo(10, 6);
    expect(preview).toBeCloseTo(1000, 2); // (1000 - 800) * 5
  });

  it('handles zero SOL balance gracefully after full sell', () => {
    svc.updateAfterBuy(5, 100, 5.0, 800);
    svc.updateAfterSell(5, 100, 5.0, 800);
    const l = svc.getLedger();
    expect(l.sol.totalSol).toBeCloseTo(0, 6);
    expect(l.sol.averageCostBrl).toBe(0);
  });

  it('persists state across service instances', () => {
    svc.updateAfterBuy(10, 160, 5.0, 800);
    const svc2 = new CostBasisService(filePath);
    const l = svc2.getLedger();
    expect(l.sol.totalSol).toBe(10);
    expect(l.sol.averageCostBrl).toBeCloseTo(800, 4);
  });
});
