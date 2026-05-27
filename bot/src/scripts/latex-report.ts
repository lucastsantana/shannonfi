#!/usr/bin/env node
/**
 * LaTeX/Beamer PDF monthly report generator.
 * Generates a Beamer presentation PDF from ReportPayload data.
 *
 * Usage:
 *   ts-node src/scripts/latex-report.ts [--month YYYY-MM] [--config path] [--keep-tex]
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { buildReportPayload, generateCommentary, getPreviousMonthBRT } from './report-builder';
import { buildLatexDocument } from './latex-template';

// ─── Utilities ────────────────────────────────────────────────────────────────

function detectPdflatex(): 'pdflatex' | 'latexmk' {
  for (const cmd of ['pdflatex', 'latexmk']) {
    try {
      execSync(`which ${cmd}`, { stdio: 'pipe' });
      return cmd as 'pdflatex' | 'latexmk';
    } catch {
      // continue to next
    }
  }
  throw new Error(
    'pdflatex (or latexmk) not found.\n\n' +
    'Install on Ubuntu/Debian/WSL2:\n' +
    '  sudo apt-get install texlive-latex-base texlive-latex-extra texlive-fonts-recommended\n\n' +
    'For metropolis theme support, also install:\n' +
    '  sudo apt-get install latex-beamer texlive-latex-extra\n\n' +
    'Verify with: pdflatex --version\n\n' +
    'The .tex file has been written and can be compiled manually once LaTeX is installed.'
  );
}

function compilePdf(texPath: string, outputDir: string, compiler: 'pdflatex' | 'latexmk'): void {
  if (compiler === 'latexmk') {
    const cmd = `latexmk -pdf -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`;
    execSync(cmd, { stdio: 'pipe', cwd: outputDir });
  } else {
    const cmd = `pdflatex -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`;
    // Run twice for cross-references
    execSync(cmd, { stdio: 'pipe', cwd: outputDir });
    execSync(cmd, { stdio: 'pipe', cwd: outputDir });
  }
}

function cleanupAuxFiles(texPath: string): void {
  const baseDir = path.dirname(texPath);
  const basename = path.basename(texPath, '.tex');
  const auxExtensions = ['.aux', '.log', '.nav', '.out', '.snm', '.toc', '.fls', '.fdb_latexmk'];

  for (const ext of auxExtensions) {
    const f = path.join(baseDir, basename + ext);
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // silently ignore
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const monthIdx = args.indexOf('--month');
  const monthArg = monthIdx !== -1 ? args[monthIdx + 1] : undefined;
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
  const keepTex = args.includes('--keep-tex');

  const monthBRT = monthArg ?? getPreviousMonthBRT();
  if (!/^\d{4}-\d{2}$/.test(monthBRT)) {
    console.error(`Invalid month format: ${monthBRT}. Expected YYYY-MM.`);
    process.exit(1);
  }

  console.log(`\n=== Shannon's Demon — PDF Report: ${monthBRT} ===\n`);

  // Load config
  let dbPath: string | undefined;
  try {
    const { loadConfig } = await import('../config');
    const config = loadConfig(configPath);
    dbPath = config.dbPath;
  } catch {
    // Config may not exist in CI; use service defaults
  }

  // Build report payload
  console.log('Building report payload...');
  const payload = await buildReportPayload(monthBRT, dbPath);

  if (!payload) {
    console.warn('No snapshot data found in database. Writing stub report.');
    const reportsDir = path.resolve(__dirname, '../../data/reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const stub = `%! LaTeX document\\ndocumentclass{beamer}\\nbegin{document}\\nbegin{frame}\\nNo data available. The bot has not recorded any portfolio snapshots yet.\\nend{frame}\\nend{document}`;
    fs.writeFileSync(path.join(reportsDir, `${monthBRT}.tex`), stub, 'utf-8');
    console.log(`Stub report written to: data/reports/${monthBRT}.tex`);
    return;
  }

  // Generate commentary
  const commentary = generateCommentary(payload);

  // Build LaTeX document
  console.log('Generating LaTeX document...');
  const latexDoc = buildLatexDocument(payload, commentary);

  // Write .tex file
  const reportsDir = path.resolve(__dirname, '../../data/reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const texPath = path.join(reportsDir, `${monthBRT}.tex`);
  fs.writeFileSync(texPath, latexDoc, 'utf-8');
  console.log(`LaTeX source written to: data/reports/${monthBRT}.tex`);

  // Detect pdflatex
  let compiler: 'pdflatex' | 'latexmk';
  try {
    compiler = detectPdflatex();
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`);
    process.exit(1);
  }

  // Compile to PDF
  try {
    console.log(`Compiling to PDF using ${compiler}...`);
    compilePdf(texPath, reportsDir, compiler);
  } catch (err) {
    console.error(`\nLaTeX compilation failed:`);
    console.error((err as any).stdout?.toString?.());
    console.error((err as any).stderr?.toString?.());
    process.exit(1);
  }

  // Cleanup auxiliary files
  cleanupAuxFiles(texPath);

  // Optionally delete .tex
  if (!keepTex) {
    fs.unlinkSync(texPath);
  }

  // Report success
  const pdfPath = path.join(reportsDir, `${monthBRT}.pdf`);
  console.log(`\n✓ Report written to: data/reports/${monthBRT}.pdf`);
  if (keepTex) {
    console.log(`  (LaTeX source preserved at: data/reports/${monthBRT}.tex)`);
  }
}

main().catch(err => {
  console.error('Report generation failed:', (err as Error).message);
  process.exit(1);
});
