@echo off
REM claude-local.cmd — launch Claude Code with its MCP servers switched off.
REM
REM Point the VS Code extension at this via the claudeCode.claudeProcessWrapper
REM setting. The extension takes no command-line flags of its own, and it loads every
REM MCP server on your account: measured here that was 334 tools and ~69,000 tokens
REM of schema, against a local context window of 24,576. The request cannot fit, and
REM what you see is not a context error — the Ollama runner dies and the chat shows a
REM dropped connection.
REM
REM --strict-mcp-config makes Claude Code use only the file named by --mcp-config,
REM and that file declares no servers.
REM
REM To keep a few servers, edit mcp-local.json rather than removing these flags.

set "YK_MCP=%~dp0mcp-local.json"
if not exist "%YK_MCP%" (
  echo {"mcpServers":{}}> "%YK_MCP%"
)

claude --mcp-config "%YK_MCP%" --strict-mcp-config %*
