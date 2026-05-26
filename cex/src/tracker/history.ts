import * as fs from 'fs';
import * as path from 'path';
import { TradeRecord } from '../coinbase/types';
import { logger } from './logger';

export class TradeHistoryService {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([], null, 2));
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
      (t) => t.status === 'FILLED' || t.status === 'DRY_RUN',
    ).length;
  }

  /**
   * Returns the Unix ms timestamp of the last successful rebalance, or 0 if none.
   * Used by RebalancerBot to restore the cooldown guard after a restart or across
   * --once invocations (e.g. GitHub Actions), provided the history file is available.
   */
  getLastRebalanceTime(): number {
    const trades = this.readTrades();
    const successful = trades
      .filter((t) => t.status === 'FILLED' || t.status === 'DRY_RUN')
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (successful.length === 0) return 0;
    return new Date(successful[successful.length - 1]!.timestamp).getTime();
  }
}
