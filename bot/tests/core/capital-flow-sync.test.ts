import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncDeposits, syncWithdrawals, syncMbCapitalFlows, MbCapitalFlowAdapter } from '../../src/core/capital-flow-sync';
import { ShareLedgerService } from '../../src/core/tracker/shares';
import { getDbConfig } from '../../src/core/tracker/db';

function uniqueMemDbPath(): string {
  return `:memory:?mode=memory&cache=shared&hash=${Math.random()}`;
}

function makeAdapter(overrides: Partial<MbCapitalFlowAdapter> = {}): MbCapitalFlowAdapter {
  return {
    listFiatDeposits: vi.fn().mockResolvedValue([]),
    listWithdrawals: vi.fn().mockResolvedValue([]),
    getPortfolio: vi.fn().mockResolvedValue({ totalValueBrl: 1000 }),
    ...overrides,
  };
}

describe('capital-flow-sync — deposits', () => {
  let dbPath: string;
  let shares: ShareLedgerService;

  beforeEach(() => {
    dbPath = uniqueMemDbPath();
    shares = new ShareLedgerService(dbPath, 0);
  });

  it('records a new CREDITED deposit as a capital flow', async () => {
    const adapter = makeAdapter({
      listFiatDeposits: vi.fn().mockResolvedValue([
        { id: 1, amount: '500.00', status: 'CREDITED' },
      ]),
      getPortfolio: vi.fn().mockResolvedValue({ totalValueBrl: 1500 }),
    });

    await syncDeposits(adapter, shares, dbPath, 'mercadobitcoin');

    const flows = shares.readCapitalFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]!.type).toBe('DEPOSIT');
    expect(flows[0]!.brlAmount).toBe(500);
    expect(flows[0]!.totalValueBrlBefore).toBe(1000); // 1500 - 500, backed out (alreadyApplied)
  });

  it('ignores deposits that are not CREDITED yet', async () => {
    const adapter = makeAdapter({
      listFiatDeposits: vi.fn().mockResolvedValue([
        { id: 1, amount: '500.00', status: 'PENDING' },
      ]),
    });
    await syncDeposits(adapter, shares, dbPath, 'mercadobitcoin');
    expect(shares.readCapitalFlows()).toHaveLength(0);
  });

  it('does not re-process a deposit already synced (checkpoint advances)', async () => {
    const adapter = makeAdapter({
      listFiatDeposits: vi.fn().mockResolvedValue([
        { id: 1, amount: '500.00', status: 'CREDITED' },
      ]),
    });
    await syncDeposits(adapter, shares, dbPath, 'mercadobitcoin');
    await syncDeposits(adapter, shares, dbPath, 'mercadobitcoin'); // same deposit returned again

    expect(shares.readCapitalFlows()).toHaveLength(1);
    expect(getDbConfig('mb_last_synced_deposit_id', undefined, dbPath)).toBe('1');
  });

  it('processes multiple new deposits in ascending id order and advances the checkpoint to the latest', async () => {
    const adapter = makeAdapter({
      listFiatDeposits: vi.fn().mockResolvedValue([
        { id: 3, amount: '100.00', status: 'CREDITED' },
        { id: 2, amount: '200.00', status: 'CREDITED' },
      ]),
      getPortfolio: vi.fn().mockResolvedValue({ totalValueBrl: 1000 }),
    });
    await syncDeposits(adapter, shares, dbPath, 'mercadobitcoin');

    const flows = shares.readCapitalFlows();
    expect(flows).toHaveLength(2);
    expect(flows[0]!.brlAmount).toBe(200); // id 2 processed first
    expect(flows[1]!.brlAmount).toBe(100); // id 3 processed second
    expect(getDbConfig('mb_last_synced_deposit_id', undefined, dbPath)).toBe('3');
  });

  it('skips a malformed deposit (bad amount) without throwing, and still advances the checkpoint', async () => {
    const adapter = makeAdapter({
      listFiatDeposits: vi.fn().mockResolvedValue([
        { id: 1, amount: 'not-a-number', status: 'CREDITED' },
      ]),
    });
    await expect(syncDeposits(adapter, shares, dbPath, 'mercadobitcoin')).resolves.not.toThrow();
    expect(shares.readCapitalFlows()).toHaveLength(0);
    expect(getDbConfig('mb_last_synced_deposit_id', undefined, dbPath)).toBe('1');
  });

  it('does not call getPortfolio when there is nothing new to sync', async () => {
    const adapter = makeAdapter();
    await syncDeposits(adapter, shares, dbPath, 'mercadobitcoin');
    expect(adapter.getPortfolio).not.toHaveBeenCalled();
  });
});

describe('capital-flow-sync — withdrawals', () => {
  let dbPath: string;
  let shares: ShareLedgerService;

  beforeEach(() => {
    dbPath = uniqueMemDbPath();
    shares = new ShareLedgerService(dbPath, 0);
  });

  it('records a done (status 2) withdrawal as a capital flow, using gross quantity', async () => {
    const adapter = makeAdapter({
      listWithdrawals: vi.fn().mockResolvedValue([
        { id: 1, quantity: '300.00', status: 2 },
      ]),
      getPortfolio: vi.fn().mockResolvedValue({ totalValueBrl: 700 }),
    });

    await syncWithdrawals(adapter, shares, dbPath, 'mercadobitcoin');

    const flows = shares.readCapitalFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]!.type).toBe('WITHDRAWAL');
    expect(flows[0]!.brlAmount).toBe(300);
    expect(flows[0]!.totalValueBrlBefore).toBe(1000); // 700 + 300, backed out
  });

  it('ignores an open (status 1) withdrawal and does not advance the checkpoint past it', async () => {
    const adapter = makeAdapter({
      listWithdrawals: vi.fn().mockResolvedValue([
        { id: 1, quantity: '300.00', status: 1 },
      ]),
    });
    await syncWithdrawals(adapter, shares, dbPath, 'mercadobitcoin');
    expect(shares.readCapitalFlows()).toHaveLength(0);
    expect(getDbConfig('mb_last_synced_withdrawal_id', undefined, dbPath)).toBeNull();
  });

  it('ignores a canceled (status 3) withdrawal', async () => {
    const adapter = makeAdapter({
      listWithdrawals: vi.fn().mockResolvedValue([
        { id: 1, quantity: '300.00', status: 3 },
      ]),
    });
    await syncWithdrawals(adapter, shares, dbPath, 'mercadobitcoin');
    expect(shares.readCapitalFlows()).toHaveLength(0);
  });

  it('picks up a withdrawal on a later cycle once it transitions from open to done', async () => {
    const openAdapter = makeAdapter({
      listWithdrawals: vi.fn().mockResolvedValue([{ id: 1, quantity: '300.00', status: 1 }]),
    });
    await syncWithdrawals(openAdapter, shares, dbPath, 'mercadobitcoin');
    expect(shares.readCapitalFlows()).toHaveLength(0);

    const doneAdapter = makeAdapter({
      listWithdrawals: vi.fn().mockResolvedValue([{ id: 1, quantity: '300.00', status: 2 }]),
      getPortfolio: vi.fn().mockResolvedValue({ totalValueBrl: 700 }),
    });
    await syncWithdrawals(doneAdapter, shares, dbPath, 'mercadobitcoin');
    expect(shares.readCapitalFlows()).toHaveLength(1);
  });
});

describe('capital-flow-sync — syncMbCapitalFlows', () => {
  it('runs both deposit and withdrawal sync', async () => {
    const dbPath = uniqueMemDbPath();
    const shares = new ShareLedgerService(dbPath, 0);
    const adapter = makeAdapter({
      listFiatDeposits: vi.fn().mockResolvedValue([{ id: 1, amount: '100.00', status: 'CREDITED' }]),
      listWithdrawals: vi.fn().mockResolvedValue([{ id: 1, quantity: '50.00', status: 2 }]),
      getPortfolio: vi.fn().mockResolvedValue({ totalValueBrl: 1000 }),
    });

    await syncMbCapitalFlows(adapter, shares, dbPath, 'mercadobitcoin');

    const flows = shares.readCapitalFlows();
    expect(flows).toHaveLength(2);
    expect(flows.map((f) => f.type).sort()).toEqual(['DEPOSIT', 'WITHDRAWAL']);
  });
});
