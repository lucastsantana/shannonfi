#!/usr/bin/env bash
# Usage: ./switch-asset.sh OLD_SYMBOL NEW_SYMBOL
# Updates all operational documentation to use a different base asset.
# Example: ./switch-asset.sh SOL HYPE
#
# What it changes:
#   README.md, bot/README.md, backtest/README.md, bot/shannonfi.config.yaml.example
#
# What it does NOT change:
#   - Source code (already uses generic 'base'/'BASE' naming and reads symbol from config)
#   - Historical backtest reports in backtest/*.md (asset-specific numerical data)
#   - The live config shannonfi.config.yaml (update 'symbol:' there manually)

set -euo pipefail

OLD="${1:?Usage: $0 OLD_SYMBOL NEW_SYMBOL  (e.g. $0 SOL HYPE)}"
NEW="${2:?Usage: $0 OLD_SYMBOL NEW_SYMBOL  (e.g. $0 SOL HYPE)}"

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

FILES=(
  "$REPO_ROOT/README.md"
  "$REPO_ROOT/bot/README.md"
  "$REPO_ROOT/backtest/README.md"
  "$REPO_ROOT/bot/shannonfi.config.yaml.example"
)

echo "Switching asset: $OLD → $NEW"
echo ""

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "  skip (not found): $f"
    continue
  fi

  # Specific compound patterns first, then bare word (GNU sed \b word boundary)
  sed -i \
    -e "s|${OLD}/BRL|${NEW}/BRL|g" \
    -e "s|${OLD}-BRL|${NEW}-BRL|g" \
    -e "s|SELL_${OLD}|SELL_${NEW}|g" \
    -e "s|BUY_${OLD}|BUY_${NEW}|g" \
    -e "s|\b${OLD}\b|${NEW}|g" \
    "$f"

  echo "  updated: $(realpath --relative-to="$REPO_ROOT" "$f")"
done

echo ""
echo "Done. Also update 'symbol: ${NEW}-BRL' in bot/shannonfi.config.yaml if not already set."
