import { describe, it, expect, beforeEach } from 'vitest';
import { CostBasisService } from '../../src/core/tracker/costbasis';

describe('CostBasisService (BRL-native AVCO)', () => {
  let svc: CostBasisService;

  beforeEach(() => {
    // Each test gets a fresh unique :memory: database
    // by creating a unique path string
    const testPath = `:memory:?mode=memory&cache=shared&hash=${Math.random()}`;
    svc = new CostBasisService(testPath);
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
});
