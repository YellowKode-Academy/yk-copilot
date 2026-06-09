# YK Copilot

Assistente de codigo com IA local para o Claude Code. Sem API key, sem custo, 100% na sua maquina.

![YellowKode](https://img.shields.io/badge/YellowKode-Copilot-f5c518?style=for-the-badge)
![Free](https://img.shields.io/badge/100%25-Free-22c55e?style=for-the-badge)
![Local](https://img.shields.io/badge/100%25-Local-6366f1?style=for-the-badge)
![Open Source](https://img.shields.io/badge/Open%20Source-MIT-orange?style=for-the-badge)

> 🇺🇸 [English version](README.md)

---

## O que e

Um proxy que fica entre o Claude Code e o Ollama, traduzindo o formato da API da Anthropic para requisicoes Ollama. O Claude Code acha que esta falando com a Anthropic, mas na verdade esta falando com modelos rodando localmente na sua maquina.

- Roteia requisicoes para o modelo certo conforme a complexidade
- Descreve imagens com um modelo de visao e passa o contexto para o modelo de codigo
- Pesquisa na web via um browser Playwright local (sem API externa)
- Registra sessoes, tokens e tool calls em um dashboard local

## Como funciona

```
Claude Code CLI / Extensao VS Code
        |  ANTHROPIC_BASE_URL=http://localhost:9999
    yk-copilot proxy  (porta 9999)
        |-- requisicoes simples  -> qwen2.5-coder:7b  (rapido)
        |-- complexas / tools   -> qwen2.5-coder:14b (inteligente)
        |-- imagens             -> gemma4:e4b descreve -> qwen executa
        |-- web_search          -> Playwright (browser local, sem API)
        |
    Ollama (qwen2.5-coder + gemma4)

Dashboard: http://localhost:9999
```

## Requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Claude Code](https://claude.ai/code) (CLI ou extensao VS Code)

## Como comecar

```bash
git clone https://github.com/YellowKode-Academy/yk-copilot
cd yk-copilot
cp .env.example .env
docker compose up -d
```

Na primeira execucao, os modelos sao baixados automaticamente (~16 GB no total). Acompanhe o progresso:

```bash
docker compose logs -f yk_model_init
```

Quando o `yk_model_init` finalizar, o `yk_copilot` sobe automaticamente.

## Registrar o comando yk-copilot

Execute uma vez para ter `yk-copilot on/off` disponivel em qualquer terminal:

**Mac / Linux**
```bash
bash scripts/install.sh
```

**Windows (PowerShell)**
```powershell
.\scripts\install.ps1
```

Abra um terminal novo apos rodar o instalador.

## Alternar entre local e cloud

```bash
yk-copilot on      # Claude Code usa modelos locais (gratis)
yk-copilot off     # Claude Code volta para api.anthropic.com
yk-copilot status  # mostra o modo atual
```

Os dois comandos tambem atualizam o `settings.json` do VS Code automaticamente.
Apos trocar, recarregue a janela do VS Code: `Ctrl+Shift+P` > `Reload Window`.

## Modelos

| Modelo | Tamanho | Funcao |
|---|---|---|
| `qwen2.5-coder:7b` | ~4.7 GB | Respostas rapidas, tarefas simples |
| `qwen2.5-coder:14b` | ~9 GB | Tarefas complexas, tool use, contexto longo |
| `gemma4:e4b` | ~2.5 GB | Visao: descreve imagens enviadas pelo Claude Code |

Edite `MODEL_FAST`, `MODEL_SMART`, `MODEL_VISION` no `.env` para trocar os modelos.

## Aceleracao por GPU (opcional)

Por padrao o Ollama roda dentro do Docker na CPU. Para inferencia mais rapida com GPU:

**Mac / Windows** - instale o [Ollama](https://ollama.com) nativamente e defina no `.env`:
```
OLLAMA_API_URL=http://host.docker.internal:11434
```

**Linux** - adicione ao servico `yk_ollama` no `docker-compose.yml`:
```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

Reinicie com `docker compose up -d` apos qualquer alteracao no `.env`.

## Smoke test

Verifique se tudo funciona antes de ativar o modo local no Claude Code:

```bash
node scripts/test.js --wait
```

Executa 12 verificacoes: proxy, dashboard, modelos, streaming, tool calling, pipeline de visao, pesquisa web e prompts complexos de codigo.

## Comandos uteis

```bash
docker compose logs -f yk_copilot     # logs do proxy
docker compose logs -f yk_model_init  # progresso do download dos modelos
docker compose ps                     # status dos containers
docker compose down                   # parar
docker compose down -v                # parar e apagar todos os dados (incluindo modelos)
```

---

MIT License, [YellowKode](https://yellowkode.com) + [Wunka Tech](https://wunka.tech)
