import axios from 'axios';
import { logger } from '../tracker/logger';
import { TradeRecord } from '../../adapters/types';
import { TelegramConfig } from '../../config';
import { getTelegramCredentials } from '../keyring';

interface PortfolioState {
  baseBalance: number;
  brlBalance: number;
  basePrice: number;
  baseValueBrl: number;
  baseRatioBps: number;
  deviationBps: number;
}

export class TelegramService {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly apiUrl: string;

  constructor(config: TelegramConfig) {
    if (!config?.chatId) {
      throw new Error('Telegram chatId is required in config');
    }

    const credentials = getTelegramCredentials();
    if (!credentials) {
      throw new Error(
        'Telegram bot token not found in GNOME Keyring.\n' +
        'Store it with:\n' +
        '  secret-tool store --label="Telegram Bot Token" service telegram key botToken <YOUR_BOT_TOKEN>\n' +
        'Get a bot token from @BotFather on Telegram.'
      );
    }

    this.botToken = credentials.botToken;
    this.chatId = config.chatId;
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  async sendTradeNotification(
    trade: TradeRecord,
    baseAsset: string,
    before: PortfolioState,
    after: PortfolioState,
  ): Promise<void> {
    try {
      const direction = trade.direction === 'BUY_BASE' ? '🟢 BUY' : '🔴 SELL';
      const directionFull = trade.direction === 'BUY_BASE' ? 'BUY' : 'SELL';
      const statusEmoji = trade.status === 'FILLED' ? '✅' : '⏳';

      const message = this.formatTradeMessage(
        direction,
        statusEmoji,
        directionFull,
        trade,
        baseAsset,
        before,
        after,
      );

      await this.sendMessage(message);
    } catch (err) {
      logger.warn('Failed to send Telegram notification', {
        error: (err as Error).message,
        tradeId: trade.id,
      });
    }
  }

  private formatTradeMessage(
    direction: string,
    statusEmoji: string,
    directionFull: string,
    trade: TradeRecord,
    baseAsset: string,
    before: PortfolioState,
    after: PortfolioState,
  ): string {
    const lines: string[] = [];

    lines.push(`${direction} ${statusEmoji}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    lines.push(`<b>Direction:</b> ${directionFull} ${baseAsset}`);
    lines.push(
      `<b>Amount:</b> R$ ${(trade.brlAmountFilled ?? 0).toFixed(2)} → ${(trade.baseAmountFilled ?? 0).toFixed(6)} ${baseAsset}`,
    );
    lines.push(`<b>Fill Price:</b> R$ ${(trade.fillPrice ?? 0).toFixed(2)}/${baseAsset}`);
    lines.push(`<b>Fee:</b> R$ ${(trade.feeBrl ?? 0).toFixed(2)}`);
    lines.push(`<b>Status:</b> ${trade.status}`);
    lines.push('');

    lines.push('<b>Portfolio (Before)</b>');
    lines.push(`├─ ${baseAsset}: R$ ${before.baseValueBrl.toFixed(2)} (${(before.baseRatioBps / 100).toFixed(2)}%)`);
    lines.push(`└─ BRL: R$ ${before.brlBalance.toFixed(2)} (${((10000 - before.baseRatioBps) / 100).toFixed(2)}%)`);
    lines.push('');

    lines.push('<b>Portfolio (After)</b>');
    lines.push(`├─ ${baseAsset}: R$ ${after.baseValueBrl.toFixed(2)} (${(after.baseRatioBps / 100).toFixed(2)}%)`);
    lines.push(`└─ BRL: R$ ${after.brlBalance.toFixed(2)} (${((10000 - after.baseRatioBps) / 100).toFixed(2)}%)`);
    lines.push('');

    const deviationBefore = before.deviationBps / 100;
    const deviationAfter = after.deviationBps / 100;
    lines.push(`<b>Drift:</b> ${deviationBefore.toFixed(2)}% → ${deviationAfter.toFixed(2)}%`);

    return lines.join('\n');
  }

  async sendMessage(text: string): Promise<void> {
    await axios.post(`${this.apiUrl}/sendMessage`, {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    logger.debug('Telegram message sent');
  }
}
