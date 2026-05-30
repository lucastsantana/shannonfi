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

// ─── Exchange sub-schemas ──────────────────────────────────────────────────────

const MercadoBitcoinSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  apiBaseUrl: z.string().url().default('https://api.mercadobitcoin.net/api/v4'),
});

const BinanceSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  apiBaseUrl: z.string().url().default('https://api.binance.com'),
});

const SmtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(true),
  username: z.string().min(1),
  password: z.string().min(1),
  recipientEmail: z.string().email(),
}).optional();

// ─── Shared strategy fields (all exchanges) ───────────────────────────────────

const CommonConfigSchema = z.object({
  // Trading pair symbol (e.g. SOL-BRL, HYPE-BRL). The base asset is derived
  // as the portion before the hyphen; the quote currency is always BRL.
  symbol: z.string().regex(/^[A-Z]+-BRL$/, "Symbol must match BASE-BRL (e.g. 'SOL-BRL')").default('SOL-BRL'),

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

  // ─── Runtime ────────────────────────────────────────────────────────────────
  dryRun: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // ─── Data paths ──────────────────────────────────────────────────────────────
  // Set dbPath to isolate multiple bot instances on the same machine.
  // JSON backup files are written to the same directory as the db file.
  dbPath: z.string().default('./data/shannonfi.db'),
  jsonRetentionDays: z.number().int().min(0).max(365).default(15),

  // ─── SMTP for daily digest email ─────────────────────────────────────────────
  smtp: SmtpSchema,
});

// ─── Per-exchange config branches ─────────────────────────────────────────────

const MbConfigSchema = CommonConfigSchema.extend({
  exchange: z.literal('mercadobitcoin'),
  mercadobitcoin: MercadoBitcoinSchema,

  // Lei 9.250/1995 Art. 21 (domestic exchange):
  // Caps SELL_BASE trades so monthly gross SELL proceeds stay ≤ R$34,650
  // (R$35,000 minus 1% safety buffer). No-op for foreign exchanges.
  neverExceedExemptionLimit: z.boolean().default(false),
});

const BinanceConfigSchema = CommonConfigSchema.extend({
  exchange: z.literal('binance'),
  binance: BinanceSchema,
});

// ─── Unified discriminated union ───────────────────────────────────────────────

const ConfigSchema = z.discriminatedUnion('exchange', [MbConfigSchema, BinanceConfigSchema]);

export type Config = z.infer<typeof ConfigSchema>;
export type MercadoBitcoinConfig = z.infer<typeof MercadoBitcoinSchema>;
export type BinanceConfig = z.infer<typeof BinanceSchema>;
export type SmtpConfig = z.infer<typeof SmtpSchema>;

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
