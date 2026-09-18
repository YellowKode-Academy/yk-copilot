# YK Copilot

Assistente de código com IA local para o Claude Code. Sem API key, sem custo, 100% na sua máquina.

![YellowKode](https://img.shields.io/badge/YellowKode-Copilot-f5c518?style=for-the-badge)
![Free](https://img.shields.io/badge/100%25-Gratuito-22c55e?style=for-the-badge)
![Local](https://img.shields.io/badge/100%25-Local-6366f1?style=for-the-badge)
![Open Source](https://img.shields.io/badge/Open%20Source-MIT-orange?style=for-the-badge)

> 🇺🇸 [English version](README.md)

---

## O que é

Um proxy que fica entre o Claude Code e o Ollama. O Claude Code acha que está falando com a Anthropic — está falando com um modelo rodando na sua máquina.

O Ollama serve o formato Messages da Anthropic nativamente desde a v0.14, então só traduzir já não é motivo para rodar isto. Contexto é. A mesma tarefa de 3 passos, mesmo modelo, mesma máquina, pelos dois caminhos: apontado direto no Ollama o modelo perdeu a tarefa e não escreveu nada (689s); por este proxy ele adicionou a função, escreveu quatro testes unitários e rodou (600s). A diferença é que o proxy comprime o que o Claude Code manda antes do modelo ter que ler.

Fazer isso funcionar é, acima de tudo, uma briga por contexto. O system prompt e as definições de ferramentas do Claude Code foram escritos para um modelo de fronteira com janela enorme: medido aqui, **27 KB de system prompt e 88 KB de schemas de ferramentas — cerca de 18.000 tokens antes de você digitar qualquer coisa.** Um modelo 7B numa GPU de notebook não tem espaço para isso mais a conversa. Por isso o proxy comprime os dois no caminho, e é essa compressão que faz codar local realmente funcionar em vez de apenas iniciar.

- Comprime os schemas de ferramentas e o system prompt para caber numa janela local
- Roteia para um modelo rápido ou inteligente conforme a requisição
- Descreve imagens com um modelo de visão e entrega o texto ao modelo de código
- Faz busca na web com um browser Playwright local (sem API externa)
- Acompanha sessões, tokens e chamadas de ferramenta num dashboard local

## Como funciona

```
Claude Code CLI / Extensão do VS Code
        |  ANTHROPIC_BASE_URL=http://localhost:9999
    proxy yk-copilot  (porta 9999)
        |-- comprime schemas        88KB -> 22KB
        |-- comprime system prompt  27KB ->  8KB
        |-- requisições simples  -> MODEL_FAST
        |-- complexas / com tool -> MODEL_SMART  (tudo que o Claude Code manda)
        |-- imagens              -> MODEL_VISION descreve -> modelo de código executa
        |-- web_search           -> Playwright (browser local, sem API key)
        |
    Ollama (nativo no host, ou em container)

Dashboard: http://localhost:9999
```

## Requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Claude Code](https://claude.ai/code) (CLI ou extensão do VS Code)
- [Ollama](https://ollama.com), instalado nativamente — veja abaixo

## Ollama: nativo, não no container

O Docker Desktop no Mac e no Windows não repassa a GPU para os containers, então um Ollama em container ali roda na CPU — cerca de dez vezes mais lento, o que para codar interativamente significa inviável. Instale o Ollama nativo e ele usa sua GPU direto.

```bash
ollama pull qwen3-coder:30b
ollama pull gemma3:4b
```

O proxy roda em container e alcança o host por `host.docker.internal`, então o Ollama precisa escutar em todas as interfaces, não só no loopback. Estas quatro configurações importam, e as duas últimas são o que permite um contexto de 24k caber numa placa de 8 GB:

```bash
# Mac / Linux
export OLLAMA_HOST=0.0.0.0
export OLLAMA_KEEP_ALIVE=24h
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
```
```powershell
# Windows (PowerShell, uma vez)
[Environment]::SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','User')
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE','24h','User')
[Environment]::SetEnvironmentVariable('OLLAMA_FLASH_ATTENTION','1','User')
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE','q8_0','User')
```

Reinicie o Ollama depois e confirme que pegou: com um modelo carregado, `ollama ps` deve mostrar keep-alive de 24 horas. Um modelo maior que sua VRAM vai aparecer ali com divisão CPU/GPU, o que é esperado num MoE e não é problema. Sem `OLLAMA_KV_CACHE_TYPE=q8_0` o KV cache dobra e o runner morre no meio da requisição, derrubando a conexão.

**Ollama em container** é o plano B: sem instalar nada no host, só CPU no Mac e Windows, GPU no Linux (descomente o bloco `deploy.resources` no `yk_ollama`). Coloque `OLLAMA_API_URL=http://yk_ollama:11434` no `.env` e suba com `docker compose --profile with-ollama up -d`.

## Escolha um modelo com tool calling nativo

Essa é a decisão mais importante, e a escolha óbvia é a errada.

O Claude Code é agentic: toda requisição leva definições de ferramentas e a resposta normalmente é uma chamada de ferramenta. Um modelo cujo template no Ollama não emite `tool_calls` nativo narra JSON como texto, e o proxy tem que adivinhar. Medido aqui com o mesmo prompt:

| Modelo | `tool_calls` nativo | Veredito |
|---|---|---|
| `qwen3-coder:30b` | sim | **use este** — o único que terminou uma tarefa de 3 passos |
| `qwen2.5:7b` | sim, correto e rápido | serve para um passo só; perde o fio no terceiro |
| `qwen2.5-coder:7b` | nunca — sempre JSON como texto | evite, apesar do nome |
| `qwen3:8b` | sim | correto mas 77–167s por turno; o modo thinking não compensa |

Repare na segunda linha. Um modelo 7B faz trabalho de verdade — edita arquivo, escreve função correta, responde sobre código. Ele falha em *cadeias*: pedindo três coisas em sequência, ou ele narra sem agir ou, pior, relata sucesso de comandos que nunca rodou. Se você coda em passos pequenos, um 7B é genuinamente útil. Se você quer entregar uma tarefa e sair de perto, precisa do 30B.

O `qwen3-coder:30b` é um modelo mixture-of-experts: 30B no total mas só ~3,3B ativos por token. É por isso que ele roda numa placa que não o comporta. Medido numa RTX 4060 Laptop de 8 GB, com os pesos divididos 69% CPU / 31% GPU:

- geração: **~28 tok/s**, estável de um prompt pequeno até 11k tokens de contexto
- digestão do prompt: ~1.500–2.400 tok/s com o modelo já quente
- o Ollama reaproveita o prefixo que não mudou entre turnos, então só os tokens novos custam
- primeira carga depois de reiniciar: ~20s

Dimensionando para outras placas:

| VRAM | MODEL_SMART |
|---|---|
| 8 GB | `qwen3-coder:30b` (MoE, transborda para a RAM e ainda funciona) |
| 12–16 GB | `qwen3-coder:30b` ou `gpt-oss:20b` |
| 24 GB+ | `qwen3-coder:30b` inteiro na VRAM, ou `glm-4.7-flash` |

Deixe `MODEL_FAST` igual ao `MODEL_SMART`. Com `OLLAMA_MAX_LOADED_MODELS=1`, alternar entre dois modelos custa ~20s de recarga, e como o Claude Code sempre manda ferramentas ele sempre cai no `MODEL_SMART` de qualquer jeito.

## Começando

```bash
git clone https://github.com/YellowKode-Academy/yk-copilot
cd yk-copilot
cp .env.example .env
docker compose up -d
node scripts/test.js --wait
```

Com Ollama nativo, `docker compose up -d` sobe apenas o proxy e o browser Playwright.

Se o build falhar com `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, sua rede intercepta TLS (proxy corporativo ou alguns antivírus). Coloque `NPM_STRICT_SSL=false` no `.env` e rode o build de novo.

## Registre o comando yk-copilot

```bash
bash scripts/install.sh      # Mac / Linux
```
```powershell
.\scripts\install.ps1        # Windows
```

Abra um terminal novo depois. No Windows o instalador cobre os dois shells: registra
uma função no seu perfil do PowerShell e coloca um `yk-copilot.cmd` no PATH, porque
o `cmd.exe` não enxerga função de PowerShell.

```bash
yk-copilot on      # sobe a stack e aponta o Claude Code para os modelos locais
yk-copilot off     # volta para api.anthropic.com
yk-copilot status  # modo atual + saúde do Ollama e do proxy
yk-copilot test    # roda o smoke test
yk-copilot logs    # acompanha os logs do proxy
```

`on` e `off` gravam as variáveis de ambiente no escopo do usuário, então terminais novos já pegam a mudança. Os dois também atualizam o `settings.json` do VS Code — recarregue a janela depois.

## Mantenha seus MCP servers enxutos

Isso vai te pegar, e quando pega não parece um problema de contexto.

Cada definição de ferramenta de MCP é reenviada em toda requisição e é cobrada da janela de contexto antes do modelo ler sua pergunta. Medido aqui: as 27 ferramentas do próprio Claude Code comprimem para cerca de 5.700 tokens — mas com os MCP servers de um projeto real anexados, a mesma requisição carregou **95 ferramentas e 20.400 tokens**, enchendo uma janela de 24k inteira. O modelo respondeu com um texto confuso e nada funcionou, sem nenhum erro que explicasse o porquê.

Use um `.mcp.json` pequeno e específico da tarefa ao codar contra um modelo local:

```bash
claude --mcp-config .mcp.json --strict-mcp-config
```

O `--strict-mcp-config` faz o Claude Code ignorar seus servers globais e usar só esse arquivo. Tem um exemplo em [examples/mcp.json](examples/mcp.json).

O `ollos` combina bem com codar local: ele transcreve áudio e lê texto de screenshots e frames de vídeo, devolvendo texto — então nada mais precisa caber na VRAM ao lado do modelo de código.

## Ajuste fino

Tudo aqui fica no `.env` e é lido na inicialização.

| Variável | Padrão | O que faz |
|---|---|---|
| `NUM_CTX` | `24576` | Janela de contexto. O padrão do Ollama é 4096, que trunca em silêncio o prompt do Claude Code antes do modelo ver seu pedido. Não desça abaixo de 16384. |
| `TOOL_DESC_LIMIT` | `400` | Máximo de caracteres por descrição de ferramenta. Corta os schemas em ~75%. |
| `ARG_DESC_LIMIT` | `120` | Máximo de caracteres por descrição de parâmetro. |
| `SYSTEM_LIMIT` | `8000` | Máximo de caracteres do system prompt do host, mantendo o começo e o fim. Sem isso, um modelo 7B responde em prosa em vez de chamar a próxima ferramenta. |
| `SNAPSHOT_LIMIT` | `4000` | Máximo de caracteres de uma página web entregue ao modelo. |
| `BROWSER_TOOLS` | `0` | Oferece as ferramentas de busca Playwright do proxy. Desligado porque o Claude Code tem as dele, e oferecer as duas fez o modelo gastar seis turnos procurando na web uma função `flatten`. Ponha `1` se algo que não seja o Claude Code usar esta API. |
| `MODEL_FAST` | `qwen2.5:7b` | Requisições curtas, sem ferramentas. |
| `MODEL_SMART` | `qwen2.5:7b` | Tudo que o Claude Code manda. |
| `MODEL_VISION` | `gemma3:4b` | Descreve imagens para o modelo de código. |

Aumente `TOOL_DESC_LIMIT` e `SYSTEM_LIMIT` se o modelo usar uma ferramenta errado; baixe `NUM_CTX` para 16384 se faltar VRAM.

## Smoke test

```bash
node scripts/test.js --wait
```

Doze verificações: proxy, dashboard, modelos, streaming, tool calling, resultado de ferramenta em multi-turno, pipeline de visão, busca na web e um prompt de código de verdade. Rode antes de virar a chave — ele falha alto onde uma stack mal configurada falha em silêncio.

## O que esperar

Duas tarefas, mesma máquina, para calibrar:

- *"Edite calc.py para divide levantar ValueError quando b for zero"* — feito corretamente em 18s
- *"Adicione subtract, escreva testes unitários para as três funções, rode os testes"* — o 30B completou em **3,5 minutos**: função adicionada, quatro testes escritos, testes executados e passando, conferidos de forma independente depois. Um 7B falhou na mesma tarefa duas vezes, uma narrando sem agir e outra relatando uma execução de teste que nunca aconteceu.

Alguns minutos para algo que um modelo de fronteira faz em um é a troca real. Também não dispensa supervisão — confira se os arquivos mudaram em vez de confiar no resumo, porque a pior falha de um modelo local é relatar com confiança um trabalho que nunca fez. Mas roda com a rede desligada e não custa nada.

## Comandos

```bash
docker compose logs -f yk_copilot     # logs do proxy, com as estatísticas de compressão
docker compose ps                     # status dos containers
docker compose down                   # parar
ollama ps                             # o que está na VRAM, e se está na GPU ou CPU
```

---

Licença MIT, [YellowKode](https://yellowkode.com) + [Wunka Tech](https://wunka.tech)
