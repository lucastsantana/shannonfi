import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import {
  DEFAULT_REBALANCE_THRESHOLD_BPS,
  MAX_SLIPPAGE_BPS,
  DEFAULT_VOLATILITY_MULTIPLIER,
  DEFAULT_VOLATILITY_WINDOW_DAYS,
} from './constants';

// ─── Schema ───────────────────────────────────────────────────────────────────

const MercadoBitcoinSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  apiBaseUrl: z.string().url().default('https://api.mercadobitcoin.net/api/v4'),
});

const ConfigSchema = z.object({
  exchange: z.literal('mercadobitcoin'),

  mercadobitcoin: MercadoBitcoinSchema,

  // ─── Strategy ───────────────────────────────────────────────────────────────
  rebalanceThresholdBps: z.number().int().min(10).max(2000).default(DEFAULT_REBALANCE_THRESHOLD_BPS),
  maxSlippageBps: z.number().int().min(10).max(500).default(MAX_SLIPPAGE_BPS),
  minPortfolioValueBrl: z.number().min(10).default(200),
  minTradeSizeBrl: z.number().min(1).default(20),
  pollIntervalSeconds: z.number().int().min(60).max(3600).default(900),
  minRebalanceIntervalSeconds: z.number().int().min(60).default(7200),

  // ─── Adaptive threshold ─────────────────────────────────────────────────────
  useAdaptiveThreshold: z.boolean().default(true),
  thresholdVolatilityMultiplier: z.number().min(0.5).max(5.0).default(DEFAULT_VOLATILITY_MULTIPLIER),
  volatilityWindowDays: z.number().int().min(7).max(90).default(DEFAULT_VOLATILITY_WINDOW_DAYS),

  // ─── Tax compliance ──────────────────────────────────────────────────────────
  // Mercado Bitcoin: caps SELL_SOL trades so monthly sales stay under R$35,000
  // Lei 9.250/1995 Art. 21: domestic crypto trading exemption (MB only)
  neverExceedExemptionLimit: z.boolean().default(false),

  // ─── Runtime ────────────────────────────────────────────────────────────────
  dryRun: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // ─── Data paths ──────────────────────────────────────────────────────────────
  dbPath: z.string().default('./data/shannonfi.db'),
  jsonRetentionDays: z.number().int().min(0).max(365).default(15),
});

export type Config = z.infer<typeof ConfigSchema>;
export type MercadoBitcoinConfig = z.infer<typeof MercadoBitcoinSchema>;

// ─── Loader ───────────────────────────────────────────────────────────────────

const CONFIG_FILE = path.resolve(__dirname, '../shannonfi.config.yaml');

export function loadConfig(configPath = CONFIG_FILE): Config {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
      `Copy shannonfi.config.yaml.example to shannonfi.config.yaml and fill in your credentials.`,
    );
  }

  let raw: unknown;
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    raw = yaml.load(text);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration in ${configPath}:\n${issues}`);
  }
  return result.data;
}
