#!/bin/bash
# Liquidates the entire base asset position to BRL.
# Credentials are loaded from GNOME Keyring — never written to disk.
#
# Usage:
#   ./liquidate.sh              — preview (shows position, no trade)
#   ./liquidate.sh --yes        — execute real liquidation
#   ./liquidate.sh --dry-run    — simulate without placing an order
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MB_CLIENT_ID=$(secret-tool lookup service mercadobitcoin key clientId 2>/dev/null || true)
MB_CLIENT_SECRET=$(secret-tool lookup service mercadobitcoin key clientSecret 2>/dev/null || true)

if [ -z "${MB_CLIENT_ID:-}" ] || [ -z "${MB_CLIENT_SECRET:-}" ]; then
  echo "Error: MB credentials not found in keyring."
  echo "Store them with:"
  echo "  secret-tool store --label=\"Mercado Bitcoin Client ID\" service mercadobitcoin key clientId"
  echo "  secret-tool store --label=\"Mercado Bitcoin Client Secret\" service mercadobitcoin key clientSecret"
  exit 1
fi

TMPCONFIG=$(mktemp /tmp/shannonfi-XXXXXX.yaml)
trap "rm -f '$TMPCONFIG'" EXIT

sed \
  -e "s|clientId: \"PLACEHOLDER\"|clientId: \"$MB_CLIENT_ID\"|" \
  -e "s|clientSecret: \"PLACEHOLDER\"|clientSecret: \"$MB_CLIENT_SECRET\"|" \
  "$SCRIPT_DIR/shannonfi.config.yaml" > "$TMPCONFIG"

exec node "$SCRIPT_DIR/dist/scripts/liquidate.js" --config "$TMPCONFIG" "$@"
