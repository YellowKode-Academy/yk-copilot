# YK Copilot

Local AI coding assistant, uses Claude Code as frontend and a local LLM via Ollama as backend. No API key, no cost, 100% on your machine.

## How it works

```
Claude Code CLI / VS Code Extension
        ↓  ANTHROPIC_BASE_URL=http://localhost:9999
    yk-copilot proxy
        ├── Translates Anthropic API to Ollama format
        ├── Routes requests: simple → fast model, complex → smart model
        └── Tracks sessions and tokens
        ↓
    Ollama (qwen2.5-coder)

    Dashboard at http://localhost:9999
        └── Sessions, tokens, tool calls, model used
```

## Getting started

**Requirement:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone <url> yk-copilot
cd yk-copilot
cp .env.example .env
docker compose up -d
```

> On first run, models are downloaded automatically (qwen2.5-coder:7b ~4 GB, qwen2.5-coder:14b ~8 GB).
> Monitor with `docker compose logs -f yk_model_init`.

## Configure Claude Code

After the containers are running, set these environment variables in your terminal:

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

| Condition | Model used |
|---|---|
| Short request, no tool history | `qwen2.5-coder:7b` (fast) |
| Long context, multi-turn, tool results | `qwen2.5-coder:14b` (smart) |

Edit `MODEL_FAST` and `MODEL_SMART` in `.env` to use different models. Any Ollama model with tool calling support works.

## Commands

```bash
docker compose logs -f yk_copilot     # proxy logs
docker compose logs -f yk_model_init  # model download progress
docker compose down                   # stop
docker compose down -v                # stop and delete all data
```

---

MIT License, [YellowKode](https://yellowkode.com) + [Wunka Tech](https://wunka.tech)
