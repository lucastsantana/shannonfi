import * as fs from 'fs';
import * as path from 'path';
import { TradeRecord, PortfolioSnapshot } from '../../adapters/types';
import { logger } from './logger';

export class TradeHistoryService {
  private filePath: string;
  private snapshotPath: string;

  constructor(filePath: string, snapshotPath?: string) {
    this.filePath = path.resolve(filePath);
    this.snapshotPath = path.resolve(
      snapshotPath ?? path.join(path.dirname(filePath), 'portfolio_snapshots.json'),
    );

    for (const p of [this.filePath, this.snapshotPath]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) {
        fs.writeFileSync(p, JSON.stringify([], null, 2));
      }
    }
  }

  async appendTrade(record: TradeRecord): Promise<void> {
    const trades = this.readTrades();
    trades.push(record);
    fs.writeFileSync(this.filePath, JSON.stringify(trades, null, 2));
    logger.debug('Trade record persisted', { id: record.id, exchange: record.exchange });
  }

  readTrades(): TradeRecord[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as TradeRecord[];
    } catch {
      return [];
    }
  }

  getRebalanceCount(): number {
    return this.readTrades().filter(isSuccessful).length;
  }

  getLastRebalanceTime(): number {
    const trades = this.readTrades().filter(isSuccessful);
    if (trades.length === 0) return 0;
    trades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return new Date(trades[trades.length - 1]!.timestamp).getTime();
  }

  getLastRebalanceInfo(): {
    dateBRT: string | null;
    direction: 'BUY_SOL' | 'SELL_SOL' | null;
  } {
    const trades = this.readTrades().filter(isSuccessful);
    if (trades.length === 0) return { dateBRT: null, direction: null };
    trades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const last = trades[trades.length - 1]!;
    const dateBRT =
      last.tradeDateBRT ??
      new Date(last.timestamp).toLocaleDateString('en-CA', {
        timeZone: 'America/Sao_Paulo',
      });
    return { dateBRT, direction: last.direction };
  }

  appendSnapshot(snapshot: PortfolioSnapshot): void {
    const snapshots = this.readSnapshots();
    snapshots.push(snapshot);
    fs.writeFileSync(this.snapshotPath, JSON.stringify(snapshots, null, 2));
    logger.debug('Portfolio snapshot persisted', { date: snapshot.dateBRT });
  }

  readSnapshots(): PortfolioSnapshot[] {
    try {
      const raw = fs.readFileSync(this.snapshotPath, 'utf-8');
      return JSON.parse(raw) as PortfolioSnapshot[];
    } catch {
      return [];
    }
  }
}

/** Accept both uppercase (new) and lowercase (legacy MB on-disk) status strings. */
function isSuccessful(t: TradeRecord): boolean {
  return t.status === 'FILLED' || t.status === 'DRY_RUN';
}
