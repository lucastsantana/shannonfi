#!/bin/bash
# Daily asset scanner at 9 AM BRT
# Runs Shannon's Demon asset analysis and sends results to Telegram

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/logs/scanner"
LOG_FILE="${LOG_DIR}/daily-scan-coinbase-shannon-1-$(date +%Y%m%d-%H%M%S).log"
CONFIG_FILE="${SCRIPT_DIR}/configs/coinbase-shannon-1.yaml"
WINDOW_DAYS=30

# Ensure log directory exists
mkdir -p "${LOG_DIR}"

echo "=================================================="
echo "Daily Asset Scanner (coinbase-shannon-1) — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=================================================="
echo "Config: ${CONFIG_FILE}"
echo "Window: ${WINDOW_DAYS} days"
echo "Log: ${LOG_FILE}"
echo ""

# Run the scan with Telegram notifications
{
  cd "${SCRIPT_DIR}"
  npm run scan -- \
    --config "${CONFIG_FILE}" \
    --window "${WINDOW_DAYS}" \
    --min-volume 5000 \
    --top 15
} 2>&1 | tee -a "${LOG_FILE}"

EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✓ Scan completed successfully${NC}"
  exit 0
else
  echo -e "${RED}✗ Scan failed with exit code ${EXIT_CODE}${NC}"
  exit 1
fi
