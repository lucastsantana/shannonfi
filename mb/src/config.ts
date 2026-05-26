import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  DEFAULT_REBALANCE_THRESHOLD_BPS,
  DEFAULT_VOLATILITY_MULTIPLIER,
  DEFAULT_VOLATILITY_WINDOW_DAYS,
} from './constants';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ConfigSchema = z.object({
  mbClientId: z.string().min(5),
  mbClientSecret: z.string().min(5),
  mbApiBaseUrl: z.string().url().default('https://api.mercadobitcoin.net/api/v4'),
  // ─── Trading parameters ─────────────────────────────────────────────────────
  rebalanceThresholdBps: z.number().int().min(10).max(2000).default(DEFAULT_REBALANCE_THRESHOLD_BPS),
  maxSlippageBps: z.number().int().min(10).max(500).default(100),
  minPortfolioValueBrl: z.number().positive().default(200),
  minTradeSizeBrl: z.number().positive().default(20),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(300),
  minRebalanceIntervalSeconds: z.number().int().min(60).default(7200),
  dryRun: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  // ─── Data paths ─────────────────────────────────────────────────────────────
  tradeHistoryPath: z.string().default('./data/trade_history.json'),
  portfolioSnapshotsPath: z.string().default('./data/portfolio_snapshots.json'),
  costBasisPath: z.string().default('./data/cost_basis.json'),
  taxEventsPath: z.string().default('./data/tax_events.json'),
  // ─── Volatility-adaptive threshold ─────────────────────────────────────────
  useAdaptiveThreshold: z.boolean().default(true),
  thresholdVolatilityMultiplier: z.number().min(0.5).max(5.0).default(DEFAULT_VOLATILITY_MULTIPLIER),
  volatilityWindowDays: z.number().int().min(7).max(90).default(DEFAULT_VOLATILITY_WINDOW_DAYS),
  // ─── Brazilian tax compliance (domestic exchange rules) ──────────────────────
  // When true, SELL_SOL trades are capped so cumulative monthly sales stay
  // under R$35,000 (preserving the Lei 9.250/1995 Art. 21 exemption).
  neverExceedExemptionLimit: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const raw = {
    mbClientId: process.env['MB_CLIENT_ID'],
    mbClientSecret: process.env['MB_CLIENT_SECRET'],
    mbApiBaseUrl: process.env['MB_API_BASE_URL'],
    rebalanceThresholdBps: process.env['REBALANCE_THRESHOLD_BPS']
      ? parseInt(process.env['REBALANCE_THRESHOLD_BPS'], 10)
      : undefined,
    maxSlippageBps: process.env['MAX_SLIPPAGE_BPS']
      ? parseInt(process.env['MAX_SLIPPAGE_BPS'], 10)
      : undefined,
    minPortfolioValueBrl: process.env['MIN_PORTFOLIO_VALUE_BRL']
      ? parseFloat(process.env['MIN_PORTFOLIO_VALUE_BRL'])
      : undefined,
    minTradeSizeBrl: process.env['MIN_TRADE_SIZE_BRL']
      ? parseFloat(process.env['MIN_TRADE_SIZE_BRL'])
      : undefined,
    pollIntervalSeconds: process.env['POLL_INTERVAL_SECONDS']
      ? parseInt(process.env['POLL_INTERVAL_SECONDS'], 10)
      : undefined,
    minRebalanceIntervalSeconds: process.env['MIN_REBALANCE_INTERVAL_SECONDS']
      ? parseInt(process.env['MIN_REBALANCE_INTERVAL_SECONDS'], 10)
      : undefined,
    dryRun: process.env['DRY_RUN'] === 'true',
    logLevel: process.env['LOG_LEVEL'],
    tradeHistoryPath: process.env['TRADE_HISTORY_PATH'],
    portfolioSnapshotsPath: process.env['PORTFOLIO_SNAPSHOTS_PATH'],
    costBasisPath: process.env['COST_BASIS_PATH'],
    taxEventsPath: process.env['TAX_EVENTS_PATH'],
    useAdaptiveThreshold: process.env['USE_ADAPTIVE_THRESHOLD'] !== undefined
      ? process.env['USE_ADAPTIVE_THRESHOLD'] === 'true'
      : undefined,
    thresholdVolatilityMultiplier: process.env['THRESHOLD_VOLATILITY_MULTIPLIER']
      ? parseFloat(process.env['THRESHOLD_VOLATILITY_MULTIPLIER'])
      : undefined,
    volatilityWindowDays: process.env['VOLATILITY_WINDOW_DAYS']
      ? parseInt(process.env['VOLATILITY_WINDOW_DAYS'], 10)
      : undefined,
    neverExceedExemptionLimit: process.env['NEVER_EXCEED_EXEMPTION_LIMIT'] !== undefined
      ? process.env['NEVER_EXCEED_EXEMPTION_LIMIT'] === 'true'
      : undefined,
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid configuration:\n${result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}
