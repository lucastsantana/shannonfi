import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

const logsDir = path.resolve(__dirname, '../../logs');
fs.mkdirSync(logsDir, { recursive: true });

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

function formatConsoleOutput({ timestamp, level, message, ...meta }: any): string {
  const time = new Date(timestamp).toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  let levelColor = colors.white;
  let levelBg = '';
  if (level === 'error') {
    levelColor = colors.red;
    levelBg = colors.bgRed;
  } else if (level === 'warn') {
    levelColor = colors.yellow;
  } else if (level === 'info') {
    levelColor = colors.green;
  } else if (level === 'debug') {
    levelColor = colors.dim;
  }

  const hasMetadata = Object.keys(meta).length > 0;

  // Format specific event types
  if (message === 'Price check' && hasMetadata) {
    const { exchange, basePriceBrl, baseAsset, baseBalance, baseAllocationPct, brlBalance, brlAllocationPct, deviationBps, portfolioValueBrl, thresholdBps, triggerPriceUpBrl, triggerPriceDownBrl } = meta;

    let output = `${colors.cyan}${time}${colors.reset} ${colors.green}✓${colors.reset} ${colors.bold}Price Check${colors.reset}\n`;
    output += `   Exchange: ${exchange}\n`;
    output += `   Price: ${colors.bold}R$ ${basePriceBrl}${colors.reset}/${baseAsset || 'HYPE'}\n`;

    if (baseAsset && baseAllocationPct && brlAllocationPct && portfolioValueBrl) {
      output += `   ${baseAsset}: ${colors.bold}${baseBalance}${colors.reset} (${baseAllocationPct}%) | BRL: ${colors.bold}R$ ${brlBalance}${colors.reset} (${brlAllocationPct}%)\n`;
      output += `   Portfolio Total: ${colors.bold}R$ ${portfolioValueBrl}${colors.reset}\n`;
      output += `   Deviation: ${deviationBps} BPS | Threshold: ${thresholdBps} BPS\n`;
      output += `   If falls to: ${colors.bold}R$ ${triggerPriceDownBrl}${colors.reset}/${baseAsset} | If rises to: ${colors.bold}R$ ${triggerPriceUpBrl}${colors.reset}/${baseAsset}`;
    }

    return output;
  }

  if (message === 'Computed adaptive threshold (will cache for today)' && hasMetadata) {
    const { date, windowDays, multiplier, thresholdBps } = meta;
    return `${colors.cyan}${time}${colors.reset} ${colors.blue}📊${colors.reset} ${colors.bold}Adaptive Threshold${colors.reset}\n` +
           `   Date: ${date}\n` +
           `   Window: ${windowDays} days\n` +
           `   Multiplier: ${multiplier}x\n` +
           `   Result: ${colors.bold}${thresholdBps} BPS${colors.reset}`;
  }

  if (message === 'No rebalance needed (price-only estimate)' && hasMetadata) {
    const { effectiveThresholdBps, estBaseValueBrl, brlBalance } = meta;
    return `${colors.cyan}${time}${colors.reset} ${colors.dim}○${colors.reset} ${colors.dim}No Rebalance${colors.reset} (price estimate)\n` +
           `   Threshold: ${effectiveThresholdBps} BPS\n` +
           `   Est. Portfolio: R$ ${(parseFloat(estBaseValueBrl) + parseFloat(brlBalance)).toFixed(2)}`;
  }

  if (message === 'No rebalance needed' && hasMetadata) {
    const { deviationBps, effectiveThresholdBps } = meta;
    return `${colors.cyan}${time}${colors.reset} ${colors.dim}○${colors.reset} ${colors.dim}No Rebalance Needed${colors.reset}\n` +
           `   Deviation: ${deviationBps} BPS | Threshold: ${effectiveThresholdBps} BPS`;
  }

  if (message === 'Portfolio snapshot' && hasMetadata) {
    const { exchange, baseBalance, brlBalance, basePriceBrl, totalValueBrl, baseRatio, deviationBps, baseAsset } = meta;
    const asset = baseAsset || 'HYPE';
    return `${colors.cyan}${time}${colors.reset} ${colors.blue}📊${colors.reset} ${colors.bold}Portfolio Snapshot${colors.reset}\n` +
           `   Exchange: ${exchange}\n` +
           `   ${asset}: ${baseBalance} (R$ ${(parseFloat(baseBalance) * parseFloat(basePriceBrl)).toFixed(2)})\n` +
           `   BRL: R$ ${brlBalance}\n` +
           `   Total: ${colors.bold}R$ ${totalValueBrl}${colors.reset} | Ratio: ${baseRatio} | Drift: ${deviationBps} BPS`;
  }

  if (message === 'Rebalance triggered' && hasMetadata) {
    const { direction, brlAmount, baseRatioBps, effectiveThresholdBps, baseAsset } = meta;
    const asset = baseAsset || 'HYPE';
    const directionEmoji = direction === 'BUY_BASE' ? '🟢' : '🔴';
    const directionText = direction === 'BUY_BASE' ? 'BUY' : 'SELL';
    return `${colors.cyan}${time}${colors.reset} ${directionEmoji} ${colors.bold}${colors.green}REBALANCE TRIGGERED${colors.reset}\n` +
           `   Direction: ${directionText} ${asset}\n` +
           `   Amount: R$ ${parseFloat(brlAmount).toFixed(2)}\n` +
           `   Current Ratio: ${(parseFloat(baseRatioBps) / 100).toFixed(2)}% | Threshold: ${effectiveThresholdBps} BPS`;
  }

  if (message === 'Tax event recorded (SELL_BASE)' && hasMetadata) {
    const { tradedVolumeBrl, realizedGainBrl, cumMonthlySalesBrl, exempt, paymentDeadline } = meta;
    const exemptText = exempt ? `${colors.green}✓ EXEMPT${colors.reset}` : `${colors.yellow}TAXABLE${colors.reset} (Due: ${paymentDeadline})`;
    return `${colors.cyan}${time}${colors.reset} ${colors.yellow}📋${colors.reset} ${colors.bold}Tax Event${colors.reset}\n` +
           `   Volume: R$ ${parseFloat(tradedVolumeBrl).toFixed(2)}\n` +
           `   Realized Gain: R$ ${parseFloat(realizedGainBrl).toFixed(2)}\n` +
           `   Monthly Sales: R$ ${parseFloat(cumMonthlySalesBrl).toFixed(2)}\n` +
           `   Status: ${exemptText}`;
  }

  if (message === 'Cost basis updated (BUY_BASE)' && hasMetadata) {
    const { baseAcquired, brlSpent, baseAsset } = meta;
    const asset = baseAsset || 'HYPE';
    return `${colors.cyan}${time}${colors.reset} ${colors.green}✓${colors.reset} ${colors.bold}Cost Basis Updated${colors.reset}\n` +
           `   Acquired: ${baseAcquired} ${asset}\n` +
           `   Spent: R$ ${parseFloat(brlSpent).toFixed(2)}`;
  }

  if (message === 'Daily digest sent' && hasMetadata) {
    const { date } = meta;
    return `${colors.cyan}${time}${colors.reset} ${colors.green}✓${colors.reset} ${colors.bold}Daily Digest Sent${colors.reset}\n` +
           `   Date: ${date}`;
  }

  if (message === 'Telegram notifications enabled') {
    return `${colors.cyan}${time}${colors.reset} ${colors.green}✓${colors.reset} ${colors.bold}Telegram Notifications${colors.reset} enabled`;
  }

  if (message === 'Daily digest enabled') {
    return `${colors.cyan}${time}${colors.reset} ${colors.green}✓${colors.reset} ${colors.bold}Daily Digest${colors.reset} enabled`;
  }

  if (message.includes('Shannon\'s Demon bot starting')) {
    const { exchange, symbol, dryRun, useAdaptiveThreshold, neverExceedExemptionLimit, enableDayTradeSafeguard, pollIntervalSeconds } = meta;
    let output = `${colors.cyan}${time}${colors.reset} ${colors.green}${colors.bold}🚀 SHANNON'S DEMON BOT STARTING${colors.reset}\n`;
    output += `   Exchange: ${exchange}\n`;
    output += `   Symbol: ${symbol}\n`;
    output += `   Dry Run: ${dryRun ? 'ON' : 'OFF'}\n`;
    output += `   Adaptive Threshold: ${useAdaptiveThreshold ? 'ON' : 'OFF'}\n`;
    output += `   Exemption Limit Safeguard: ${neverExceedExemptionLimit ? 'ON' : 'OFF'}\n`;
    output += `   Day Trade: ${enableDayTradeSafeguard ? 'ON' : 'OFF'}\n`;
    output += `   Poll Interval: ${pollIntervalSeconds}s`;
    return output;
  }

  // Default format for other messages
  const metaStr = hasMetadata ? '\n   ' + JSON.stringify(meta, null, 2).split('\n').join('\n   ') : '';
  return `${colors.cyan}${time}${colors.reset} ${colors.bold}[${level.toUpperCase()}]${colors.reset} ${message}${metaStr}`;
}

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.printf(formatConsoleOutput),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
    }),
  ],
});
