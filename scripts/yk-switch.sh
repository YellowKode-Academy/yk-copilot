#!/usr/bin/env bash
# yk-switch.sh — toggle Claude Code between local (yk-copilot) and Anthropic cloud
#
# Setup (done for you by scripts/install.sh):
#   source /full/path/to/yk-copilot/scripts/yk-switch.sh
#
# Usage:
#   yk-copilot on      start the stack + point Claude Code at it
#   yk-copilot off     restore cloud mode
#   yk-copilot status  show current mode and stack health
#   yk-copilot logs    follow proxy logs
#   yk-copilot test    run the smoke test

yk-copilot() {
  local MODE="${1:-status}"
  local PORT="${YK_PORT:-9999}"
  local PROXY="http://localhost:${PORT}"
  local DIR="${YK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"

  local VS_SETTINGS
  case "$OSTYPE" in
    darwin*) VS_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json" ;;
    *)       VS_SETTINGS="$HOME/.config/Code/User/settings.json" ;;
  esac

  _yk_update_vscode() {
    local ACTION="$1"
    [ -f "$VS_SETTINGS" ] || return
    command -v node &>/dev/null || return
    node - "$VS_SETTINGS" "$ACTION" "$PROXY" <<'JSEOF'
const fs = require('fs');
const [,, settingsPath, action, proxy] = process.argv;
try {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (action === 'on') {
    s['claude.apiBaseUrl'] = proxy;
    s['claude.apiKey']     = 'ollama';
  } else {
    delete s['claude.apiBaseUrl'];
    delete s['claude.apiKey'];
  }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
} catch (e) {
  console.log('[yk] Could not update VS Code settings: ' + e.message);
}
JSEOF
  }

  case "$MODE" in
    on)
      # The proxy has nothing to talk to until Ollama is up.
      if ! curl -sf --max-time 3 http://localhost:11434/api/version >/dev/null 2>&1; then
        if command -v ollama &>/dev/null; then
          echo "[yk] starting Ollama..."
          (OLLAMA_HOST=0.0.0.0 ollama serve >/dev/null 2>&1 &)
          sleep 4
        else
          echo "[yk] WARNING: Ollama not found. Install from https://ollama.com"
        fi
      fi

      echo "[yk] starting stack..."
      docker compose --project-directory "$DIR" up -d >/dev/null

      export ANTHROPIC_BASE_URL="$PROXY"
      export ANTHROPIC_API_KEY="ollama"
      _yk_update_vscode on
      echo "[yk] LOCAL  ▶  Claude Code → $PROXY"
      echo "[yk] dashboard: $PROXY"
      echo "[yk] check it with: yk-copilot test"
      echo "[yk] VS Code needs a reload: Ctrl+Shift+P > Reload Window"
      ;;
    off)
      unset ANTHROPIC_BASE_URL
      unset ANTHROPIC_API_KEY
      _yk_update_vscode off
      echo "[yk] CLOUD  ▶  Claude Code → api.anthropic.com"
      echo "[yk] stack left running. Stop it with: docker compose --project-directory $DIR down"
      echo "[yk] VS Code needs a reload: Ctrl+Shift+P > Reload Window"
      ;;
    status)
      if [ -n "$ANTHROPIC_BASE_URL" ]; then
        echo "[yk] LOCAL  ▶  $ANTHROPIC_BASE_URL"
      else
        echo "[yk] CLOUD  ▶  api.anthropic.com"
      fi
      if curl -sf --max-time 3 http://localhost:11434/api/version >/dev/null 2>&1; then
        echo "[yk] ollama  ▶  up"
      else
        echo "[yk] ollama  ▶  DOWN"
      fi
      if curl -sf --max-time 3 "$PROXY/health" >/dev/null 2>&1; then
        echo "[yk] proxy   ▶  up ($PROXY)"
      else
        echo "[yk] proxy   ▶  DOWN"
      fi
      ;;
    logs) docker compose --project-directory "$DIR" logs -f yk_copilot ;;
    test) node "$DIR/scripts/test.js" --wait ;;
    *)
      echo "Usage: yk-copilot on | off | status | logs | test"
      return 1
      ;;
  esac
}
