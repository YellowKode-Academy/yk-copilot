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

**Requirement:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone https://github.com/YellowKode-Academy/yk-copilot
cd yk-copilot
cp .env.example .env
```

### Linux

Ollama runs inside Docker. Models are pulled automatically on first run.

```bash
docker compose --profile with-ollama up -d
```

> First run downloads ~14 GB of models. Monitor with `docker compose logs -f yk_model_init`.

### Mac / Windows (recommended)

Install [Ollama](https://ollama.com) natively so it uses your GPU (Metal on Apple Silicon, CUDA on Windows).

```bash
# Pull models
ollama pull qwen2.5-coder:7b
ollama pull qwen2.5-coder:14b
ollama pull gemma4:e4b

# Uncomment in .env:
# OLLAMA_API_URL=http://host.docker.internal:11434

# Start only the proxy and browser
docker compose up -d
```

> Running Ollama natively on Mac/Windows gives full GPU acceleration. Inside Docker it would run CPU-only, which is very slow for the 14B model.

## Configure Claude Code

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
docker compose logs -f yk_model_init  # model download progress (Linux)
docker compose down                   # stop
docker compose down -v                # stop and delete all data
```

---

MIT License, [YellowKode](https://yellowkode.com) + [Wunka Tech](https://wunka.tech)
