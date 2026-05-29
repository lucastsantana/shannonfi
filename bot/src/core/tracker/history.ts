/**
 * Trade history service — backed by SQLite.
 * Stores and retrieves trade records and portfolio snapshots.
 * Also dual-writes to JSON files for 15-day rolling backup.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { TradeRecord, PortfolioSnapshot } from '../../adapters/types';
import { logger } from './logger';
import { getDb } from './db';
import { loadConfig } from '../../config';

const DATA_DIR = path.resolve(__dirname, '../../../data');

export class TradeHistoryService {
  private db: Database.Database;
  private retentionDays: number;

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
    try {
      const config = loadConfig();
      this.retentionDays = config.jsonRetentionDays ?? 15;
    } catch {
      this.retentionDays = 15; // default
    }
  }

  async appendTrade(record: TradeRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        id, client_order_id, exchange_order_id, exchange, timestamp, direction,
        brl_amount_target, sol_amount_filled, brl_amount_filled, fill_price, fee_brl,
        status, dry_run, realized_gain_brl, trade_date_brt,
        before_sol_balance, before_brl_balance, before_sol_price, before_sol_value,
        before_total_value, before_sol_ratio_bps, before_deviation_bps, before_timestamp,
        after_sol_balance, after_brl_balance, after_sol_price, after_sol_value,
        after_total_value, after_sol_ratio_bps, after_deviation_bps, after_timestamp
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    const before = record.portfolioBefore;
    const after = record.portfolioAfter;

    stmt.run(
      record.id,
      record.clientOrderId,
      record.exchangeOrderId,
      record.exchange,
      record.timestamp,
      record.direction,
      record.brlAmountTarget,
      record.baseAmountFilled ?? null,
      record.brlAmountFilled ?? null,
      record.fillPrice ?? null,
      record.feeBrl ?? null,
      record.status,
      record.dryRun ? 1 : 0,
      record.realizedGainBrl ?? null,
      record.tradeDateBRT ?? null,
      before.baseBalance,
      before.brlBalance,
      before.basePrice,
      before.baseValueBrl,
      before.totalValueBrl,
      before.baseRatioBps,
      before.deviationBps,
      before.timestamp,
      after?.baseBalance ?? null,
      after?.brlBalance ?? null,
      after?.basePrice ?? null,
      after?.baseValueBrl ?? null,
      after?.totalValueBrl ?? null,
      after?.baseRatioBps ?? null,
      after?.deviationBps ?? null,
      after?.timestamp ?? null,
    );

    logger.debug('Trade record persisted', { id: record.id, exchange: record.exchange });
    this.writeTradeHistoryToJson();
  }

  private writeTradeHistoryToJson(): void {
    if (this.retentionDays === 0) return;
    try {
      const trades = this.readTrades();
      const cutoff = this.getCutoffDate();
      const filtered = trades.filter((t) => new Date(t.timestamp) >= cutoff);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'trade_history.json'), JSON.stringify(filtered, null, 2), 'utf-8');
    } catch (err) {
      logger.debug('Failed to write trade history JSON', { error: (err as Error).message });
    }
  }

  private getCutoffDate(): Date {
    const d = new Date();
    d.setDate(d.getDate() - this.retentionDays);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  readTrades(): TradeRecord[] {
    const stmt = this.db.prepare('SELECT * FROM trades ORDER BY timestamp ASC');
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      exchangeOrderId: row.exchange_order_id,
      exchange: row.exchange,
      timestamp: row.timestamp,
      direction: row.direction,
      brlAmountTarget: row.brl_amount_target,
      baseAmountFilled: row.sol_amount_filled,
      brlAmountFilled: row.brl_amount_filled,
      fillPrice: row.fill_price,
      feeBrl: row.fee_brl,
      status: row.status,
      dryRun: row.dry_run === 1,
      realizedGainBrl: row.realized_gain_brl,
      tradeDateBRT: row.trade_date_brt,
      portfolioBefore: {
        baseBalance: row.before_sol_balance,
        brlBalance: row.before_brl_balance,
        basePrice: row.before_sol_price,
        baseValueBrl: row.before_sol_value,
        totalValueBrl: row.before_total_value,
        baseRatioBps: row.before_sol_ratio_bps,
        deviationBps: row.before_deviation_bps,
        timestamp: row.before_timestamp,
      },
      portfolioAfter: row.after_sol_balance !== null ? {
        baseBalance: row.after_sol_balance,
        brlBalance: row.after_brl_balance,
        basePrice: row.after_sol_price,
        baseValueBrl: row.after_sol_value,
        totalValueBrl: row.after_total_value,
        baseRatioBps: row.after_sol_ratio_bps,
        deviationBps: row.after_deviation_bps,
        timestamp: row.after_timestamp,
      } : null,
    } as TradeRecord));
  }

  getRebalanceCount(): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM trades WHERE status IN ('FILLED', 'DRY_RUN')"
    );
    const result = stmt.get() as { count: number };
    return result.count;
  }

  getLastRebalanceTime(): number {
    const stmt = this.db.prepare(
      "SELECT MAX(timestamp) as timestamp FROM trades WHERE status IN ('FILLED', 'DRY_RUN')"
    );
    const result = stmt.get() as { timestamp: string | null };
    if (!result.timestamp) return 0;
    return new Date(result.timestamp).getTime();
  }

  getLastRebalanceInfo(): {
    dateBRT: string | null;
    direction: 'BUY_BASE' | 'SELL_BASE' | null;
  } {
    const stmt = this.db.prepare(`
      SELECT trade_date_brt, direction, timestamp
      FROM trades
      WHERE status IN ('FILLED', 'DRY_RUN')
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const result = stmt.get() as { trade_date_brt: string | null; direction: string; timestamp: string } | undefined;

    if (!result) return { dateBRT: null, direction: null };

    const dateBRT = result.trade_date_brt ??
      new Date(result.timestamp).toLocaleDateString('en-CA', {
        timeZone: 'America/Sao_Paulo',
      });

    return { dateBRT, direction: result.direction as 'BUY_BASE' | 'SELL_BASE' };
  }

  appendSnapshot(snapshot: PortfolioSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO portfolio_snapshots (
        date_brt, timestamp, total_value_brl, sol_balance, brl_balance,
        sol_price, sol_ratio_bps, effective_threshold_bps, rebalanced_today, exchange
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      snapshot.dateBRT,
      snapshot.timestamp,
      snapshot.totalValueBrl,
      snapshot.baseBalance,
      snapshot.brlBalance,
      snapshot.basePrice,
      snapshot.baseRatioBps,
      snapshot.effectiveThresholdBps,
      snapshot.rebalancedToday ? 1 : 0,
      snapshot.exchange,
    );

    logger.debug('Portfolio snapshot persisted', { date: snapshot.dateBRT });
    this.writePortfolioSnapshotsToJson();
  }

  private writePortfolioSnapshotsToJson(): void {
    if (this.retentionDays === 0) return;
    try {
      const snapshots = this.readSnapshots();
      const cutoff = this.getCutoffDateBrt();
      const filtered = snapshots.filter((s) => s.dateBRT >= cutoff);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'portfolio_snapshots.json'), JSON.stringify(filtered, null, 2), 'utf-8');
    } catch (err) {
      logger.debug('Failed to write portfolio snapshots JSON', { error: (err as Error).message });
    }
  }

  private getCutoffDateBrt(): string {
    const cutoff = this.getCutoffDate();
    return cutoff.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  readSnapshots(): PortfolioSnapshot[] {
    const stmt = this.db.prepare('SELECT * FROM portfolio_snapshots ORDER BY date_brt ASC');
    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      dateBRT: row.date_brt,
      timestamp: row.timestamp,
      totalValueBrl: row.total_value_brl,
      baseBalance: row.sol_balance,
      brlBalance: row.brl_balance,
      basePrice: row.sol_price,
      baseRatioBps: row.sol_ratio_bps,
      effectiveThresholdBps: row.effective_threshold_bps,
      rebalancedToday: row.rebalanced_today === 1,
      exchange: row.exchange,
    } as PortfolioSnapshot));
  }
}
