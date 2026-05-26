import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_REBALANCE_THRESHOLD_BPS,
  MAX_SLIPPAGE_BPS,
  DEFAULT_VOLATILITY_MULTIPLIER,
  DEFAULT_VOLATILITY_WINDOW_DAYS,
} from './constants';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ConfigSchema = z.object({
  coinbaseApiKeyName: z
    .string()
    .min(10)
    .refine((v) => v.startsWith('organizations/'), {
      message: 'Must start with "organizations/"',
    }),
  coinbasePrivateKey: z.string().refine(
    (val) =>
      val.includes('BEGIN EC PRIVATE KEY') || val.includes('BEGIN PRIVATE KEY'),
    { message: 'Must be a PEM-encoded EC private key' },
  ),
  rebalanceThresholdBps: z
    .number()
    .int()
    .min(10)
    .max(2000)
    .default(DEFAULT_REBALANCE_THRESHOLD_BPS),
  maxSlippageBps: z.number().int().min(10).max(500).default(MAX_SLIPPAGE_BPS),
  minPortfolioValueUsd: z.number().positive().default(50),
  minTradeSizeUsd: z.number().positive().default(5),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(300),
  minRebalanceIntervalSeconds: z.number().int().min(60).default(7200),
  dryRun: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  tradeHistoryPath: z.string().default('./data/trade_history.json'),
  coinbaseApiBaseUrl: z.string().url().default('https://api.coinbase.com'),
  // ─── Volatility-adaptive threshold ─────────────────────────────────────────
  useAdaptiveThreshold: z.boolean().default(true),
  thresholdVolatilityMultiplier: z
    .number()
    .min(0.5)
    .max(5.0)
    .default(DEFAULT_VOLATILITY_MULTIPLIER),
  volatilityWindowDays: z
    .number()
    .int()
    .min(7)
    .max(90)
    .default(DEFAULT_VOLATILITY_WINDOW_DAYS),
  // ─── Brazilian tax compliance ───────────────────────────────────────────────
  // Never allow monthly SELL volume to exceed R$35,000 (minus safety buffer).
  // When true, trades are capped or skipped to stay within the exemption limit.
  neverExceedExemptionLimit: z.boolean().default(false),
  fxApiUrl: z
    .string()
    .url()
    .default('https://api.frankfurter.app/latest?from=USD&to=BRL'),
  costBasisPath: z.string().default('./data/cost_basis.json'),
  taxEventsPath: z.string().default('./data/tax_events.json'),
  portfolioSnapshotsPath: z.string().default('./data/portfolio_snapshots.json'),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadPrivateKey(): string {
  const pemFile = process.env['COINBASE_API_KEY_PEM_FILE'];
  if (pemFile) {
    return fs.readFileSync(pemFile, 'utf-8');
  }
  const raw = process.env['COINBASE_API_KEY_PRIVATE_KEY'] ?? '';
  return raw.replace(/\\n/g, '\n');
}

export function loadConfig(): Config {
  const raw = {
    coinbaseApiKeyName: process.env['COINBASE_API_KEY_NAME'],
    coinbasePrivateKey: loadPrivateKey(),
    rebalanceThresholdBps: process.env['REBALANCE_THRESHOLD_BPS']
      ? parseInt(process.env['REBALANCE_THRESHOLD_BPS'], 10)
      : undefined,
    maxSlippageBps: process.env['MAX_SLIPPAGE_BPS']
      ? parseInt(process.env['MAX_SLIPPAGE_BPS'], 10)
      : undefined,
    minPortfolioValueUsd: process.env['MIN_PORTFOLIO_VALUE_USD']
      ? parseFloat(process.env['MIN_PORTFOLIO_VALUE_USD'])
      : undefined,
    minTradeSizeUsd: process.env['MIN_TRADE_SIZE_USD']
      ? parseFloat(process.env['MIN_TRADE_SIZE_USD'])
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
    coinbaseApiBaseUrl: process.env['COINBASE_API_BASE_URL'],
    // Adaptive threshold
    useAdaptiveThreshold: process.env['USE_ADAPTIVE_THRESHOLD'] !== undefined
      ? process.env['USE_ADAPTIVE_THRESHOLD'] === 'true'
      : undefined,
    thresholdVolatilityMultiplier: process.env['THRESHOLD_VOLATILITY_MULTIPLIER']
      ? parseFloat(process.env['THRESHOLD_VOLATILITY_MULTIPLIER'])
      : undefined,
    volatilityWindowDays: process.env['VOLATILITY_WINDOW_DAYS']
      ? parseInt(process.env['VOLATILITY_WINDOW_DAYS'], 10)
      : undefined,
    // Brazilian tax
    neverExceedExemptionLimit: process.env['NEVER_EXCEED_EXEMPTION_LIMIT'] !== undefined
      ? process.env['NEVER_EXCEED_EXEMPTION_LIMIT'] === 'true'
      : undefined,
    fxApiUrl: process.env['FX_API_URL'],
    costBasisPath: process.env['COST_BASIS_PATH'],
    taxEventsPath: process.env['TAX_EVENTS_PATH'],
    portfolioSnapshotsPath: process.env['PORTFOLIO_SNAPSHOTS_PATH'],
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
