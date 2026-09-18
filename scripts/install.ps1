# install.ps1 — registers yk-copilot on/off globally in PowerShell
# Run once: .\scripts\install.ps1
# After that, yk-copilot on/off works in any new terminal.

$YkDir   = Split-Path -Parent $PSScriptRoot
$Switch  = "$YkDir\scripts\yk-switch.ps1"
$Profile = $PROFILE

# Create profile file if it doesn't exist yet
if (-not (Test-Path $Profile)) {
  New-Item -ItemType File -Path $Profile -Force | Out-Null
}

# cmd.exe cannot see a PowerShell function, so install a .cmd wrapper on the PATH
# for anyone working there.
# The wrapper is copied onto the PATH, where it can no longer locate the project
# from its own path, so record where it lives.
[Environment]::SetEnvironmentVariable('YK_DIR', $YkDir, 'User')

$CmdSrc = "$YkDir\scripts\yk-copilot.cmd"
$CmdDir = "$env:USERPROFILE\.localin"
if (Test-Path $CmdSrc) {
  if (-not (Test-Path $CmdDir)) { New-Item -ItemType Directory -Force -Path $CmdDir | Out-Null }
  Copy-Item $CmdSrc $CmdDir -Force
  $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
  if ($userPath -notlike "*$CmdDir*") {
    [Environment]::SetEnvironmentVariable('PATH', "$userPath;$CmdDir", 'User')
    Write-Host "[yk] added $CmdDir to your PATH (for cmd.exe)"
  }
  Write-Host "[yk] cmd wrapper installed at $CmdDir\yk-copilot.cmd"
}

$content = Get-Content $Profile -Raw -ErrorAction SilentlyContinue

$line1 = "`$env:YK_DIR = `"$YkDir`""
$line2 = ". `"$Switch`""

$already = $content -and $content.Contains($line2)

if ($already) {
  Write-Host "[yk] Already installed. yk-copilot on/off is ready."
} else {
  Add-Content -Path $Profile -Value "`n# yk-copilot`n$line1`n$line2"
  Write-Host "[yk] Installed! Open a new terminal and run:"
  Write-Host ""
  Write-Host "  yk-copilot on    (activate local mode)"
  Write-Host "  yk-copilot off   (back to cloud)"
  Write-Host "  yk-copilot status"
}
