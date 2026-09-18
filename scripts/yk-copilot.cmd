@echo off
REM yk-copilot.cmd — the same on/off/status switch, for cmd.exe
REM
REM The PowerShell version is a function, so it does not exist in cmd. This script
REM does the equivalent. Note there is no `setlocal` here on purpose: without it the
REM `set` calls below reach the calling shell, which is the whole point of `on`.
REM
REM Install: copy this file to any directory on your PATH, or run scripts\install.ps1
REM which does it for you.

REM This file gets copied onto the PATH, where %~dp0 is no longer the project.
REM install.ps1 records YK_DIR as a user variable; fall back to the script's own
REM parent only when that actually looks like the project.
if not "%YK_DIR%"=="" goto :havedir
set "YK_DIR=%~dp0.."
if exist "%YK_DIR%\docker-compose.yml" goto :havedir
echo [yk] cannot find the yk-copilot directory.
echo [yk] set it once with:  setx YK_DIR "C:\path\to\yk-copilot"
exit /b 1
:havedir
if "%YK_PORT%"=="" set "YK_PORT=9999"
set "YK_PROXY=http://localhost:%YK_PORT%"
set "YK_OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

if /i "%~1"=="on"     goto :on
if /i "%~1"=="off"    goto :off
if /i "%~1"=="status" goto :status
if /i "%~1"=="logs"   goto :logs
if /i "%~1"=="test"   goto :test
if "%~1"==""          goto :status
goto :usage

:on
curl -s -o nul --max-time 3 http://localhost:11434/api/version
if errorlevel 1 (
  if exist "%YK_OLLAMA%" (
    echo [yk] starting Ollama...
    start "" /b "%YK_OLLAMA%" serve
    timeout /t 4 /nobreak >nul
  ) else (
    echo [yk] WARNING: Ollama not found. Install from https://ollama.com
  )
)
echo [yk] starting stack...
docker compose --project-directory "%YK_DIR%" up -d >nul 2>&1
set "ANTHROPIC_BASE_URL=%YK_PROXY%"
set "ANTHROPIC_API_KEY=ollama"
REM Persist for new shells too, the way the PowerShell version does.
setx ANTHROPIC_BASE_URL "%YK_PROXY%" >nul
setx ANTHROPIC_API_KEY  "ollama"     >nul
call :vscode on
echo [yk] LOCAL  ^> Claude Code -^> %YK_PROXY%
echo [yk] dashboard: %YK_PROXY%
echo [yk] check it with: yk-copilot test
goto :eof

:off
set "ANTHROPIC_BASE_URL="
set "ANTHROPIC_API_KEY="
REM setx cannot delete; reg delete is how you remove a user variable.
reg delete "HKCU\Environment" /F /V ANTHROPIC_BASE_URL >nul 2>&1
reg delete "HKCU\Environment" /F /V ANTHROPIC_API_KEY  >nul 2>&1
call :vscode off
echo [yk] CLOUD  ^> Claude Code -^> api.anthropic.com
echo [yk] stack left running. Stop it with: docker compose --project-directory "%YK_DIR%" down
goto :eof

:status
if defined ANTHROPIC_BASE_URL (
  echo [yk] LOCAL  ^> %ANTHROPIC_BASE_URL%
) else (
  echo [yk] CLOUD  ^> api.anthropic.com
)
curl -s -o nul --max-time 3 http://localhost:11434/api/version && (echo [yk] ollama  ^> up) || (echo [yk] ollama  ^> DOWN)
curl -s -o nul --max-time 3 "%YK_PROXY%/health"               && (echo [yk] proxy   ^> up ^(%YK_PROXY%^)) || (echo [yk] proxy   ^> DOWN)
goto :eof

:logs
docker compose --project-directory "%YK_DIR%" logs -f yk_copilot
goto :eof

:test
node "%YK_DIR%\scripts\test.js" --wait
goto :eof

:vscode
REM The VS Code extension does not inherit this shell's environment; it reads
REM claudeCode.environmentVariables from settings.json. Keep the two in step.
where node >nul 2>&1 || goto :eof
if not exist "%APPDATA%\Code\User\settings.json" goto :eof
node "%YK_DIR%\scripts\vscode-toggle.js" "%APPDATA%\Code\User\settings.json" %1 "%YK_PROXY%"
goto :eof

:usage
echo Usage: yk-copilot on ^| off ^| status ^| logs ^| test
goto :eof
