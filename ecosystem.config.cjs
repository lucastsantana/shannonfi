/**
 * PM2 Ecosystem Configuration — Shannon's Demon Bot
 *
 * Manages multiple bot instances running in parallel on different exchanges/assets.
 * Each instance has its own config file and separate data directory.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 monit                          # Watch all instances
 *   pm2 logs hype-mb                   # Tail logs for one instance
 *   pm2 stop hype-mb                   # Stop one instance
 *   pm2 restart ecosystem.config.cjs   # Restart all
 *   pm2 delete ecosystem.config.cjs    # Remove all
 *
 * To add a new Binance instance:
 *   1. Create bot/configs/sol-binance.yaml
 *   2. Add new entry to apps[] array below
 *   3. pm2 start ecosystem.config.cjs
 */

module.exports = {
  apps: [
    // ─── Existing instance: HYPE-BRL on Mercado Bitcoin ──────────────────────
    // History preserved in: bot/data/hype-mb/
    {
      name: 'hype-mb',
      script: './start-instance.sh',
      cwd: './bot',
      args: 'hype-mb',
      // Restart behavior
      watch: false,                     // Don't auto-restart on code changes
      autorestart: true,                // Auto-restart on crash
      max_memory_restart: '500M',       // Restart if using > 500M RAM
      // Logging
      out_file: 'logs/hype-mb.log',
      error_file: 'logs/hype-mb-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Process management
      merge_logs: true,
      // Environment
      env: {
        NODE_ENV: 'production',
      },
    },

    // ─── New instance: BTC-BRL on Binance ──────────────────────────────────────
    // Data stored in: bot/data/btc-binance/
    {
      name: 'btc-binance',
      script: './start-instance.sh',
      cwd: './bot',
      args: 'btc-binance',
      watch: false,
      autorestart: true,
      max_memory_restart: '500M',
      out_file: 'logs/btc-binance.log',
      error_file: 'logs/btc-binance-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // ─── Not yet enabled: BTC-USD on Coinbase ──────────────────────────────────
    // Uncomment once configs/coinbase-btc.yaml exists (copy from the .template)
    // and Coinbase CDP credentials are stored in GNOME Keyring — see
    // docs/coinbase-adapter-plan.md and configs/coinbase-btc.yaml.template.
    // Data would be stored in: bot/data/coinbase-btc/
    // {
    //   name: 'coinbase-btc',
    //   script: './start-instance.sh',
    //   cwd: './bot',
    //   args: 'coinbase-btc',
    //   watch: false,
    //   autorestart: true,
    //   max_memory_restart: '500M',
    //   out_file: 'logs/coinbase-btc.log',
    //   error_file: 'logs/coinbase-btc-error.log',
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    //   merge_logs: true,
    //   env: {
    //     NODE_ENV: 'production',
    //   },
    // },
  ],

  // ─── Global settings ──────────────────────────────────────────────────────
  deploy: {
    production: {
      user: 'node',
      host: 'localhost',
      ref: 'origin/master',
      repo: 'https://github.com/YOUR_REPO.git',
      path: '/home/user/shannonfi',
      'post-deploy': 'npm install && npm run build && pm2 startOrRestart ecosystem.config.cjs --env production',
    },
  },
};
