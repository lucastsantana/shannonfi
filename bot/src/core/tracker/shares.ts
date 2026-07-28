/**
 * Fund-share (NAV-per-share) ledger — backed by SQLite.
 * Lets an instance's total_value_brl grow/shrink from external capital deposits and
 * withdrawals without those flows being misread as trading performance: every flow
 * issues or redeems shares at the NAV/share prevailing just before it, so nav/share
 * itself only ever moves with actual portfolio performance (rebalance gains, price
 * moves, fees). See CLAUDE.md, "Fund-share accounting".
 *
 * Also dual-writes to a JSON file for a 15-day rolling human-readable backup, same
 * pattern as TradeHistoryService/TaxService.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';
import { getDb } from './db';
import { DEFAULT_INITIAL_SHARES } from '../../constants';

export type CapitalFlowType = 'DEPOSIT' | 'WITHDRAWAL';

export interface CapitalFlowRecord {
  id: string;
  timestamp: string;
  dateBRT: string;
  type: CapitalFlowType;
  brlAmount: number;
  navPerShareBefore: number;
  sharesDelta: number;
  totalSharesAfter: number;
  totalValueBrlBefore: number;
  totalValueBrlAfter: number;
  exchange: string;
  note: string | null;
}

export interface RecordCapitalFlowParams {
  type: CapitalFlowType;
  brlAmount: number;
  /** Live portfolio total_value_brl at the moment you're recording this flow. */
  currentTotalValueBrl: number;
  /**
   * Set true if the money has already been moved on the exchange (currentTotalValueBrl
   * already reflects it) — the service backs the amount back out to find the pre-flow
   * value. Defaults false: the recommended flow is to run this BEFORE moving the money,
   * so currentTotalValueBrl is already the pre-flow value and no backing-out is needed.
   */
  alreadyApplied?: boolean;
  exchange: string;
  note?: string;
}

export interface ShareState {
  sharesOutstanding: number;
  navPerShare: number;
}

export class ShareLedgerService {
  private db: Database.Database;
  private retentionDays: number;
  private dataDir: string;

  constructor(dbPath: string | undefined, retentionDays: number = 15) {
    this.db = getDb(dbPath);
    this.retentionDays = retentionDays;
    const isInMemory = !dbPath || dbPath.startsWith(':memory:');
    const resolvedDbPath = isInMemory ? path.resolve(__dirname, '../../../data/shannonfi.db') : dbPath;
    this.dataDir = path.dirname(resolvedDbPath);
  }

  /**
   * Shares outstanding + nav/share for a given live totalValueBrl. If nothing has ever
   * been recorded for this instance (no capital flows, no prior snapshot with shares
   * populated), bootstraps at nav/share = 1.00 — an arbitrary but harmless starting
   * point, since only the ratio to future nav/share values (i.e. returns) matters.
   */
  getShareState(totalValueBrl: number): ShareState {
    const { shares, navPerShare } = this.resolveShareBasis(totalValueBrl);
    return { sharesOutstanding: shares, navPerShare };
  }

  /**
   * Records a deposit or withdrawal, issuing/redeeming shares at the nav/share
   * prevailing just before the flow so nav/share itself is unaffected by the flow.
   */
  recordCapitalFlow(params: RecordCapitalFlowParams): CapitalFlowRecord {
    if (params.brlAmount <= 0) throw new Error('brlAmount must be positive');

    const sign = params.type === 'DEPOSIT' ? 1 : -1;
    const totalValueBrlBefore = params.alreadyApplied
      ? params.currentTotalValueBrl - sign * params.brlAmount
      : params.currentTotalValueBrl;
    const totalValueBrlAfter = params.alreadyApplied
      ? params.currentTotalValueBrl
      : params.currentTotalValueBrl + sign * params.brlAmount;

    const { shares: sharesBefore, navPerShare: navPerShareBefore } = this.resolveShareBasis(totalValueBrlBefore);
    if (navPerShareBefore <= 0) {
      throw new Error(
        `Cannot record a capital flow: nav/share before the flow is ${navPerShareBefore} ` +
        `(portfolio value ${totalValueBrlBefore} against ${sharesBefore} outstanding shares).`,
      );
    }

    const sharesDelta = (sign * params.brlAmount) / navPerShareBefore;
    const totalSharesAfter = sharesBefore + sharesDelta;

    const now = new Date();
    const record: CapitalFlowRecord = {
      id: uuidv4(),
      timestamp: now.toISOString(),
      dateBRT: now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }),
      type: params.type,
      brlAmount: params.brlAmount,
      navPerShareBefore,
      sharesDelta,
      totalSharesAfter,
      totalValueBrlBefore,
      totalValueBrlAfter,
      exchange: params.exchange,
      note: params.note ?? null,
    };

    this.db.prepare(`
      INSERT INTO capital_flows (
        id, timestamp, date_brt, type, brl_amount, nav_per_share_before, shares_delta,
        total_shares_after, total_value_brl_before, total_value_brl_after, exchange, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.timestamp, record.dateBRT, record.type, record.brlAmount,
      record.navPerShareBefore, record.sharesDelta, record.totalSharesAfter,
      record.totalValueBrlBefore, record.totalValueBrlAfter, record.exchange, record.note,
    );

    logger.info('Capital flow recorded', {
      type: record.type,
      brlAmount: record.brlAmount.toFixed(2),
      navPerShareBefore: record.navPerShareBefore.toFixed(6),
      sharesDelta: record.sharesDelta.toFixed(6),
      totalSharesAfter: record.totalSharesAfter.toFixed(6),
    });

    this.writeCapitalFlowsToJson();
    return record;
  }

  readCapitalFlows(): CapitalFlowRecord[] {
    const rows = this.db.prepare('SELECT * FROM capital_flows ORDER BY timestamp ASC').all() as any[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      dateBRT: row.date_brt,
      type: row.type,
      brlAmount: row.brl_amount,
      navPerShareBefore: row.nav_per_share_before,
      sharesDelta: row.shares_delta,
      totalSharesAfter: row.total_shares_after,
      totalValueBrlBefore: row.total_value_brl_before,
      totalValueBrlAfter: row.total_value_brl_after,
      exchange: row.exchange,
      note: row.note,
    }));
  }

  private resolveShareBasis(totalValueBrl: number): { shares: number; navPerShare: number } {
    const shares = this.getSharesOutstandingRaw();
    if (shares > 0) return { shares, navPerShare: totalValueBrl / shares };
    if (totalValueBrl > 0) {
      // First time share accounting sees an already-funded account (e.g. a fresh
      // instance whose exchange account already held a balance before its first
      // cycle ran) — anchor at a fixed, round share count rather than pinning
      // nav/share to 1.00, so nav/share reads as a real per-unit price from day
      // one. Same convention backfillShares() uses for historical data.
      return { shares: DEFAULT_INITIAL_SHARES, navPerShare: totalValueBrl / DEFAULT_INITIAL_SHARES };
    }
    // Genuinely empty account, nothing to anchor a share price to yet — 1.00 is a
    // neutral placeholder that lets a genesis deposit (recordCapitalFlow on a $0
    // account) issue shares 1-per-BRL; the deposit amount isn't known here to derive
    // a "100 shares total" price the way the already-funded branch above can.
    return { shares: 0, navPerShare: 1.0 };
  }

  private getSharesOutstandingRaw(): number {
    const flowRow = this.db
      .prepare('SELECT total_shares_after FROM capital_flows ORDER BY timestamp DESC LIMIT 1')
      .get() as { total_shares_after: number } | undefined;
    if (flowRow) return flowRow.total_shares_after;

    const snapRow = this.db
      .prepare(
        'SELECT total_shares_outstanding FROM portfolio_snapshots WHERE total_shares_outstanding IS NOT NULL ORDER BY date_brt DESC LIMIT 1',
      )
      .get() as { total_shares_outstanding: number } | undefined;
    return snapRow?.total_shares_outstanding ?? 0;
  }

  private writeCapitalFlowsToJson(): void {
    if (this.retentionDays === 0) return;
    try {
      const flows = this.readCapitalFlows();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.retentionDays);
      cutoff.setHours(0, 0, 0, 0);
      const filtered = flows.filter((f) => new Date(f.timestamp) >= cutoff);
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmpPath = path.join(this.dataDir, 'capital_flows.json.tmp');
      const targetPath = path.join(this.dataDir, 'capital_flows.json');
      fs.writeFileSync(tmpPath, JSON.stringify(filtered, null, 2), 'utf-8');
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      logger.debug('Failed to write capital flows JSON', { error: (err as Error).message });
    }
  }
}
