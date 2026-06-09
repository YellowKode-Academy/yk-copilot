# yk-switch.ps1 — toggle between local (yk-copilot) and Anthropic cloud
#
# Setup (add to your PowerShell $PROFILE):
#   $env:YK_DIR = "C:\YellowKode\public\yk-copilot"
#   . "$env:YK_DIR\scripts\yk-switch.ps1"
#
# Usage:
#   yk-copilot on     starts Docker stack + sets env vars + updates VS Code
#   yk-copilot off    stops stack + restores cloud mode
#   yk-copilot status shows current mode

function yk-copilot {
  param([string]$Mode = "status")

  $Port  = if ($env:YK_PORT) { $env:YK_PORT } else { "9999" }
  $Proxy = "http://localhost:$Port"
  $VsSettings = "$env:APPDATA\Code\User\settings.json"

  function Update-VsCode([string]$Action) {
    if (-not (Test-Path $VsSettings)) { return }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }

    $js = @"
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
  console.log('[yk] VS Code settings updated -- reload VS Code window to apply (Ctrl+Shift+P > Reload Window)');
} catch (e) {
  console.log('[yk] Could not update VS Code settings: ' + e.message);
}
"@
    $tmp = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.js'
    $js | Out-File -Encoding utf8 -FilePath $tmp
    node $tmp $VsSettings $Action $Proxy
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }

  switch ($Mode) {
    "on" {
      $env:ANTHROPIC_BASE_URL = $Proxy
      $env:ANTHROPIC_API_KEY  = "ollama"
      Update-VsCode "on"
      Write-Host "[yk] LOCAL  > Claude Code -> $Proxy (qwen2.5-coder + gemma4, 100% local)"
      Write-Host "[yk] Reload VS Code: Ctrl+Shift+P > Reload Window"
    }
    "off" {
      Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
      Remove-Item Env:ANTHROPIC_API_KEY  -ErrorAction SilentlyContinue
      Update-VsCode "off"
      Write-Host "[yk] CLOUD  > Claude Code -> api.anthropic.com"
      Write-Host "[yk] Reload VS Code: Ctrl+Shift+P > Reload Window"
    }
    "status" {
      if ($env:ANTHROPIC_BASE_URL) {
        Write-Host "[yk] LOCAL  > $env:ANTHROPIC_BASE_URL"
      } else {
        Write-Host "[yk] CLOUD  > api.anthropic.com"
      }
    }
    default {
      Write-Host "Usage: yk-copilot on | yk-copilot off | yk-copilot status"
    }
  }
}
