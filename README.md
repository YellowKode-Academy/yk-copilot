# YK Copilot

Local AI coding assistant for Claude Code. No API key, no cost, 100% on your machine.

![YellowKode](https://img.shields.io/badge/YellowKode-Copilot-f5c518?style=for-the-badge)
![Free](https://img.shields.io/badge/100%25-Free-22c55e?style=for-the-badge)
![Local](https://img.shields.io/badge/100%25-Local-6366f1?style=for-the-badge)
![Open Source](https://img.shields.io/badge/Open%20Source-MIT-orange?style=for-the-badge)

> 🇧🇷 [Versão em Português](README.pt-BR.md)

---

## What it is

A proxy that sits between Claude Code and Ollama, translating the Anthropic API format into Ollama requests. Claude Code thinks it is talking to Anthropic — it is actually talking to local models running on your machine.

- Routes requests to the right model based on complexity
- Describes images with a vision model, then passes context to the code model
- Runs web searches via a local Playwright browser (no external API)
- Tracks sessions, tokens and tool calls on a local dashboard

## How it works

```
Claude Code CLI / VS Code Extension
        |  ANTHROPIC_BASE_URL=http://localhost:9999
    yk-copilot proxy  (port 9999)
        |-- simple requests   -> qwen2.5-coder:7b  (fast)
        |-- complex / tools   -> qwen2.5-coder:14b (smart)
        |-- images            -> gemma4:e4b describes -> qwen executes
        |-- web_search        -> Playwright (local browser, no API key)
        |
    Ollama (qwen2.5-coder + gemma4)

Dashboard: http://localhost:9999
```

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Claude Code](https://claude.ai/code) (CLI or VS Code extension)

## Getting started

```bash
git clone https://github.com/YellowKode-Academy/yk-copilot
cd yk-copilot
cp .env.example .env
docker compose up -d
```

On first run, models are downloaded automatically (~16 GB total). Monitor progress:

```bash
docker compose logs -f yk_model_init
```

Once `yk_model_init` exits, `yk_copilot` starts automatically.

## Register the yk-copilot command

Run once to add `yk-copilot on/off` to any terminal:

**Mac / Linux**
```bash
bash scripts/install.sh
```

**Windows (PowerShell)**
```powershell
.\scripts\install.ps1
```

Open a new terminal after running the installer.

## Switch between local and cloud

```bash
yk-copilot on      # Claude Code uses local models (free)
yk-copilot off     # Claude Code uses api.anthropic.com
yk-copilot status  # show current mode
```

Both commands also update VS Code `settings.json` automatically.
After switching, reload the VS Code window: `Ctrl+Shift+P` > `Reload Window`.

## Models

| Model | Size | Role |
|---|---|---|
| `qwen2.5-coder:7b` | ~4.7 GB | Fast responses, simple tasks |
| `qwen2.5-coder:14b` | ~9 GB | Complex tasks, tool use, long context |
| `gemma4:e4b` | ~2.5 GB | Vision: describes images sent by Claude Code |

Edit `MODEL_FAST`, `MODEL_SMART`, `MODEL_VISION` in `.env` to swap models.

## GPU acceleration (optional)

By default Ollama runs inside Docker on CPU. For faster inference with a GPU:

**Mac / Windows** - install [Ollama](https://ollama.com) natively, then set in `.env`:
```
OLLAMA_API_URL=http://host.docker.internal:11434
```

**Linux** - add to the `yk_ollama` service in `docker-compose.yml`:
```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

Restart with `docker compose up -d` after any `.env` change.

## Smoke test

Verify everything works before switching Claude Code to local mode:

```bash
node scripts/test.js --wait
```

Runs 12 checks: proxy, dashboard, models, streaming, tool calling, vision pipeline, web search, and complex coding prompts.

## Commands

```bash
docker compose logs -f yk_copilot     # proxy logs
docker compose logs -f yk_model_init  # model download progress
docker compose ps                     # container status
docker compose down                   # stop
docker compose down -v                # stop and delete all data (including models)
```

---

MIT License, [YellowKode](https://yellowkode.com) + [Wunka Tech](https://wunka.tech)
