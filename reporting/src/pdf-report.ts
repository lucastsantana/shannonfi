#!/usr/bin/env node
/**
 * Monthly investor PDF report generator.
 * Builds the report payload, generates commentary (Claude API, falling back
 * to the rule-based generator on any failure), renders the dashboard's dark
 * theme as a static HTML document, and rasterizes it to PDF with Playwright.
 *
 * Usage:
 *   ts-node src/pdf-report.ts [--month YYYY-MM] [--config path]
 */

import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { buildReportPayload, generateCommentary, getPreviousMonthBRT } from './report-builder';
import { generateClaudeCommentary } from './claude-commentary';
import { buildReportHtml } from './html-report';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const monthIdx = args.indexOf('--month');
  const monthArg = monthIdx !== -1 ? args[monthIdx + 1] : undefined;
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  const monthBRT = monthArg ?? getPreviousMonthBRT();
  if (!/^\d{4}-\d{2}$/.test(monthBRT)) {
    console.error(`Invalid month format: ${monthBRT}. Expected YYYY-MM.`);
    process.exit(1);
  }

  console.log(`\n=== Shannon's Demon — Investor PDF Report: ${monthBRT} ===\n`);

  let dbPath: string | undefined;
  try {
    const { loadConfig } = await import('../../bot/src/config');
    const config = loadConfig(configPath);
    dbPath = config.dbPath;
  } catch {
    // Config may not exist in CI; report-builder falls back to service defaults.
  }

  console.log('Building report payload...');
  const payload = await buildReportPayload(monthBRT, dbPath);

  const reportsDir = path.resolve(__dirname, '../../bot/data/reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  if (!payload) {
    console.warn('No snapshot data found in database — skipping PDF generation.');
    return;
  }

  console.log('Generating commentary...');
  let commentary: string;
  let commentarySource: 'claude' | 'rule-based';
  try {
    commentary = await generateClaudeCommentary(payload);
    commentarySource = 'claude';
    console.log('  using Claude-generated commentary.');
  } catch (err) {
    console.warn(`  Claude commentary unavailable (${(err as Error).message}); falling back to rule-based commentary.`);
    commentary = generateCommentary(payload);
    commentarySource = 'rule-based';
  }

  console.log('Rendering HTML...');
  const html = buildReportHtml(payload, commentary, commentarySource);

  console.log('Launching headless Chromium and printing to PDF...');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => (document as any).fonts?.ready);

    const pdfPath = path.join(reportsDir, `${monthBRT}.pdf`);
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
    });
    console.log(`\n✓ Report written to: ${path.relative(process.cwd(), pdfPath)}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Report generation failed:', (err as Error).stack ?? String(err));
  process.exit(1);
});
