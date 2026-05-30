import { logger } from '../tracker/logger';
import { TradeHistoryService } from '../tracker/history';
import { TelegramService } from './telegram';

interface DailyDigestData {
  dateBRT: string;
  dailyReturnPct: number;
  dailyReturnBrl: number;
  startValueBrl: number;
  endValueBrl: number;
  totalFeesBrl: number;
  rebalanceCount: number;
  buyCount: number;
  sellCount: number;
  startBaseBalance: number;
  endBaseBalance: number;
  startBrlBalance: number;
  endBrlBalance: number;
  startBasePrice: number;
  endBasePrice: number;
  startBaseRatioBps: number;
  endBaseRatioBps: number;
}

export class DailyDigestService {
  constructor(
    private history: TradeHistoryService,
    private telegram: TelegramService | null,
    private baseAsset: string,
  ) {}

  async sendDailyDigestIfScheduled(): Promise<void> {
    if (!this.telegram) {
      return;
    }

    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Check if it's 00:30 BRT (within a 5-minute window to handle clock variance)
    const isMidnightWindow = hour === 0 && minute >= 30 && minute < 35;

    if (!isMidnightWindow) {
      return;
    }

    try {
      await this.sendDigest();
    } catch (err) {
      logger.warn('Failed to send daily digest', {
        error: (err as Error).message,
      });
    }
  }

  private async sendDigest(): Promise<void> {
    // Get yesterday's date in BRT
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayBRT = yesterday.toLocaleDateString('en-CA', {
      timeZone: 'America/Sao_Paulo',
    });

    // Compile digest data
    const digest = this.compileDigest(yesterdayBRT);
    if (!digest) {
      logger.debug('No trading data for yesterday, skipping digest', { date: yesterdayBRT });
      return;
    }

    // Format and send message
    const message = this.formatDigestMessage(digest);
    await this.telegram!.sendMessage(message);

    logger.info('Daily digest sent', { date: yesterdayBRT });
  }

  private compileDigest(dateBRT: string): DailyDigestData | null {
    const snapshots = this.history.readSnapshots();
    const trades = this.history.readTrades().filter((t) => t.tradeDateBRT === dateBRT && (t.status === 'FILLED' || t.status === 'DRY_RUN'));

    // Get start and end snapshots for the day
    const daySnapshot = snapshots.find((s) => s.dateBRT === dateBRT);
    if (!daySnapshot) {
      return null;
    }

    // Get previous day's snapshot to calculate start values
    const snapshotIndex = snapshots.indexOf(daySnapshot);
    const prevSnapshot = snapshotIndex > 0 ? snapshots[snapshotIndex - 1] : null;

    const startValueBrl = prevSnapshot?.totalValueBrl ?? daySnapshot.totalValueBrl;
    const endValueBrl = daySnapshot.totalValueBrl;
    const dailyReturnBrl = endValueBrl - startValueBrl;
    const dailyReturnPct = startValueBrl > 0 ? (dailyReturnBrl / startValueBrl) * 100 : 0;

    const totalFeesBrl = trades.reduce((sum, t) => sum + (t.feeBrl ?? 0), 0);
    const rebalanceCount = trades.length;
    const buyCount = trades.filter((t) => t.direction === 'BUY_BASE').length;
    const sellCount = trades.filter((t) => t.direction === 'SELL_BASE').length;

    return {
      dateBRT,
      dailyReturnPct,
      dailyReturnBrl,
      startValueBrl,
      endValueBrl,
      totalFeesBrl,
      rebalanceCount,
      buyCount,
      sellCount,
      startBaseBalance: prevSnapshot?.baseBalance ?? daySnapshot.baseBalance,
      endBaseBalance: daySnapshot.baseBalance,
      startBrlBalance: prevSnapshot?.brlBalance ?? daySnapshot.brlBalance,
      endBrlBalance: daySnapshot.brlBalance,
      startBasePrice: prevSnapshot?.basePrice ?? daySnapshot.basePrice,
      endBasePrice: daySnapshot.basePrice,
      startBaseRatioBps: prevSnapshot?.baseRatioBps ?? daySnapshot.baseRatioBps,
      endBaseRatioBps: daySnapshot.baseRatioBps,
    };
  }

  private formatDigestMessage(digest: DailyDigestData): string {
    const lines: string[] = [];

    const returnEmoji = digest.dailyReturnPct >= 0 ? '📈' : '📉';
    const returnSign = digest.dailyReturnPct >= 0 ? '+' : '';

    lines.push(`${returnEmoji} <b>DAILY DIGEST — ${digest.dateBRT}</b>`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    lines.push(`<b>Return:</b> ${returnSign}${digest.dailyReturnPct.toFixed(2)}% (${returnSign}R$ ${digest.dailyReturnBrl.toFixed(2)})`);
    lines.push(`<b>Fees Paid:</b> R$ ${digest.totalFeesBrl.toFixed(2)}`);
    lines.push('');

    lines.push('<b>Trading Activity</b>');
    lines.push(`├─ Rebalances: ${digest.rebalanceCount}`);
    lines.push(`├─ Buys: ${digest.buyCount}`);
    lines.push(`└─ Sells: ${digest.sellCount}`);
    lines.push('');

    lines.push('<b>Portfolio</b>');
    lines.push(`├─ Start: R$ ${digest.startValueBrl.toFixed(2)}`);
    lines.push(`└─ End: R$ ${digest.endValueBrl.toFixed(2)}`);
    lines.push('');

    lines.push(`<b>${this.baseAsset} Allocation</b>`);
    lines.push(`├─ Start: ${(digest.startBaseRatioBps / 100).toFixed(2)}%`);
    lines.push(`└─ End: ${(digest.endBaseRatioBps / 100).toFixed(2)}%`);
    lines.push('');

    lines.push(`<b>${this.baseAsset} Price</b>`);
    lines.push(`├─ Start: R$ ${digest.startBasePrice.toFixed(2)}`);
    lines.push(`├─ End: R$ ${digest.endBasePrice.toFixed(2)}`);
    const priceChange = digest.endBasePrice - digest.startBasePrice;
    const priceChangePct = digest.startBasePrice > 0 ? (priceChange / digest.startBasePrice) * 100 : 0;
    const priceChangeSign = priceChange >= 0 ? '+' : '';
    lines.push(`└─ Change: ${priceChangeSign}R$ ${priceChange.toFixed(2)} (${priceChangeSign}${priceChangePct.toFixed(2)}%)`);

    return lines.join('\n');
  }
}
