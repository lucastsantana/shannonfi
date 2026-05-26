import * as fs from 'fs';
import * as path from 'path';
import { TradeRecord, PortfolioSnapshot } from '../mb/types';
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
    logger.debug('Trade record persisted', { id: record.id });
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
    return this.readTrades().filter(
      (t) => t.status === 'filled' || t.status === 'DRY_RUN',
    ).length;
  }

  getLastRebalanceTime(): number {
    const trades = this.readTrades();
    const successful = trades
      .filter((t) => t.status === 'filled' || t.status === 'DRY_RUN')
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (successful.length === 0) return 0;
    return new Date(successful[successful.length - 1]!.timestamp).getTime();
  }

  getLastRebalanceInfo(): {
    dateBRT: string | null;
    direction: 'BUY_SOL' | 'SELL_SOL' | null;
  } {
    const trades = this.readTrades();
    const successful = trades
      .filter((t) => t.status === 'filled' || t.status === 'DRY_RUN')
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (successful.length === 0) return { dateBRT: null, direction: null };

    const last = successful[successful.length - 1]!;
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
