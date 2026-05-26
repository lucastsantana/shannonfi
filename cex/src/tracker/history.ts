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
}
