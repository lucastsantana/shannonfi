import Database from 'better-sqlite3';
import { TelegramService } from './telegram';
import { AssetCandidate, ScanResult } from '../scanner/types';
import { logger } from '../core/tracker/logger';

export class ScanReporter {
  constructor(
    private telegram: TelegramService | null,
    private currentSymbol: string,
    private db: Database.Database,
    private exchange: string = 'Unknown',
  ) {}

  async report(scanResult: ScanResult, dryRun: boolean = false, interactive: boolean = true): Promise<void> {
    // Always print to console
    this.printConsoleReport(scanResult);

    // Send to Telegram if available and not dry-run
    if (this.telegram && !dryRun) {
      await this.sendTelegramReport(scanResult, interactive);
      logger.info('Telegram report sent');

      // Only autonomous-instance callers pass interactive=false (see scan.ts) —
      // an instance that decides for itself on a schedule shouldn't also wait on
      // (or risk acting on) a stray button tap from this report.
      if (interactive) {
        logger.info('Waiting for Telegram interaction (60 seconds)');
        await this.telegram.setupCallbackHandler(
          (query) => this.onCallbackQuery(query, scanResult.id!),
          60,
        );
      }
    } else if (!this.telegram) {
      logger.info('Telegram not configured, skipping interactive UI');
    }
  }

  private printConsoleReport(scanResult: ScanResult): void {
    const { candidates, currentSymbol, windowDays, totalScanned } = scanResult;

    const lines: string[] = [];
    lines.push('');
    lines.push('┌─────────────────────────────────────────────────────────────┐');
    lines.push('│ Asset Scanner Results                                       │');
    lines.push(`│ Window: ${windowDays} days | Scanned: ${totalScanned} symbols | Current: ${currentSymbol}         │`);
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push('│ #  │ Symbol    │ MAD   │ Return │ Vol/day    │ Score      │');
    lines.push('├─────────────────────────────────────────────────────────────┤');

    for (const candidate of candidates.slice(0, 15)) {
      const isCurrent = candidate.symbol === currentSymbol ? ' *' : ' ';
      const rank = String(candidate.rank).padStart(2);
      const symbol = candidate.symbol.padEnd(9);
      const mad = (candidate.mad * 100).toFixed(1).padStart(4) + '%';
      const ret = (candidate.rollingReturn * 100 >= 0 ? '+' : '').padStart(1) +
        (candidate.rollingReturn * 100).toFixed(1).padStart(5) + '%';
      const vol = formatBrl(candidate.avgDailyVolumeBrl).padStart(9);
      const score = candidate.score.toFixed(2).padStart(6);

      lines.push(`│ ${rank} │ ${symbol} │ ${mad} │ ${ret} │ ${vol} │ ${score}    │${isCurrent}`);
    }

    lines.push('└─────────────────────────────────────────────────────────────┘');
    lines.push('');

    logger.info(lines.join('\n'));
  }

  private async sendTelegramReport(scanResult: ScanResult, interactive: boolean): Promise<void> {
    const { candidates, currentSymbol, windowDays, totalScanned } = scanResult;

    // Format the message
    const lines: string[] = [];
    lines.push(`🔍 <b>Asset Scanner — ${this.exchange}</b>`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Window: ${windowDays} days | Scanned: ${totalScanned}`);
    lines.push('');
    lines.push('<b>Top Candidates</b>');
    lines.push('');

    // List format (no table) - better for non-monospace rendering
    lines.push('');
    for (const c of candidates.slice(0, 10)) {
      const symbol = c.symbol.split('-')[0]; // Remove -BRL suffix

      lines.push(
        `${c.rank}. <b>${symbol}</b> — MAD: ${(c.mad * 100).toFixed(1)}% | ADTV: ${formatBrl(c.avgDailyVolumeBrl)} | Score: ${c.score.toFixed(3)}`,
      );
    }
    lines.push('');
    lines.push('<b>📍 Metrics:</b>');
    lines.push('  <b>MAD</b> = Mean Absolute Daily Return (volatility)');
    lines.push('  <b>ADTV</b> = Average Daily Trading Volume in BRL (liquidity)');
    lines.push('  <b>SCORE</b> = MAD × (1 + return) — Shannon premium');
    lines.push('');

    // Top recommendation highlight
    const top = candidates[0]!;
    const topSymbol = top.symbol.split('-')[0]; // Remove -BRL
    const isCurrent = top.symbol === currentSymbol;
    lines.push('✅ <b>TOP RECOMMENDATION:</b>');
    lines.push(`  <code>${topSymbol}</code> ${isCurrent ? '🟢 <i>Currently Active</i>' : '🔵 <i>New Candidate</i>'}`);
    lines.push(`  • <b>Volatility:</b> ${(top.mad * 100).toFixed(1)}%`);
    lines.push(`  • <b>30-Day Return:</b> ${(top.rollingReturn * 100).toFixed(1)}%`);
    lines.push(`  • <b>Liquidity:</b> ${formatBrl(top.avgDailyVolumeBrl)}/day`);
    lines.push(`  • <b>Score:</b> ${top.score.toFixed(3)}`);
    lines.push('');
    lines.push(
      interactive
        ? '⏰ <i>Daily scans: 9 AM BRT</i>'
        : '🤖 <i>Autonomous mode: the bot reviews and rotates automatically every Monday — no action needed.</i>',
    );

    const message = lines.join('\n');

    if (!interactive) {
      await this.telegram!.sendMessage(message);
      return;
    }

    // Attach the per-candidate selection buttons so a tap can trigger
    // onCandidateSelected() below — without this, the approve/reject flow that
    // follows can never actually be reached.
    const buttons = this.buildCandidateButtons(candidates, scanResult.id!);
    await this.telegram!.sendMessageWithButtons(message, buttons);
  }

  /** Per-candidate "pick this one" button list, shared between the initial report and the "back to list" view. */
  private buildCandidateButtons(
    candidates: AssetCandidate[],
    scanId: number,
  ): Array<Array<{ text: string; callbackData: string }>> {
    return candidates.slice(0, 10).map((c) => [
      {
        text: `${c.rank}️⃣ ${c.symbol}`,
        callbackData: `select:${scanId}:${c.symbol}`,
      },
    ]);
  }

  private async onCallbackQuery(query: any, scanId: number): Promise<void> {
    const callbackQueryId = query.id;
    const messageId = query.message.message_id;
    const data = query.data as string;

    try {
      const [action, ...payload] = data.split(':');

      if (action === 'select') {
        // User clicked a candidate
        const symbol = payload.join(':');
        await this.onCandidateSelected(callbackQueryId, messageId, symbol, scanId);
      } else if (action === 'confirm_yes') {
        // User confirmed rotation
        const symbol = payload.join(':');
        await this.onConfirmYes(callbackQueryId, messageId, symbol, scanId);
      } else if (action === 'confirm_no') {
        // User said no, go back to candidate list
        await this.onConfirmNo(callbackQueryId, messageId, scanId);
      }
    } catch (err) {
      logger.warn('Error handling callback query', {
        error: (err as Error).message,
        data,
      });
      await this.telegram!.answerCallbackQuery(callbackQueryId, 'Error processing request');
    }
  }

  private async onCandidateSelected(
    callbackQueryId: string,
    messageId: number,
    symbol: string,
    scanId: number,
  ): Promise<void> {
    logger.info('Candidate selected', { symbol, scanId });

    const lines: string[] = [];
    lines.push(`🔄 <b>Confirm Rotation</b>`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`Rotate from <b>${this.currentSymbol}</b> to <b>${symbol}</b>?`);
    lines.push('');
    lines.push('✅ = Approve rotation (executes on next rebalance cycle)');
    lines.push('❌ = Go back to candidate list');
    lines.push('');

    const buttons = [
      [
        { text: '✅ Yes, Approve', callbackData: `confirm_yes:${scanId}:${symbol}` },
        { text: '❌ No, Cancel', callbackData: `confirm_no:${scanId}` },
      ],
    ];

    await this.telegram!.editMessageWithButtons(messageId, lines.join('\n'), buttons);
    await this.telegram!.answerCallbackQuery(callbackQueryId);
  }

  private async onConfirmYes(
    callbackQueryId: string,
    messageId: number,
    symbol: string,
    scanId: number,
  ): Promise<void> {
    logger.info('Rotation approved', { symbol, scanId });

    // Insert into pending_rotation table
    const approvedAt = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO pending_rotation (from_symbol, to_symbol, approved_at, status)
       VALUES (?, ?, ?, 'APPROVED')`,
    ).run(this.currentSymbol, symbol, approvedAt);

    // Update scan status
    this.db.prepare('UPDATE scans SET status = ? WHERE id = ?').run('APPROVED', scanId);

    const lines: string[] = [];
    lines.push('✅ <b>ROTATION APPROVED</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push(`Rotating <b>${this.currentSymbol}</b> → <b>${symbol}</b>`);
    lines.push('');
    lines.push('📍 Will execute on next rebalance cycle.');
    lines.push('The bot will:');
    lines.push('1️⃣ Liquidate current position to BRL');
    lines.push('2️⃣ Update active symbol');
    lines.push('3️⃣ Resume rebalancing with new asset');
    lines.push('');
    lines.push('⏳ <i>No restart required.</i>');

    await this.telegram!.editMessageText(messageId, lines.join('\n'));
    await this.telegram!.answerCallbackQuery(callbackQueryId, '✅ Approved!');
  }

  private async onConfirmNo(callbackQueryId: string, messageId: number, scanId: number): Promise<void> {
    logger.info('Rotation cancelled, back to candidate list', { scanId });

    // Reload the scan from DB
    const scanRow = this.db
      .prepare('SELECT scan_data FROM scans WHERE id = ?')
      .get(scanId) as { scan_data: string } | undefined;

    if (!scanRow) {
      await this.telegram!.answerCallbackQuery(callbackQueryId, 'Scan not found');
      return;
    }

    let candidates: AssetCandidate[];
    try {
      candidates = JSON.parse(scanRow.scan_data);
    } catch (err) {
      logger.error('Failed to parse scan data', { scanId, error: (err as Error).message });
      await this.telegram!.answerCallbackQuery(callbackQueryId, 'Failed to load scan results');
      return;
    }

    const lines: string[] = [];
    lines.push('🔍 <b>Asset Scanner</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push('<b>Top Candidates</b>');
    lines.push('');

    for (const c of candidates.slice(0, 10)) {
      const madPct = (c.mad * 100).toFixed(1);
      const retPct = (c.rollingReturn * 100).toFixed(1);
      const adtvBrl = formatBrl(c.avgDailyVolumeBrl);
      const marker = c.symbol === this.currentSymbol ? ' ◄ <i>current</i>' : '';
      const score = c.score.toFixed(3);

      lines.push(
        `${c.rank}. <b>${c.symbol}</b>${marker}`,
      );
      lines.push(
        `   MAD: <b>${madPct}%</b> | Return: <b>${retPct}%</b> | ADTV: <b>${adtvBrl}</b> | Score: <b>${score}</b>`,
      );
    }

    const buttons = this.buildCandidateButtons(candidates, scanId);

    await this.telegram!.editMessageWithButtons(messageId, lines.join('\n'), buttons);
    await this.telegram!.answerCallbackQuery(callbackQueryId);
  }

  /**
   * Replay a cached scan from the database for interaction.
   */
  async reportCached(scanId: number, dryRun: boolean = false): Promise<void> {
    const scanRow = this.db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId) as any | undefined;

    if (!scanRow) {
      logger.error('Scan not found', { scanId });
      return;
    }

    let candidates: AssetCandidate[];
    try {
      candidates = JSON.parse(scanRow.scan_data);
    } catch (err) {
      logger.error('Failed to parse scan data', { scanId, error: (err as Error).message });
      return;
    }

    const scanResult: ScanResult = {
      id: scanRow.id,
      timestamp: scanRow.timestamp,
      windowDays: scanRow.window_days,
      totalScanned: scanRow.total_scanned,
      candidates,
      status: scanRow.status,
      currentSymbol: this.currentSymbol,
    };

    await this.report(scanResult, dryRun);
  }
}

function formatBrl(value: number): string {
  if (value >= 1_000_000) {
    return `R$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `R$${(value / 1_000).toFixed(0)}K`;
  }
  return `R$${value.toFixed(0)}`;
}
