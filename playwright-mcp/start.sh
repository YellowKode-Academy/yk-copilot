#!/bin/sh
PORT="${MCP_PORT:-8931}"
BROWSER="${PLAYWRIGHT_BROWSER:-chromium}"
HEADLESS="${PLAYWRIGHT_HEADLESS:-true}"

echo "[playwright-mcp] browser=$BROWSER headless=$HEADLESS port=$PORT"

ARGS="--port $PORT --host 0.0.0.0 --browser $BROWSER --output-dir /output --viewport-size 1280x800 --no-sandbox"

if [ "$HEADLESS" = "true" ]; then
  ARGS="$ARGS --headless"
fi

exec npx @playwright/mcp $ARGS --allowed-hosts '*'
