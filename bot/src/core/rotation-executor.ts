import Database from 'better-sqlite3';
import { ExchangeAdapter } from '../adapters/types';
import { TradeHistoryService } from './tracker/history';
import { CostBasisService } from './tracker/costbasis';
import { TaxService } from './tracker/tax';
import { TelegramService } from './notifier/telegram';
import { setDbConfig } from './tracker/db';
import { logger } from './tracker/logger';

export class RotationExecutor {
  constructor(
    private adapter: ExchangeAdapter,
    private history: TradeHistoryService,
    private costBasis: CostBasisService,
    private tax: TaxService,
    private db: Database.Database,
    private telegram: TelegramService | null,
    private dryRun: boolean,
  ) {}

  /**
   * Check for pending rotations and execute if APPROVED.
   * Returns true if a rotation was executed, false otherwise.
   */
  async checkAndExecutePendingRotation(): Promise<boolean> {
    const pending = this.db
      .prepare("SELECT * FROM pending_rotation WHERE status = 'APPROVED' LIMIT 1")
      .get() as any | undefined;

    if (!pending) {
      return false;
    }

    logger.info('Pending rotation found', { from: pending.from_symbol, to: pending.to_symbol });

    try {
      await this.executeLiquidation(pending.from_symbol, pending.to_symbol, pending.id);
      return true;
    } catch (err) {
      const error = (err as Error).message;
      logger.error('Rotation execution failed', { error, rotationId: pending.id });
      this.db
        .prepare('UPDATE pending_rotation SET status = ?, execution_error = ? WHERE id = ?')
        .run('FAILED', error, pending.id);
      return false;
    }
  }

  private async executeLiquidation(fromSymbol: string, toSymbol: string, rotationId: number): Promise<void> {
    // Fetch current portfolio
    const portfolio = await this.adapter.getPortfolio();

    logger.info('Executing liquidation', {
      from: fromSymbol,
      to: toSymbol,
      baseBalance: portfolio.baseBalance,
      basePrice: portfolio.basePrice,
    });

    // If no base asset to sell, just update config
    if (portfolio.baseBalance <= 0.0001) {
      logger.info('No base asset to liquidate, updating config only');
      setDbConfig('current_symbol', toSymbol);
      this.db
        .prepare('UPDATE pending_rotation SET status = ?, executed_at = ? WHERE id = ?')
        .run('COMPLETED', new Date().toISOString(), rotationId);
      await this.notifyRotationComplete(fromSymbol, toSymbol, null);
      return;
    }

    // Compute BRL amount to sell entire position
    const brlAmount = portfolio.baseBalance * portfolio.basePrice;

    // Execute liquidation trade
    const trade = await this.adapter.executeTrade('SELL_BASE', brlAmount, portfolio);

    logger.info('Liquidation trade executed', {
      tradeId: trade.id,
      status: trade.status,
      baseAmountFilled: trade.baseAmountFilled,
      brlAmountFilled: trade.brlAmountFilled,
    });

    // Record trade, tax event, cost basis update
    await this.history.appendTrade(trade);

    if (trade.status === 'FILLED' || trade.status === 'DRY_RUN') {
      // Record tax event for the sale
      const taxEvent = this.tax.buildTaxEvent({
        tradeId: trade.id,
        tradeDateBRT: trade.tradeDateBRT || new Date().toISOString().split('T')[0]!,
        direction: trade.direction,
        tradedVolumeBrl: trade.brlAmountFilled ?? 0,
        grossProceedsBrl: trade.brlAmountFilled ?? 0,
        costBasisBrl: trade.realizedGainBrl ?? 0,
        realizedGainBrl: trade.realizedGainBrl ?? 0,
        exchange: trade.exchange,
      });
      this.tax.appendTaxEvent(taxEvent);

      // Update cost basis (remove the sold amount)
      if (trade.baseAmountFilled) {
        this.costBasis.updateAfterSell(
          trade.baseAmountFilled,
          trade.brlAmountFilled ?? 0,
        );
      }
    }

    // Update config to new symbol
    setDbConfig('current_symbol', toSymbol);

    // Mark rotation as COMPLETED
    this.db
      .prepare('UPDATE pending_rotation SET status = ?, executed_at = ? WHERE id = ?')
      .run('COMPLETED', new Date().toISOString(), rotationId);

    // Send notification
    await this.notifyRotationComplete(fromSymbol, toSymbol, trade);
  }

  private async notifyRotationComplete(
    fromSymbol: string,
    toSymbol: string,
    trade: any | null,
  ): Promise<void> {
    if (!this.telegram) {
      return;
    }

    const lines: string[] = [];
    lines.push('🔄 <b>ROTATION COMPLETED</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`From: <b>${fromSymbol}</b> → To: <b>${toSymbol}</b>`);
    lines.push('');

    if (trade && trade.baseAmountFilled) {
      lines.push('<b>Trade Details</b>');
      lines.push(`├─ Sold: ${trade.baseAmountFilled.toFixed(6)} ${fromSymbol.split('-')[0]}`);
      lines.push(`├─ @: R$ ${(trade.fillPrice ?? 0).toFixed(2)}/${fromSymbol.split('-')[0]}`);
      lines.push(`├─ Proceeds: R$ ${(trade.brlAmountFilled ?? 0).toFixed(2)}`);
      lines.push(`└─ Fee: R$ ${(trade.feeBrl ?? 0).toFixed(2)}`);
      lines.push('');
    }

    lines.push('<b>Portfolio Status</b>');
    lines.push('├─ Base Asset: None (100% BRL)');
    lines.push('└─ Ready for rebalancing with new asset');
    lines.push('');
    lines.push('⏭️ Next cycle will begin rebalancing <b>' + toSymbol + '</b>');

    try {
      await this.telegram.sendMessage(lines.join('\n'));
    } catch (err) {
      logger.warn('Failed to send rotation completion notification', {
        error: (err as Error).message,
      });
    }
  }
}
