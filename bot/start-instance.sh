#!/bin/bash
# Start a Shannon's Demon bot instance with credentials from GNOME Keyring.
# This wrapper loads exchange credentials and injects them into the config at runtime.
#
# Usage:
#   ./start-instance.sh hype-mb
#   ./start-instance.sh sol-binance
#
# The script reads the config file to determine which exchange (mercadobitcoin or binance)
# and loads the appropriate credentials from GNOME Keyring.

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Error: No instance name provided."
  echo "Usage: $0 <instance-name> [additional args...]"
  echo "Example: $0 hype-mb"
  echo "Example: $0 sol-binance --once"
  exit 1
fi

INSTANCE="$1"
shift || true  # Remaining args pass to node

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/configs/${INSTANCE}.yaml"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Config file not found: $CONFIG_FILE"
  exit 1
fi

# Determine which exchange to use by reading the config
EXCHANGE=$(grep "^exchange:" "$CONFIG_FILE" | awk '{print $2}')

# Create temp config
TMPCONFIG=$(mktemp /tmp/shannonfi-${INSTANCE}-XXXXXX.yaml)
trap "rm -f '$TMPCONFIG'" EXIT

# Load credentials based on exchange and inject into config
if [ "$EXCHANGE" = "mercadobitcoin" ]; then
  MB_CLIENT_ID=$(secret-tool lookup service mercadobitcoin key clientId 2>/dev/null || true)
  MB_CLIENT_SECRET=$(secret-tool lookup service mercadobitcoin key clientSecret 2>/dev/null || true)

  if [ -z "${MB_CLIENT_ID:-}" ] || [ -z "${MB_CLIENT_SECRET:-}" ]; then
    echo "Error: Mercado Bitcoin credentials not found in GNOME Keyring."
    echo "Store them with:"
    echo "  secret-tool store service mercadobitcoin key clientId"
    echo "  secret-tool store service mercadobitcoin key clientSecret"
    exit 1
  fi

  sed "s|clientId: \"PLACEHOLDER\"|clientId: \"${MB_CLIENT_ID}\"|; s|clientSecret: \"PLACEHOLDER\"|clientSecret: \"${MB_CLIENT_SECRET}\"|" \
    "$CONFIG_FILE" > "$TMPCONFIG"

elif [ "$EXCHANGE" = "binance" ]; then
  BINANCE_API_KEY=$(secret-tool lookup service binance key apiKey 2>/dev/null || true)
  BINANCE_API_SECRET=$(secret-tool lookup service binance key apiSecret 2>/dev/null || true)

  if [ -z "${BINANCE_API_KEY:-}" ] || [ -z "${BINANCE_API_SECRET:-}" ]; then
    echo "Error: Binance credentials not found in GNOME Keyring."
    echo "Store them with:"
    echo "  secret-tool store service binance key apiKey"
    echo "  secret-tool store service binance key apiSecret"
    exit 1
  fi

  sed "s|apiKey: \"PLACEHOLDER\"|apiKey: \"${BINANCE_API_KEY}\"|; s|apiSecret: \"PLACEHOLDER\"|apiSecret: \"${BINANCE_API_SECRET}\"|" \
    "$CONFIG_FILE" > "$TMPCONFIG"

else
  echo "Error: Unknown exchange in config: $EXCHANGE"
  exit 1
fi

exec node "$SCRIPT_DIR/dist/index.js" --config "$TMPCONFIG" "$@"
