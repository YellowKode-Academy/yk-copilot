#!/usr/bin/env bash
# yk-switch.sh — toggle between local (yk-copilot) and Anthropic cloud
#
# Setup (add ONE of these lines to ~/.zshrc or ~/.bashrc):
#   source /full/path/to/yk-copilot/scripts/yk-switch.sh
#   # or with a custom port:
#   YK_PORT=9999 source /full/path/to/yk-copilot/scripts/yk-switch.sh

yk() {
  local MODE="${1:-status}"
  local PORT="${YK_PORT:-9999}"
  local PROXY="http://localhost:${PORT}"

  # VS Code settings path (per OS)
  local VS_SETTINGS
  case "$OSTYPE" in
    darwin*) VS_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json" ;;
    *)       VS_SETTINGS="$HOME/.config/Code/User/settings.json" ;;
  esac

  _yk_update_vscode() {
    local ACTION="$1"  # on | off
    [ -f "$VS_SETTINGS" ] || return
    command -v node &>/dev/null || return

    node - "$VS_SETTINGS" "$ACTION" "$PROXY" <<'JSEOF'
const fs = require('fs');
const [,, settingsPath, action, proxy] = process.argv;
try {
  const raw = fs.readFileSync(settingsPath, 'utf8');
  const s = JSON.parse(raw);
  if (action === 'on') {
    s['claude.apiBaseUrl'] = proxy;
    s['claude.apiKey']     = 'ollama';
  } else {
    delete s['claude.apiBaseUrl'];
    delete s['claude.apiKey'];
  }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
  console.log('[yk] VS Code settings updated — reload VS Code window to apply (Ctrl+Shift+P > Reload Window)');
} catch (e) {
  console.log('[yk] Could not update VS Code settings: ' + e.message);
}
JSEOF
  }

  case "$MODE" in
    on)
      export ANTHROPIC_BASE_URL="$PROXY"
      export ANTHROPIC_API_KEY="ollama"
      _yk_update_vscode on
      echo "[yk] LOCAL  ▶  Claude Code → $PROXY (qwen2.5-coder + gemma4, 100% local)"
      ;;
    off)
      unset ANTHROPIC_BASE_URL
      unset ANTHROPIC_API_KEY
      _yk_update_vscode off
      echo "[yk] CLOUD  ▶  Claude Code → api.anthropic.com"
      ;;
    status)
      if [ -n "$ANTHROPIC_BASE_URL" ]; then
        echo "[yk] LOCAL  ▶  $ANTHROPIC_BASE_URL"
      else
        echo "[yk] CLOUD  ▶  api.anthropic.com"
      fi
      ;;
    *)
      echo "Usage: yk on | yk off | yk status"
      return 1
      ;;
  esac
}
