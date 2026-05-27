#!/bin/bash
# Compile LaTeX report to PDF
# Usage: ./scripts/compile-report-pdf.sh 2026-05

set -e

MONTH="${1:-$(date +%Y-%m)}"
BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bot" && pwd)"
REPORTS_DIR="$BOT_DIR/data/reports"
TEX_FILE="$REPORTS_DIR/$MONTH.tex"
PDF_FILE="$REPORTS_DIR/$MONTH.pdf"

if [ ! -f "$TEX_FILE" ]; then
  echo "Error: $TEX_FILE not found"
  echo ""
  echo "Generate it first with:"
  echo "  npm run report:pdf -- --month $MONTH"
  exit 1
fi

echo "Compiling $TEX_FILE to PDF..."
echo ""

# Check for pdflatex
if ! command -v pdflatex &> /dev/null; then
  echo "Error: pdflatex not found"
  echo ""
  echo "Install LaTeX with:"
  echo "  Ubuntu/Debian/WSL2:"
  echo "    sudo apt-get install texlive-latex-base texlive-latex-extra texlive-fonts-recommended"
  echo ""
  echo "  macOS:"
  echo "    brew install basictex"
  echo "    sudo tlmgr update --self"
  echo "    sudo tlmgr install beamer booktabs microtype xcolor"
  echo ""
  echo "  Or use TinyTeX:"
  echo "    https://yihui.org/tinytex/"
  exit 1
fi

# Compile with pdflatex (run twice for cross-references)
cd "$REPORTS_DIR"
echo "Pass 1: Building references..."
pdflatex -interaction=nonstopmode -halt-on-error "$TEX_FILE" > /dev/null
echo "Pass 2: Building final PDF..."
pdflatex -interaction=nonstopmode -halt-on-error "$TEX_FILE" > /dev/null

# Cleanup auxiliary files
rm -f "$REPORTS_DIR/$MONTH".{aux,log,nav,out,snm,toc,fls,fdb_latexmk}

echo ""
echo "✓ PDF compiled successfully!"
echo "  Output: $PDF_FILE"
echo "  Size: $(du -h "$PDF_FILE" | cut -f1)"
