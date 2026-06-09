#!/usr/bin/env bash
# install.sh — registers yk-copilot on/off globally on Mac/Linux
# Run once: bash scripts/install.sh
# After that, yk-copilot on/off works in any new terminal.

YK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SWITCH="$YK_DIR/scripts/yk-switch.sh"

# Detect shell config file
if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "$(command -v zsh 2>/dev/null)" ]; then
  RC="$HOME/.zshrc"
else
  RC="$HOME/.bashrc"
fi

LINE="source \"$SWITCH\""

if grep -qF "$SWITCH" "$RC" 2>/dev/null; then
  echo "[yk] Already installed. yk-copilot on/off is ready."
else
  printf '\n# yk-copilot\n%s\n' "$LINE" >> "$RC"
  echo "[yk] Installed into $RC"
  echo ""
  echo "  Open a new terminal, then:"
  echo "  yk-copilot on    (activate local mode)"
  echo "  yk-copilot off   (back to cloud)"
  echo "  yk-copilot status"
fi
