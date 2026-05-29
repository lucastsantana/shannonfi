#!/usr/bin/env node
/**
 * Daily digest email — sends yesterday's trading summary to user email.
 * Scheduled to run at 00:30 AM BRT every day.
 *
 * Usage:
 *   npm run daily-digest
 *   node dist/scripts/daily-digest.js --config /path/to/config.yaml
 */

import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { loadConfig } from '../../bot/src/config';
import { TradeHistoryService } from '../../bot/src/core/tracker/history';
import { TaxService } from '../../bot/src/core/tracker/tax';
import { CostBasisService } from '../../bot/src/core/tracker/costbasis';
import { logger } from '../../bot/src/core/tracker/logger';
import { fmtBrl, fmtPct } from './report-builder';

interface DailyDigest {
  dateBRT: string;
  startValue: number;
  endValue: number;
  dailyReturn: number;
  baseStart: number;
  baseEnd: number;
  basePriceStart: number;
  basePriceEnd: number;
  rebalances: number;
  buyCount: number;
  sellCount: number;
  feesTotal: number;
  baseRatioStart: number;
  baseRatioEnd: number;
  deviationStart: number;
  deviationEnd: number;
  brlStart: number;
  brlEnd: number;
}

/**
 * Get yesterday's date in BRT as YYYY-MM-DD
 */
function getYesterdayBRT(): string {
  // Get current time in BRT by parsing offset
  const now = new Date();
  // BRT is UTC-3, so we need to adjust
  const utcTime = now.getTime();
  const brtTime = new Date(utcTime - (3 * 60 * 60 * 1000)); // Convert to BRT

  // Get yesterday in BRT
  const yesterday = new Date(brtTime);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  // Format as YYYY-MM-DD
  const year = yesterday.getUTCFullYear();
  const month = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
  const day = String(yesterday.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Compile yesterday's digest from SQLite
 */
async function compileDailyDigest(config: any): Promise<DailyDigest | null> {
  const yesterday = getYesterdayBRT();
  logger.info(`Compiling digest for ${yesterday}`);

  const history = new TradeHistoryService(config.dbPath);
  const snapshots = history.readSnapshots();

  // Find yesterday's snapshots (start and end of day)
  const yesterdaySnapshots = snapshots.filter((s) => s.dateBRT === yesterday);

  if (yesterdaySnapshots.length === 0) {
    logger.warn(`No snapshots found for ${yesterday}`);
    return null;
  }

  // Sort by timestamp to get first and last
  yesterdaySnapshots.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const first = yesterdaySnapshots[0]!;
  const last = yesterdaySnapshots[yesterdaySnapshots.length - 1]!;

  // Count trades for the day
  const trades = history.readTrades();
  const yesterdayTrades = trades.filter(
    (t) => t.tradeDateBRT === yesterday && (t.status === 'FILLED' || t.status === 'DRY_RUN')
  );
  const rebalanceCount = yesterdayTrades.length;
  const buyCount = yesterdayTrades.filter((t) => t.direction === 'BUY_BASE').length;
  const sellCount = yesterdayTrades.filter((t) => t.direction === 'SELL_BASE').length;
  const feesTotal = yesterdayTrades.reduce((sum, t) => sum + (t.feeBrl ?? 0), 0);

  const startValue = first.totalValueBrl;
  const endValue = last.totalValueBrl;
  const dailyReturn = startValue > 0 ? ((endValue - startValue) / startValue) * 100 : 0;

  // Compute deviation from 50% target
  const deviationStart = (first.baseRatioBps / 100) - 50;
  const deviationEnd = (last.baseRatioBps / 100) - 50;

  // Compute BRL balances
  const brlStart = first.totalValueBrl - (first.baseBalance * first.basePrice);
  const brlEnd = last.totalValueBrl - (last.baseBalance * last.basePrice);

  return {
    dateBRT: yesterday,
    startValue,
    endValue,
    dailyReturn,
    baseStart: first.baseBalance,
    baseEnd: last.baseBalance,
    basePriceStart: first.basePrice,
    basePriceEnd: last.basePrice,
    rebalances: rebalanceCount,
    buyCount,
    sellCount,
    feesTotal,
    baseRatioStart: first.baseRatioBps / 100,
    baseRatioEnd: last.baseRatioBps / 100,
    deviationStart,
    deviationEnd,
    brlStart,
    brlEnd,
  };
}

/**
 * Render HTML email body
 */
function renderEmailHtml(digest: DailyDigest): string {
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const parts = digest.dateBRT.split('-');
  const year = parts[0]!;
  const month = parts[1]!;
  const day = parts[2]!;
  const monthName = monthNames[parseInt(month, 10) - 1];
  const dateStr = `${monthName} ${parseInt(day, 10)}, ${year}`;

  const returnColor = digest.dailyReturn >= 0 ? '#10b981' : '#ef4444';
  const returnSign = digest.dailyReturn >= 0 ? '+' : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; background: #ffffff; }
    .container { max-width: 600px; margin: 0 auto; padding: 24px; background: #ffffff; }
    h1 { color: #1f2937; margin: 0 0 8px 0; font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
    .date { color: #9ca3af; font-size: 13px; margin-bottom: 24px; }
    .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin: 24px 0; }
    .card h2 { margin: 0 0 20px 0; font-size: 16px; font-weight: 600; color: #1f2937; }
    .card h2:not(:first-child) { margin-top: 24px; }
    .metric { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #f3f4f6; }
    .metric:last-child { border-bottom: none; padding-bottom: 0; }
    .metric-label { font-weight: 500; color: #6b7280; font-size: 14px; }
    .metric-value { font-weight: 600; color: #1f2937; font-size: 15px; text-align: right; }
    .return-value { color: ${returnColor}; font-size: 18px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 20px 0; }
    .box { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
    .box-label { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600; margin-bottom: 8px; }
    .box-value { font-size: 18px; font-weight: 700; color: #1f2937; line-height: 1.3; }
    .box-subvalue { font-size: 13px; color: #9ca3af; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #f3f4f6; padding: 12px; text-align: left; font-weight: 600; color: #4b5563; font-size: 13px; border: none; }
    td { padding: 14px 12px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
    td:last-child { text-align: right; }
    tr:last-child td { border-bottom: none; }
    .footer { font-size: 12px; color: #9ca3af; margin-top: 32px; padding-top: 24px; border-top: 2px solid #f3f4f6; }
    .footer p { margin-bottom: 8px; }
    .footer p:last-child { margin-bottom: 0; }
    .footer code { background: #f3f4f6; padding: 2px 6px; border-radius: 3px; font-family: 'Monaco', 'Courier New', monospace; font-size: 11px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Shannon's Demon</h1>
    <div class="date">Daily Digest — ${dateStr}</div>

    <div class="card">
      <div class="metric">
        <span class="metric-label">Daily Return</span>
        <span class="metric-value return-value">${returnSign}${digest.dailyReturn.toFixed(2)}%</span>
      </div>
      <div class="metric">
        <span class="metric-label">Portfolio Value</span>
        <span class="metric-value">${fmtBrl(digest.endValue)}</span>
      </div>
      <div class="metric">
        <span class="metric-label">P&L</span>
        <span class="metric-value" style="color: ${digest.endValue - digest.startValue >= 0 ? '#10b981' : '#ef4444'}">
          ${digest.endValue - digest.startValue >= 0 ? '+' : ''}${fmtBrl(digest.endValue - digest.startValue)}
        </span>
      </div>
    </div>

    <div class="card">
      <h2>Portfolio Composition</h2>
      <div class="grid">
        <div class="box">
          <div class="box-label">SOL Balance</div>
          <div class="box-value">${digest.baseEnd.toFixed(6)}</div>
          <div class="box-subvalue">${fmtBrl(digest.baseEnd * digest.basePriceEnd)}</div>
        </div>
        <div class="box">
          <div class="box-label">BRL Balance</div>
          <div class="box-value">${fmtBrl(digest.brlEnd)}</div>
        </div>
      </div>
      <div class="metric">
        <span class="metric-label">SOL Allocation</span>
        <span class="metric-value">${digest.baseRatioEnd.toFixed(2)}%</span>
      </div>
      <div class="metric">
        <span class="metric-label">Drift from 50% Target</span>
        <span class="metric-value">${digest.deviationEnd >= 0 ? '+' : ''}${digest.deviationEnd.toFixed(2)}%</span>
      </div>
    </div>

    <div class="card">
      <h2>Trading Activity</h2>
      <table>
        <tr>
          <th>Metric</th>
          <th style="text-align: right;">Value</th>
        </tr>
        <tr>
          <td>Rebalances</td>
          <td style="text-align: right;">${digest.rebalances}</td>
        </tr>
        <tr>
          <td>Buy Orders</td>
          <td style="text-align: right;">${digest.buyCount}</td>
        </tr>
        <tr>
          <td>Sell Orders</td>
          <td style="text-align: right;">${digest.sellCount}</td>
        </tr>
        <tr>
          <td>Fees Paid</td>
          <td style="text-align: right;">${fmtBrl(digest.feesTotal)}</td>
        </tr>
      </table>
    </div>

    <div class="card">
      <h2>Price Movement</h2>
      <div class="metric">
        <span class="metric-label">SOL Start</span>
        <span class="metric-value">${fmtBrl(digest.basePriceStart)}</span>
      </div>
      <div class="metric">
        <span class="metric-label">SOL End</span>
        <span class="metric-value">${fmtBrl(digest.basePriceEnd)}</span>
      </div>
      <div class="metric">
        <span class="metric-label">SOL Change</span>
        <span class="metric-value" style="color: ${digest.basePriceEnd - digest.basePriceStart >= 0 ? '#10b981' : '#ef4444'}">
          ${digest.basePriceEnd - digest.basePriceStart >= 0 ? '+' : ''}${fmtBrl(digest.basePriceEnd - digest.basePriceStart)}
        </span>
      </div>
    </div>

    <div class="footer">
      <p>This is an automated digest from Shannon's Demon (SOL/BRL volatility harvesting bot).</p>
      <p>For support, check the logs or review your trade history in <code>data/trade_history.json</code>.</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Retrieve SMTP credentials from GNOME Keyring
 */
function getSmtpCredentialsFromKeyring(): { username: string; password: string; recipientEmail: string } | null {
  try {
    const username = execSync('secret-tool lookup service shannon-demon key smtp-username', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const password = execSync('secret-tool lookup service shannon-demon key smtp-password', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const recipientEmail = execSync('secret-tool lookup service shannon-demon key smtp-recipient', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!username || !password || !recipientEmail) {
      return null;
    }

    return { username, password, recipientEmail };
  } catch (err) {
    return null;
  }
}

/**
 * Send email via SMTP
 */
async function sendEmail(
  to: string,
  subject: string,
  html: string,
  smtpConfig: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
  },
): Promise<void> {
  const transporter = nodemailer.createTransport(smtpConfig);

  try {
    const info = await transporter.sendMail({
      from: `"Shannon's Demon" <${smtpConfig.auth.user}>`,
      to,
      subject,
      html,
    });
    logger.info('Email sent', { messageId: info.messageId, to });
  } catch (err) {
    logger.error('Failed to send email', { error: (err as Error).message });
    throw err;
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  const config = loadConfig(configPath);
  logger.level = config.logLevel;

  // Try to get SMTP credentials from keyring first, then fall back to config
  let smtpUsername: string | undefined;
  let smtpPassword: string | undefined;
  let smtpRecipient: string | undefined;

  const keyringCreds = getSmtpCredentialsFromKeyring();
  if (keyringCreds) {
    logger.info('Using SMTP credentials from GNOME Keyring');
    smtpUsername = keyringCreds.username;
    smtpPassword = keyringCreds.password;
    smtpRecipient = keyringCreds.recipientEmail;
  } else if (config.smtp) {
    logger.info('Using SMTP credentials from config file');
    smtpUsername = config.smtp.username;
    smtpPassword = config.smtp.password;
    smtpRecipient = config.smtp.recipientEmail;
  } else {
    logger.error('SMTP credentials not found in keyring or config file. Cannot send daily digest.');
    logger.error('Run: npm run setup-smtp to securely store credentials in GNOME Keyring');
    process.exit(1);
  }

  // Compile digest
  const digest = await compileDailyDigest(config);
  if (!digest) {
    logger.info('No trading data for yesterday; skipping digest email');
    process.exit(0);
  }

  // Render email
  const subject = `Shannon's Demon Digest — ${digest.dateBRT}`;
  const html = renderEmailHtml(digest);

  // Send email
  try {
    await sendEmail(smtpRecipient, subject, html, {
      host: 'smtp.mail.yahoo.com',
      port: 587,
      secure: false,
      auth: {
        user: smtpUsername,
        pass: smtpPassword,
      },
    });
    logger.info('Daily digest email sent successfully', { recipient: smtpRecipient, date: digest.dateBRT });
  } catch (err) {
    logger.error('Failed to send daily digest', { error: (err as Error).message });
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error('Fatal error in daily digest', { error: (err as Error).message });
  process.exit(1);
});
