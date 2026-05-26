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

const CoinbaseSchema = z.object({
  apiKeyName: z.string().min(10).refine((v) => v.startsWith('organizations/'), {
    message: 'Must start with "organizations/"',
  }),
  pemFile: z.string().optional(),
  privateKey: z.string().optional(),
  apiBaseUrl: z.string().url().default('https://api.coinbase.com'),
  fxApiUrl: z.string().url().default('https://api.frankfurter.app/latest?from=USD&to=BRL'),
});

const MercadoBitcoinSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  apiBaseUrl: z.string().url().default('https://api.mercadobitcoin.net/api/v4'),
});

const ConfigSchema = z.object({
  exchange: z.enum(['coinbase', 'mercadobitcoin']),

  coinbase: CoinbaseSchema.optional(),
  mercadobitcoin: MercadoBitcoinSchema.optional(),

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
  // (Lei 9.250/1995 Art. 21 domestic exemption — applies to MB, not Coinbase).
  // Coinbase: caps total traded volume as a discretionary strategy constraint
  // (Lei 14.754/2023 governs Coinbase; the domestic exemption does not apply).
  neverExceedExemptionLimit: z.boolean().default(false),

  // ─── Runtime ────────────────────────────────────────────────────────────────
  dryRun: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // ─── Data paths ──────────────────────────────────────────────────────────────
  tradeHistoryPath: z.string().default('./data/trade_history.json'),
  portfolioSnapshotsPath: z.string().default('./data/portfolio_snapshots.json'),
  costBasisPath: z.string().default('./data/cost_basis.json'),
  taxEventsPath: z.string().default('./data/tax_events.json'),
}).superRefine((data, ctx) => {
  if (data.exchange === 'coinbase' && !data.coinbase) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exchange is "coinbase" but coinbase credentials are missing',
      path: ['coinbase'],
    });
  }
  if (data.exchange === 'mercadobitcoin' && !data.mercadobitcoin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exchange is "mercadobitcoin" but mercadobitcoin credentials are missing',
      path: ['mercadobitcoin'],
    });
  }
  if (data.exchange === 'coinbase' && data.coinbase) {
    if (!data.coinbase.pemFile && !data.coinbase.privateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either coinbase.pemFile or coinbase.privateKey must be set',
        path: ['coinbase', 'pemFile'],
      });
    }
  }
});

export type Config = z.infer<typeof ConfigSchema>;
export type CoinbaseConfig = z.infer<typeof CoinbaseSchema>;
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

  // Resolve Coinbase private key from file if pemFile is given
  if (
    raw &&
    typeof raw === 'object' &&
    'coinbase' in raw &&
    raw.coinbase &&
    typeof raw.coinbase === 'object'
  ) {
    const cb = raw.coinbase as Record<string, unknown>;
    if (cb['pemFile'] && typeof cb['pemFile'] === 'string') {
      const pemPath = path.resolve(path.dirname(configPath), cb['pemFile']);
      if (!fs.existsSync(pemPath)) {
        throw new Error(`coinbase.pemFile not found: ${pemPath}`);
      }
      cb['privateKey'] = fs.readFileSync(pemPath, 'utf-8');
    } else if (cb['privateKey'] && typeof cb['privateKey'] === 'string') {
      cb['privateKey'] = (cb['privateKey'] as string).replace(/\\n/g, '\n');
    }
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
