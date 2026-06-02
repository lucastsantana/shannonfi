#!/usr/bin/env node
/**
 * One-shot migration: import existing JSON data into SQLite.
 * Safe to run multiple times (uses INSERT OR IGNORE for idempotency).
 * Run this once after upgrading to the SQLite version.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TradeHistoryService } from '../core/tracker/history';
import { CostBasisService } from '../core/tracker/costbasis';
import { TaxService } from '../core/tracker/tax';
import { logger } from '../core/tracker/logger';

const DATA_DIR = path.resolve(__dirname, '../../data');

async function main() {
  logger.level = 'info';
  console.log('\n=== Shannon\'s Demon — JSON to SQLite Migration ===\n');

  // Initialize services (will create SQLite schema if needed)
  const retentionDays = 15;
  const history = new TradeHistoryService(undefined, retentionDays);
  const costBasis = new CostBasisService(undefined, retentionDays, 'SOL');
  const tax = new TaxService(undefined, retentionDays);

  let migratedTrades = 0;
  let migratedSnapshots = 0;
  let migratedTaxEvents = 0;

  // Migrate trade history
  const tradesPath = path.join(DATA_DIR, 'trade_history.json');
  if (fs.existsSync(tradesPath)) {
    try {
      const content = fs.readFileSync(tradesPath, 'utf-8');
      const trades = JSON.parse(content);
      if (Array.isArray(trades)) {
        for (const trade of trades) {
          history.appendTrade(trade);
          migratedTrades++;
        }
        console.log(`✓ Migrated ${migratedTrades} trades`);
      }
    } catch (err) {
      logger.warn('Failed to migrate trades', { error: (err as Error).message });
    }
  }

  // Migrate portfolio snapshots
  const snapshotsPath = path.join(DATA_DIR, 'portfolio_snapshots.json');
  if (fs.existsSync(snapshotsPath)) {
    try {
      const content = fs.readFileSync(snapshotsPath, 'utf-8');
      const snapshots = JSON.parse(content);
      if (Array.isArray(snapshots)) {
        for (const snap of snapshots) {
          history.appendSnapshot(snap);
          migratedSnapshots++;
        }
        console.log(`✓ Migrated ${migratedSnapshots} portfolio snapshots`);
      }
    } catch (err) {
      logger.warn('Failed to migrate snapshots', { error: (err as Error).message });
    }
  }

  // Migrate cost basis
  const costBasisPath = path.join(DATA_DIR, 'cost_basis.json');
  if (fs.existsSync(costBasisPath)) {
    try {
      const content = fs.readFileSync(costBasisPath, 'utf-8');
      const data = JSON.parse(content);
      if (data.sol) {
        const ledger = {
          sol: {
            averageCostBrl: data.sol.averageCostBrl ?? 0,
            totalSol: data.sol.totalSol ?? 0,
          },
          lastUpdated: data.lastUpdated ?? '',
        };
        // Save it (creates/updates the SOL row)
        const ledgerCopy = JSON.parse(JSON.stringify(ledger));
        // Using reflection to set private field for testing
        (costBasis as any).save(ledgerCopy);
        console.log(`✓ Migrated cost basis`);
      }
    } catch (err) {
      logger.warn('Failed to migrate cost basis', { error: (err as Error).message });
    }
  }

  // Migrate tax events
  const taxEventsPath = path.join(DATA_DIR, 'tax_events.json');
  if (fs.existsSync(taxEventsPath)) {
    try {
      const content = fs.readFileSync(taxEventsPath, 'utf-8');
      const events = JSON.parse(content);
      if (Array.isArray(events)) {
        for (const event of events) {
          tax.appendTaxEvent(event);
          migratedTaxEvents++;
        }
        console.log(`✓ Migrated ${migratedTaxEvents} tax events`);
      }
    } catch (err) {
      logger.warn('Failed to migrate tax events', { error: (err as Error).message });
    }
  }

  console.log(`\n✓ Migration complete!\n`);
  console.log(`Summary:`);
  console.log(`  Trades: ${migratedTrades}`);
  console.log(`  Snapshots: ${migratedSnapshots}`);
  console.log(`  Tax Events: ${migratedTaxEvents}`);
  console.log(`\nYour data is now in: ./data/shannonfi.db`);
  console.log(`JSON files remain as a 15-day rolling backup.\n`);
}

main().catch((err) => {
  logger.error('Migration failed', { error: (err as Error).message });
  process.exit(1);
});
