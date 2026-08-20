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
    // ─── hype-mb is intentionally NOT run here ───────────────────────────────
    // GitHub Actions (rebalancer.yml/scan.yml/dashboard.yml) is the sole runner for
    // hype-mb as of 2026-08-02. Running it here too would resume the dual-writer
    // split-brain that caused a real R$40 PIX deposit to go undetected: local PM2 and
    // GH Actions each polled the same live MB account against their own independent
    // SQLite file (local disk vs. GH Actions artifact), with their own separate
    // mb_last_synced_deposit_id checkpoint and capital_flows ledger, and no
    // synchronization between the two. Do not uncomment/re-add an entry for hype-mb
    // here without first stopping the GitHub Actions matrix entry (or otherwise
    // picking a single authoritative runner) — see CLAUDE.md's Deployment Modes.
    // History preserved in: bot/data/hype-mb/ (now stale as of the PM2 stop)

    // ─── coinbase-shannon-1 is intentionally NOT run here ──────────────────────
    // Deprecated/stopped — the instance's local PM2 process was taken down and is not
    // being restarted. Its config, data (bot/data/coinbase-shannon-1/), and the
    // Coinbase adapter itself are all kept intact (the adapter remains a supported
    // exchange for any future instance); only this PM2 entry and the instance's active
    // trading are deprecated. It was never mirrored to GitHub Actions either (commented
    // out of all four workflow matrices), so no other runner needs disabling first.
    // See CLAUDE.md's Instances table and Deployment Modes.
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
