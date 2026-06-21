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
// NOTE: API credentials (clientId, clientSecret, apiKey, apiSecret) are
// intentionally NOT loaded from config files. They are loaded directly from
// GNOME Keyring at runtime. This prevents secrets from ever being written to disk.
// See bot/src/core/keyring.ts for credential loading.

const MercadoBitcoinSchema = z.object({
  // apiBaseUrl is the only config field; credentials come from keyring
  apiBaseUrl: z.string().url().default('https://api.mercadobitcoin.net/api/v4'),
}).optional().default({});

const BinanceSchema = z.object({
  // apiBaseUrl is the only config field; credentials come from keyring
  apiBaseUrl: z.string().url().default('https://api.binance.com'),
}).optional().default({});

const CoinbaseSchema = z.object({
  // apiBaseUrl is the only config field; credentials (a CDP API key name + private
  // key, not a simple key/secret pair) come from keyring — see core/keyring.ts.
  apiBaseUrl: z.string().url().default('https://api.coinbase.com'),
}).optional().default({});

const TelegramSchema = z.object({
  // Telegram bot token is loaded from keyring; this is just the chat ID
  chatId: z.string().min(1, 'Telegram chatId is required'),
}).optional();

// ─── Shared strategy fields (all exchanges) ───────────────────────────────────

const CommonConfigSchema = z.object({
  // Trading pair symbol (e.g. SOL-BRL, HYPE-BRL, BTC-BRL, or BTC-USD for Coinbase).
  // The base asset is derived as the portion before the hyphen. The allowed quote
  // currency depends on the exchange — see the per-exchange `symbol` override below;
  // this default-only definition exists so TypeScript has a single `Config.symbol`
  // field across the union, but every branch actually validates its own format.
  symbol: z.string().default('SOL-BRL'),

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

  // ─── Safeguards ─────────────────────────────────────────────────────────────
  enableDayTradeSafeguard: z.boolean().default(true),

  // ─── Runtime ────────────────────────────────────────────────────────────────
  dryRun: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // ─── Data paths ──────────────────────────────────────────────────────────────
  // Set dbPath to isolate multiple bot instances on the same machine.
  // JSON backup files are written to the same directory as the db file.
  dbPath: z.string().default('./data/shannonfi.db'),
  jsonRetentionDays: z.number().int().min(0).max(365).default(15),

  // ─── Notifications ──────────────────────────────────────────────────────────
  telegram: TelegramSchema,
});

// ─── Per-exchange config branches ─────────────────────────────────────────────

const MbConfigSchema = CommonConfigSchema.extend({
  exchange: z.literal('mercadobitcoin'),
  mercadobitcoin: MercadoBitcoinSchema,
  symbol: z.string().regex(/^[A-Z]+-BRL$/, "Symbol must match BASE-BRL format").default('SOL-BRL'),

  // Lei 9.250/1995 Art. 21: caps SELL_BASE trades so monthly gross SELL proceeds
  // stay under the exemption limit. The law applies to a Brazilian tax resident's
  // aggregate crypto sales regardless of exchange ("no Brasil ou no exterior") — see
  // docs/coinbase-adapter-plan.md, open question 5. This flag currently only exists
  // on the mercadobitcoin branch for historical reasons (kept as-is for the already-
  // running btc-binance instance pending an explicit decision); Coinbase gets the
  // same flag on its own branch below, defaulted to true rather than carrying over
  // that same gap into a brand-new instance.
  neverExceedExemptionLimit: z.boolean().default(false),
});

const BinanceConfigSchema = CommonConfigSchema.extend({
  exchange: z.literal('binance'),
  binance: BinanceSchema,
  symbol: z.string().regex(/^[A-Z]+-BRL$/, "Symbol must match BASE-BRL format").default('SOL-BRL'),
});

const CoinbaseConfigSchema = CommonConfigSchema.extend({
  exchange: z.literal('coinbase'),
  coinbase: CoinbaseSchema,
  // Coinbase has no BRL-quoted trading pairs (verified against its live products
  // API — see docs/coinbase-adapter-plan.md). USD is the only quote currency this
  // adapter has actually been built/tested against; USDC is allowed in the schema
  // for a future instance but not yet implemented in adapter.ts.
  symbol: z.string().regex(/^[A-Z]+-(USD|USDC)$/, "Symbol must match BASE-USD or BASE-USDC format").default('BTC-USD'),

  // See note on MbConfigSchema above. Defaulted to true here (unlike the
  // mercadobitcoin branch's `false` default) because Lei 9.250's R$35k/month
  // exemption applies to aggregate crypto sales regardless of exchange — there's no
  // existing real-money behavior to preserve on a brand-new instance, so this
  // defaults to the legally-correct behavior rather than the historical gap.
  neverExceedExemptionLimit: z.boolean().default(true),
});

// ─── Unified discriminated union ───────────────────────────────────────────────

const ConfigSchema = z.discriminatedUnion('exchange', [MbConfigSchema, BinanceConfigSchema, CoinbaseConfigSchema]);

export type Config = z.infer<typeof ConfigSchema>;
export type MercadoBitcoinConfig = z.infer<typeof MercadoBitcoinSchema>;
export type BinanceConfig = z.infer<typeof BinanceSchema>;
export type CoinbaseConfig = z.infer<typeof CoinbaseSchema>;
export type TelegramConfig = z.infer<typeof TelegramSchema>;

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
