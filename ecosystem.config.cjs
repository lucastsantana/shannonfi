/**
 * PM2 Ecosystem Configuration — Shannon's Demon Bot
 *
 * Manages multiple bot instances running in parallel on different exchanges/assets.
 * Each instance has its own config file and separate data directory.
 *
 * Instance naming convention: {exchange}-{strategy}-{n}, e.g. coinbase-shannon-1,
 * coinbase-shannon-2 for a second parallel instance on the same exchange. `hype-mb`
 * is a pre-convention name kept as-is (it has real accumulated trade/tax history
 * and GitHub Actions artifact continuity tied to that name) — see CLAUDE.md.
 * The instance's traded symbol can change at runtime via dynamic asset rotation
 * (docs/dynamic-asset-rotation-plan.md), so names are intentionally not
 * symbol-specific.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 monit                          # Watch all instances
 *   pm2 logs hype-mb                   # Tail logs for one instance
 *   pm2 stop hype-mb                   # Stop one instance
 *   pm2 restart ecosystem.config.cjs   # Restart all
 *   pm2 delete ecosystem.config.cjs    # Remove all
 *
 * To add a new instance:
 *   1. Create bot/configs/{exchange}-shannon-{n}.yaml (copy from a .template)
 *   2. Add a new entry to apps[] below, following the naming convention
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

    // ─── Coinbase: USDC-quoted, autonomous weekly asset rotation ───────────────
    // Data stored in: bot/data/coinbase-shannon-1/
    {
      name: 'coinbase-shannon-1',
      script: './start-instance.sh',
      cwd: './bot',
      args: 'coinbase-shannon-1',
      watch: false,
      autorestart: true,
      max_memory_restart: '500M',
      out_file: 'logs/coinbase-shannon-1.log',
      error_file: 'logs/coinbase-shannon-1-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
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
