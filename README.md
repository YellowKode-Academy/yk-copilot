# YK Copilot

Local AI coding assistant for Claude Code. No API key, no cost, 100% on your machine.

![YellowKode](https://img.shields.io/badge/YellowKode-Copilot-f5c518?style=for-the-badge)
![Free](https://img.shields.io/badge/100%25-Free-22c55e?style=for-the-badge)
![Local](https://img.shields.io/badge/100%25-Local-6366f1?style=for-the-badge)
![Open Source](https://img.shields.io/badge/Open%20Source-MIT-orange?style=for-the-badge)

> 🇧🇷 [Versão em Português](README.pt-BR.md)

---

## What it is

A proxy that sits between Claude Code and Ollama. Claude Code thinks it is talking to Anthropic — it is actually talking to a model running on your machine.

Ollama has served the Anthropic Messages format natively since v0.14, so translation alone is no longer a reason to run this. Context is. The same 3-step task, same model, same machine, run both ways: pointed straight at Ollama the model lost the task and wrote nothing (689s); through this proxy it added the function, wrote four unit tests and ran them (600s). The difference is that the proxy compresses what Claude Code sends before the model has to read it.

Getting this to work is mostly a fight for context. Claude Code's system prompt and tool definitions are written for a frontier model with a huge window: measured here, **27 KB of system prompt and 88 KB of tool schemas — around 18,000 tokens before you have typed anything.** A 7B model on a laptop GPU does not have room for that and the conversation. So the proxy compresses both on the way through, and that compression is what makes local coding actually work rather than merely start.

- Compresses tool schemas and the host system prompt to fit a local context window
- Routes to a fast or a smart model depending on the request
- Describes images with a vision model, then hands the text to the code model
- Runs web searches through a local Playwright browser (no external API)
- Tracks sessions, tokens and tool calls on a local dashboard

## How it works

```
Claude Code CLI / VS Code Extension
        |  ANTHROPIC_BASE_URL=http://localhost:9999
    yk-copilot proxy  (port 9999)
        |-- compress tool schemas   88KB -> 22KB
        |-- compress system prompt  27KB ->  8KB
        |-- simple requests   -> MODEL_FAST
        |-- complex / tools   -> MODEL_SMART  (everything Claude Code sends)
        |-- images            -> MODEL_VISION describes -> code model executes
        |-- web_search        -> Playwright (local browser, no API key)
        |
    Ollama (native on the host, or in a container)

Dashboard: http://localhost:9999
```

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Claude Code](https://claude.ai/code) (CLI or VS Code extension)
- [Ollama](https://ollama.com), installed natively — see below

## Ollama: native, not in the container

Docker Desktop on Mac and Windows does not pass the GPU through to containers, so an Ollama container there runs on CPU — around ten times slower, which for interactive coding means unusable. Install Ollama natively and it uses your GPU directly.

```bash
ollama pull qwen3-coder:30b
ollama pull gemma3:4b
```

The proxy runs in a container and reaches the host through `host.docker.internal`, so Ollama has to listen on all interfaces rather than only on loopback. These four settings matter, and the last two are what let a 24k context fit on an 8 GB card at all:

```bash
# Mac / Linux
export OLLAMA_HOST=0.0.0.0
export OLLAMA_KEEP_ALIVE=24h
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
```
```powershell
# Windows (PowerShell, once)
[Environment]::SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','User')
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE','24h','User')
[Environment]::SetEnvironmentVariable('OLLAMA_FLASH_ATTENTION','1','User')
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE','q8_0','User')
```

Restart Ollama afterwards and confirm the settings took: `ollama ps` should show a 24-hour keep-alive once a model is loaded. A model larger than your VRAM will show a CPU/GPU split there, which is expected for an MoE and not a problem. Without `OLLAMA_KV_CACHE_TYPE=q8_0` the KV cache doubles and the runner dies mid-request with a dropped connection.

**Containerized Ollama** is the fallback: no host install, CPU-only on Mac and Windows, GPU on Linux (uncomment the `deploy.resources` block under `yk_ollama`). Set `OLLAMA_API_URL=http://yk_ollama:11434` in `.env` and start with `docker compose --profile with-ollama up -d`.

## Pick a model that does native tool calling

This is the single most important choice, and the obvious pick is the wrong one.

Claude Code is agentic: every request carries tool definitions and the answer is usually a tool call. A model whose Ollama template does not emit native `tool_calls` narrates JSON as prose instead, and the proxy has to guess. Measured here on the same prompt:

| Model | Native `tool_calls` | Verdict |
|---|---|---|
| `qwen3-coder:30b` | yes | **use this** — the only one that finished a 3-step task |
| `qwen2.5:7b` | yes, correct, fast | fine for single-step work, loses the thread on step 3 |
| `qwen2.5-coder:7b` | never — always JSON as text | avoid despite the name |
| `qwen3:8b` | yes | correct but 77–167s per turn; the thinking mode is not worth it |

Note the second row carefully. A 7B model does real work — it edits a file, writes a correct function, answers about code. It fails on *chains*: asked to do three things in sequence it either narrates without acting or, worse, reports success on commands it never ran. If you code in small steps, a 7B is genuinely useful. If you want to hand over a task and walk away, you need the 30B.

`qwen3-coder:30b` is a mixture-of-experts model: 30B total but only ~3.3B active per token. That is why it runs on a card that cannot hold it. Measured on an 8 GB RTX 4060 Laptop with the weights split 69% CPU / 31% GPU:

- generation: **~28 tok/s**, steady from a small prompt up to 11k tokens of context
- prompt digestion: ~1,500–2,400 tok/s once the model is warm
- Ollama reuses the unchanged prefix between turns, so only new tokens cost anything
- first load after a restart: ~20s

Sizing for other cards:

| VRAM | MODEL_SMART |
|---|---|
| 8 GB | `qwen3-coder:30b` (MoE, spills to RAM and still works) |
| 12–16 GB | `qwen3-coder:30b` or `gpt-oss:20b` |
| 24 GB+ | `qwen3-coder:30b` fully resident, or `glm-4.7-flash` |

Set `MODEL_FAST` to the same model as `MODEL_SMART`. With `OLLAMA_MAX_LOADED_MODELS=1`, switching between two models costs a ~20s reload, and since Claude Code always sends tools it always lands on `MODEL_SMART` anyway.

## Getting started

```bash
git clone https://github.com/YellowKode-Academy/yk-copilot
cd yk-copilot
cp .env.example .env
docker compose up -d
node scripts/test.js --wait
```

With native Ollama, `docker compose up -d` starts only the proxy and the Playwright browser.

If the build fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, your network intercepts TLS (a corporate proxy or some antivirus suites). Set `NPM_STRICT_SSL=false` in `.env` and rebuild.

## Register the yk-copilot command

```bash
bash scripts/install.sh      # Mac / Linux
```
```powershell
.\scripts\install.ps1        # Windows
```

Open a new terminal afterwards. On Windows the installer covers both shells: it
registers a function in your PowerShell profile and drops a `yk-copilot.cmd` on your
PATH, since `cmd.exe` cannot see a PowerShell function.

```bash
yk-copilot on      # start the stack, point Claude Code at local models
yk-copilot off     # back to api.anthropic.com
yk-copilot status  # current mode + Ollama and proxy health
yk-copilot test    # run the smoke test
yk-copilot logs    # follow proxy logs
```

They also set `claudeCode.initialPermissionMode` to `acceptEdits`. The extension's
**Auto** mode asks a model on Anthropic's side whether a command is safe to run, and
against a local proxy there is no such model — every shell command then fails with
*"claude-opus-5 is temporarily unavailable, so auto mode cannot determine the safety
of Bash"*. `acceptEdits` approves file edits locally and asks you about shell commands.

`on` and `off` persist the environment variables at user scope, so new terminals pick up the change. They also write `claudeCode.environmentVariables` into VS Code's `settings.json`, which is what the extension actually reads — it does not inherit your shell's environment. **Reload the VS Code window afterwards** (`Ctrl+Shift+P` > `Reload Window`), or the extension quietly keeps using the cloud, and the only sign is the model name in the corner of the chat panel.

## Keep your MCP servers small

This will bite you, and it does not look like a context problem when it does.

Every MCP tool definition is re-sent on every request and is charged against the context window before the model reads your question. Measured here: Claude Code's own 27 tools compress to about 5,700 tokens — but with the MCP servers from a real project attached, the same request carried **95 tools and 20,400 tokens**, filling a 24k window entirely. The model answered with confused prose and nothing worked, with no error to explain why.

The proxy does not just fail when this happens. Tools are ranked and the ones that do
not fit are dropped, in this order:

1. the model's own file and shell tools — losing `Edit` costs the ability to code at all
2. anything named in `TOOL_PRIORITY`
3. MCP servers from the project's own `.mcp.json` — you put them there on purpose
4. connectors attached to the claude.ai account, which the extension loads whether the
   project asked for them or not

Within a tier, tools compete on how well they match the request. Ask about Instagram
posts and the Instagram tools get the room; ask to transcribe a video and the
transcription tools do. Matching is lexical, with a shared-prefix rule for cognates
(*transcrever* → `transcribe`), so it works across languages for related words and not
for unrelated ones — *navegador* will not find `browser`.

That keeps a large server usable, but it is a rescue, not a plan. A server exposing
200+ tools still crowds out everything else on a 24k window. Prefer a small, per-task
`.mcp.json` when coding against a local model:

```bash
claude --mcp-config .mcp.json --strict-mcp-config
```

`--strict-mcp-config` makes Claude Code ignore your global servers and use only that file. There is an example in [examples/mcp.json](examples/mcp.json).

`ollos` pairs well with local coding: it transcribes audio and reads text off screenshots and video frames, returning text, so nothing else has to fit in VRAM next to the code model.

## Tuning

Everything here is set in `.env` and read at startup.

| Variable | Default | What it does |
|---|---|---|
| `NUM_CTX` | `24576` | Context window. Ollama's own default is 4096, which silently truncates Claude Code's prompt before the model sees your request. Do not go below 16384. |
| `TOOL_DESC_LIMIT` | `400` | Max characters per tool description. Cuts the tool schemas by ~75%. |
| `ARG_DESC_LIMIT` | `120` | Max characters per parameter description. |
| `SYSTEM_LIMIT` | `8000` | Max characters of the host system prompt, keeping the opening and the closing. Without this a 7B model answers in prose instead of calling the next tool. Your `CLAUDE.md` is unaffected: Claude Code sends it inside the messages, not the system prompt. |
| `SNAPSHOT_LIMIT` | `4000` | Max characters of a web page handed to the model. |
| `OLLAMA_RETRIES` | `2` | Retries when the Ollama runner dies mid-request. A model that does not fit in VRAM lives partly in system RAM, and on a busy desktop it occasionally gets killed; Ollama reloads it on the next call, so the retry usually succeeds. |
| `RESULT_LIMIT` | `6000` | Max characters kept from a single tool result. A directory listing or a page of logs is mostly noise by the next turn. |
| `TOOL_PRIORITY` | *(empty)* | Comma-separated fragments of tool names to keep ahead of everything else, e.g. `ollos,playwright`. |
| `TOOL_BUDGET` | `0.35` | Share of `NUM_CTX` the tool schemas may take. Past it, tools are dropped — MCP ones first, the model's own file and shell tools last. Without this the VS Code extension's 334 tools (~69k tokens) kill the runner, and the chat shows a dropped connection rather than anything about context. |
| `BROWSER_TOOLS` | `0` | Offer the proxy's own Playwright search tools. Off because Claude Code has its own, and offering both made the model spend six turns searching the web for a `flatten` function. Set to `1` when something other than Claude Code calls this API. |
| `MODEL_FAST` | `qwen2.5:7b` | Short requests with no tools. |
| `MODEL_SMART` | `qwen2.5:7b` | Everything Claude Code sends. |
| `MODEL_VISION` | `gemma3:4b` | Describes images for the code model. |

Raise `TOOL_DESC_LIMIT` and `SYSTEM_LIMIT` if the model misuses a tool; lower `NUM_CTX` to 16384 if you run out of VRAM.

## Smoke test

```bash
node scripts/test.js --wait
```

Twelve checks: proxy, dashboard, models, streaming, tool calling, multi-turn tool results, vision pipeline, web search, and a real coding prompt. Run it before switching Claude Code over — it fails loudly where a misconfigured stack fails silently.

## What to expect

Two tasks, same machine, to calibrate:

- *"Edit calc.py so divide raises ValueError when b is zero"* — done correctly in 18s
- *"Add subtract, write unit tests for all three functions, run them"* — the 30B completed it in **3.5 minutes**: function added, four tests written, tests executed and passing, verified independently afterwards. A 7B failed the same task twice, once by narrating without acting and once by reporting a test run that never happened.

A few minutes for something a frontier model does in one is the real trade. It is not free of supervision either — check that files changed rather than trusting the summary, because a local model's worst failure is a confident report of work it never did. But it runs with the network off and costs nothing.

## Commands

```bash
docker compose logs -f yk_copilot     # proxy logs, including compression stats
docker compose ps                     # container status
docker compose down                   # stop
ollama ps                             # what is loaded in VRAM, and on GPU or CPU
```

---

MIT License, [YellowKode](https://yellowkode.com) + [Wunka Tech](https://wunka.tech)
