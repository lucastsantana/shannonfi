import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CostBasisService } from '../../src/core/tracker/costbasis';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpPath(): string {
  return path.join(os.tmpdir(), `bot-costbasis-test-${Date.now()}-${Math.random()}.json`);
}

describe('CostBasisService (BRL-native AVCO)', () => {
  let filePath: string;
  let svc: CostBasisService;

  beforeEach(() => {
    filePath = tmpPath();
    svc = new CostBasisService(filePath);
  });

  afterEach(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  it('starts with empty ledger', () => {
    const ledger = svc.getLedger();
    expect(ledger.sol.averageCostBrl).toBe(0);
    expect(ledger.sol.totalSol).toBe(0);
  });

  it('updateAfterBuy sets correct average cost', () => {
    svc.updateAfterBuy(2, 800);
    const ledger = svc.getLedger();
    expect(ledger.sol.averageCostBrl).toBeCloseTo(400, 5);
    expect(ledger.sol.totalSol).toBeCloseTo(2, 5);
  });

  it('updateAfterBuy computes weighted average on second buy', () => {
    svc.updateAfterBuy(2, 800);   // avg 400
    svc.updateAfterBuy(2, 1000);  // (800+1000)/4 = 450
    const ledger = svc.getLedger();
    expect(ledger.sol.averageCostBrl).toBeCloseTo(450, 5);
    expect(ledger.sol.totalSol).toBeCloseTo(4, 5);
  });

  it('updateAfterSell returns correct realized gain', () => {
    svc.updateAfterBuy(4, 1600);           // avg R$400/SOL
    const gain = svc.updateAfterSell(2, 1000); // sell 2 SOL at R$500 → 1000 - 800 = 200
    expect(gain).toBeCloseTo(200, 5);
  });

  it('updateAfterSell reduces SOL position', () => {
    svc.updateAfterBuy(4, 1600);
    svc.updateAfterSell(1, 500);
    expect(svc.getLedger().sol.totalSol).toBeCloseTo(3, 5);
  });

  it('AVCO: average cost unchanged after partial sell', () => {
    svc.updateAfterBuy(4, 1600);     // avg R$400
    svc.updateAfterSell(2, 1000);
    expect(svc.getLedger().sol.averageCostBrl).toBeCloseTo(400, 5);
  });

  it('computeRealizedGainBrl is pure (no side effects)', () => {
    svc.updateAfterBuy(2, 800);    // avg R$400
    const preview = svc.computeRealizedGainBrl(1, 500); // gain = 500 - 400 = 100
    expect(preview).toBeCloseTo(100, 5);
    expect(svc.getLedger().sol.totalSol).toBeCloseTo(2, 5); // unchanged
  });

  it('realizes negative gain (loss) when selling below cost', () => {
    svc.updateAfterBuy(2, 1000);   // avg R$500
    const gain = svc.updateAfterSell(2, 600); // 600 - 1000 = -400
    expect(gain).toBeCloseTo(-400, 5);
  });

  it('persists across instances', () => {
    svc.updateAfterBuy(3, 1200);
    const svc2 = new CostBasisService(filePath);
    expect(svc2.getLedger().sol.totalSol).toBeCloseTo(3, 5);
    expect(svc2.getLedger().sol.averageCostBrl).toBeCloseTo(400, 5);
  });
});
