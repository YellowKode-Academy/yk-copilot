# YK Copilot

Local AI coding assistant, uses Claude Code as frontend and local LLMs via Ollama as backend. No API key, no cost, 100% on your machine.

## How it works

```
Claude Code CLI / VS Code Extension
        ↓  ANTHROPIC_BASE_URL=http://localhost:9999
    yk-copilot proxy
        ├── Translates Anthropic API to Ollama format
        ├── Routes requests: simple → fast model, complex → smart model
        ├── Vision: images described by gemma4, then processed by qwen2.5-coder
        ├── Web research: browser_navigate + web_search via local Playwright
        └── Tracks sessions and tokens
        ↓
    Ollama  (qwen2.5-coder + gemma4)

    Dashboard at http://localhost:9999
        └── Sessions, tokens, tool calls, model used
```

## Getting started

**Requirements:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone https://github.com/YellowKode-Academy/yk-copilot
cd yk-copilot
cp .env.example .env
docker compose up -d
```

On first run, models are downloaded automatically (~14 GB total). Monitor progress:

```bash
docker compose logs -f yk_model_init
```

Once `yk_model_init` finishes, `yk_copilot` starts automatically.

### GPU acceleration (optional)

By default Ollama runs inside Docker on CPU. For faster inference:

**Mac / Windows** — install [Ollama](https://ollama.com) natively, pull models, then set in `.env`:
```
OLLAMA_API_URL=http://host.docker.internal:11434
```
Restart with `docker compose up -d` (only `yk_copilot` and `yk_playwright` start).

**Linux** — add GPU passthrough to `yk_ollama` in `docker-compose.yml`:
```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

## Smoke test

After `docker compose up`, verify everything works before activating:

```bash
node scripts/test.js --wait
```

Runs 6 checks: proxy health, dashboard API, models endpoint, non-streaming and streaming message pipelines, and dashboard static serving. Exits 0 only if all pass.

## Quick switch: local ↔ cloud

Install the `yk-copilot` command once and toggle instantly from any terminal.

**Mac / Linux** — add to `~/.zshrc` or `~/.bashrc`:
```bash
source /full/path/to/yk-copilot/scripts/yk-switch.sh
```

**Windows** — add to your PowerShell `$PROFILE`:
```powershell
. C:\full\path\to\yk-copilot\scripts\yk-switch.ps1
```

Then:
```
yk-copilot on      # Claude Code → localhost:9999 (local LLM, free)
yk-copilot off     # Claude Code → api.anthropic.com (back to cloud)
yk-copilot status  # show current mode
```

Both commands also update VS Code `settings.json` automatically.
Reload the VS Code window after switching (`Ctrl+Shift+P` > `Reload Window`).

> CLI env vars are session-scoped. Open a new terminal and run `yk-copilot on` again,
> or add `yk-copilot on` to your shell profile to always start in local mode.

## Configure Claude Code (manual)

After containers are running, set these in your terminal:

```bash
export ANTHROPIC_BASE_URL=http://localhost:9999
export ANTHROPIC_API_KEY=ollama
claude
```

For the VS Code extension, add to your settings:

```json
{
  "claude.apiBaseUrl": "http://localhost:9999",
  "claude.apiKey": "ollama"
}
```

## Dashboard

Open **http://localhost:9999** to see active sessions, token usage, tool calls, and which model was used for each request.

## Model routing

| Condition | Model |
|---|---|
| Short request, no tool history | `qwen2.5-coder:7b` (fast) |
| Long context, multi-turn, tool results | `qwen2.5-coder:14b` (smart) |
| Request contains images | `gemma4:e4b` describes → `qwen2.5-coder` executes |

Edit `MODEL_FAST`, `MODEL_SMART`, `MODEL_VISION` in `.env` to use different Ollama models.

## Commands

```bash
docker compose logs -f yk_copilot     # proxy logs
docker compose logs -f yk_model_init  # model download progress
docker compose down                   # stop
docker compose down -v                # stop and delete all data (including models)
```

---

MIT License, [YellowKode](https://yellowkode.com) + [Wunka Tech](https://wunka.tech)
