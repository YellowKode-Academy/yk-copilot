# yk-switch.ps1 — toggle Claude Code between local (yk-copilot) and Anthropic cloud
#
# Setup (done for you by scripts/install.ps1):
#   $env:YK_DIR = "C:\YellowKode\public\yk-copilot"
#   . "$env:YK_DIR\scripts\yk-switch.ps1"
#
# Usage:
#   yk-copilot on      start the stack + point Claude Code at it
#   yk-copilot off     restore cloud mode
#   yk-copilot status  show current mode and stack health
#   yk-copilot logs    follow proxy logs
#   yk-copilot test    run the smoke test

function yk-copilot {
  param([string]$Mode = "status")

  $Port  = if ($env:YK_PORT) { $env:YK_PORT } else { "9999" }
  $Proxy = "http://localhost:$Port"
  $Dir   = if ($env:YK_DIR) { $env:YK_DIR } else { (Split-Path -Parent $PSScriptRoot) }
  $VsSettings = "$env:APPDATA\Code\User\settings.json"

  function Update-VsCode([string]$Action) {
    if (-not (Test-Path $VsSettings)) { return }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }
    node "$Dir\scriptsscode-toggle.js" $VsSettings $Action $Proxy
  }

  # Persist at User scope so new terminals and the VS Code extension pick it up too,
  # not just the shell that ran the command.
  function Set-Both([string]$Name, $Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
    if ($null -eq $Value) { Remove-Item "env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item -Path "env:$Name" -Value $Value }
  }

  switch ($Mode) {
    "on" {
      # Native Ollama must be up first — the proxy has nothing to talk to otherwise.
      $ollama = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
      try { Invoke-RestMethod "http://localhost:11434/api/version" -TimeoutSec 3 | Out-Null }
      catch {
        if (Test-Path $ollama) {
          Write-Host "[yk] starting Ollama..."
          Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden
          Start-Sleep -Seconds 4
        } else {
          Write-Host "[yk] WARNING: Ollama not found. Install from https://ollama.com"
        }
      }

      Write-Host "[yk] starting stack..."
      docker compose --project-directory $Dir up -d | Out-Null

      Set-Both 'ANTHROPIC_BASE_URL' $Proxy
      Set-Both 'ANTHROPIC_API_KEY'  'ollama'
      Update-VsCode "on"

      Write-Host "[yk] LOCAL  > Claude Code -> $Proxy"
      Write-Host "[yk] dashboard: $Proxy"
      Write-Host "[yk] check it with: yk-copilot test"
      Write-Host "[yk] VS Code needs a reload: Ctrl+Shift+P > Reload Window"
    }

    "off" {
      Set-Both 'ANTHROPIC_BASE_URL' $null
      Set-Both 'ANTHROPIC_API_KEY'  $null
      Update-VsCode "off"
      Write-Host "[yk] CLOUD  > Claude Code -> api.anthropic.com"
      Write-Host "[yk] stack left running. Stop it with: docker compose --project-directory $Dir down"
      Write-Host "[yk] VS Code needs a reload: Ctrl+Shift+P > Reload Window"
    }

    "status" {
      if ($env:ANTHROPIC_BASE_URL) { Write-Host "[yk] LOCAL  > $env:ANTHROPIC_BASE_URL" }
      else { Write-Host "[yk] CLOUD  > api.anthropic.com" }
      try { Invoke-RestMethod "http://localhost:11434/api/version" -TimeoutSec 3 | Out-Null; Write-Host "[yk] ollama  > up" }
      catch { Write-Host "[yk] ollama  > DOWN" }
      try { Invoke-RestMethod "$Proxy/health" -TimeoutSec 3 | Out-Null; Write-Host "[yk] proxy   > up ($Proxy)" }
      catch { Write-Host "[yk] proxy   > DOWN" }
    }

    "logs" { docker compose --project-directory $Dir logs -f yk_copilot }
    "test" { node "$Dir\scripts\test.js" --wait }

    default {
      Write-Host "Usage: yk-copilot on | off | status | logs | test"
    }
  }
}
