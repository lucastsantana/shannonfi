#!/bin/bash
# Start a Shannon's Demon bot instance.
# Credentials are loaded directly from GNOME Keyring at runtime (bot/src/core/keyring.ts).
# Config files no longer contain secrets.
#
# Usage:
#   ./start-instance.sh hype-mb
#   ./start-instance.sh coinbase-shannon-1 --once
#   ./start-instance.sh hype-mb --config custom.yaml

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Error: No instance name provided."
  echo "Usage: $0 <instance-name> [additional args...]"
  echo "Example: $0 hype-mb"
  echo "Example: $0 coinbase-shannon-1 --once"
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

# Note: Credentials are loaded by the bot process itself from GNOME Keyring.
# This script just validates the config file exists and passes it to the bot.
# No sed substitution or credential injection needed.

exec node "$SCRIPT_DIR/dist/index.js" --config "$CONFIG_FILE" "$@"
