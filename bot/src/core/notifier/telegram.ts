import { execSync } from 'child_process';
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
    const payload = {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    const jsonPayload = JSON.stringify(payload).replace(/"/g, '\\"');
    const cmd = `curl -s -X POST "${this.apiUrl}/sendMessage" -H "Content-Type: application/json" -d '${JSON.stringify(payload)}'`;

    try {
      execSync(cmd, { stdio: 'ignore' });
      logger.debug('Telegram message sent');
    } catch (err) {
      logger.warn('Failed to send Telegram message', { error: (err as Error).message });
      throw err;
    }
  }

  async sendMessageWithButtons(
    text: string,
    buttons: Array<Array<{ text: string; callbackData: string }>>,
  ): Promise<number> {
    // Convert callbackData to callback_data for Telegram API
    const telegramButtons = buttons.map((row) =>
      row.map((btn) => ({
        text: btn.text,
        callback_data: btn.callbackData,
      }))
    );

    const payload = {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: telegramButtons,
      },
    };

    try {
      const result = execSync(
        `curl -s -X POST "${this.apiUrl}/sendMessage" -H "Content-Type: application/json" -d '${JSON.stringify(payload)}'`,
        { encoding: 'utf-8' }
      );
      const response = JSON.parse(result);
      const messageId = response.result?.message_id || 0;
      logger.debug('Telegram message with buttons sent', { messageId });
      return messageId;
    } catch (err) {
      logger.warn('Failed to send Telegram message with buttons', { error: (err as Error).message });
      throw err;
    }
  }

  async editMessageWithButtons(
    messageId: number,
    text: string,
    buttons: Array<Array<{ text: string; callbackData: string }>>,
  ): Promise<void> {
    // Convert callbackData to callback_data for Telegram API
    const telegramButtons = buttons.map((row) =>
      row.map((btn) => ({
        text: btn.text,
        callback_data: btn.callbackData,
      }))
    );

    const payload = {
      chat_id: this.chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: telegramButtons,
      },
    };

    try {
      execSync(
        `curl -s -X POST "${this.apiUrl}/editMessageText" -H "Content-Type: application/json" -d '${JSON.stringify(payload)}'`,
        { stdio: 'ignore' }
      );
      logger.debug('Telegram message edited', { messageId });
    } catch (err) {
      logger.warn('Failed to edit Telegram message', { error: (err as Error).message });
      throw err;
    }
  }

  async editMessageText(messageId: number, text: string): Promise<void> {
    const payload = {
      chat_id: this.chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    };

    try {
      execSync(
        `curl -s -X POST "${this.apiUrl}/editMessageText" -H "Content-Type: application/json" -d '${JSON.stringify(payload)}'`,
        { stdio: 'ignore' }
      );
      logger.debug('Telegram message text updated', { messageId });
    } catch (err) {
      logger.warn('Failed to update Telegram message text', { error: (err as Error).message });
      throw err;
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const payload = {
      callback_query_id: callbackQueryId,
      text: text || undefined,
    };

    try {
      execSync(
        `curl -s -X POST "${this.apiUrl}/answerCallbackQuery" -H "Content-Type: application/json" -d '${JSON.stringify(payload)}'`,
        { stdio: 'ignore' }
      );
      logger.debug('Callback query answered', { callbackQueryId });
    } catch (err) {
      logger.warn('Failed to answer callback query', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Set up a handler for incoming callback queries (button clicks).
   * Polls for updates using long-polling.
   * This is a blocking call — should be run in a separate thread/task.
   */
  async setupCallbackHandler(handler: (query: any) => Promise<void>, timeoutSeconds: number = 60): Promise<void> {
    let lastUpdateId = 0;
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const url = `${this.apiUrl}/getUpdates?offset=${lastUpdateId + 1}&timeout=30&allowed_updates=callback_query`;
        const result = execSync(`curl -s "${url}"`, { encoding: 'utf-8' });
        const response = JSON.parse(result);

        const updates = response.result || [];
        for (const update of updates) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          if (update.callback_query) {
            await handler(update.callback_query);
          }
        }
      } catch (err) {
        logger.warn('Error polling Telegram updates', {
          error: (err as Error).message,
        });
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    logger.info('Telegram callback handler timed out');
  }
}
