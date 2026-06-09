'use strict';
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const OLLAMA     = process.env.OLLAMA_API_URL || 'http://ollama:11434';
const MODEL_FAST = process.env.MODEL_FAST     || 'qwen2.5-coder:7b';
const MODEL_SMART= process.env.MODEL_SMART    || 'qwen2.5-coder:14b';
const PORT       = Number(process.env.PROXY_PORT || 9999);

// ─── Session store ────────────────────────────────────────────────────────────

const sessions = new Map();

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 400); i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function firstUserText(messages) {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.slice(0, 300);
    if (Array.isArray(m.content)) {
      const t = m.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
      if (t) return t.slice(0, 300);
    }
  }
  return `anon_${Date.now()}`;
}

function getOrCreateSession(messages) {
  const key = simpleHash(firstUserText(messages));
  if (!sessions.has(key)) {
    sessions.set(key, {
      id: key,
      firstMsg: firstUserText(messages).slice(0, 120),
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      models: new Set(),
    });
  }
  return sessions.get(key);
}

function updateSession(session, { inputTokens, outputTokens, toolCalls, model }) {
  session.requests++;
  session.inputTokens  += inputTokens;
  session.outputTokens += outputTokens;
  session.toolCalls    += toolCalls;
  session.lastActivity  = new Date().toISOString();
  if (model) session.models.add(model);
}

function serializeSessions() {
  return [...sessions.values()]
    .map(s => ({ ...s, models: [...s.models] }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

// ─── Model routing ────────────────────────────────────────────────────────────

function selectModel(body) {
  const msgs = body.messages || [];
  const hasToolResults = msgs.some(m =>
    Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')
  );
  const totalLen = msgs.reduce((acc, m) => {
    const c = Array.isArray(m.content) ? m.content.map(x => x.text || '').join('') : (m.content || '');
    return acc + c.length;
  }, 0);
  return (hasToolResults || totalLen > 6000 || msgs.length > 10) ? MODEL_SMART : MODEL_FAST;
}

// ─── Format translation: Anthropic → Ollama ──────────────────────────────────

function extractSystem(body) {
  if (!body.system) return null;
  if (typeof body.system === 'string') return body.system;
  if (Array.isArray(body.system)) return body.system.map(s => s.text || s).join('\n');
  return null;
}

function toOllamaMessages(body) {
  const out = [];
  const sys = extractSystem(body);
  if (sys) {
    out.push({
      role: 'system',
      content: sys + '\n\nBefore each response, briefly plan your approach before acting.',
    });
  }

  for (const msg of (body.messages || [])) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : '' });
      continue;
    }

    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
        const toolCalls = msg.content
          .filter(c => c.type === 'tool_use')
          .map(c => ({ function: { name: c.name, arguments: c.input || {} } }));
        const entry = { role: 'assistant', content: text };
        if (toolCalls.length) entry.tool_calls = toolCalls;
        out.push(entry);
      } else {
        out.push({ role: 'assistant', content: msg.content || '' });
      }
      continue;
    }

    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(c => c.type === 'tool_result');
        if (toolResults.length) {
          for (const tr of toolResults) {
            const content = Array.isArray(tr.content)
              ? tr.content.map(c => c.text || '').join('\n')
              : (typeof tr.content === 'string' ? tr.content : '');
            out.push({ role: 'tool', content });
          }
          continue;
        }
        const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (text) out.push({ role: 'user', content: text });
      } else {
        out.push({ role: 'user', content: msg.content || '' });
      }
    }
  }

  return out;
}

function toOllamaTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function parseArgs(args) {
  if (typeof args === 'object' && args !== null) return args;
  try { return JSON.parse(args); } catch { return {}; }
}

function toolId() {
  return `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Streaming: Ollama NDJSON → Anthropic SSE ────────────────────────────────

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleStream(ollamaBody, res, model) {
  const msgId = `msg_${Date.now().toString(36)}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  sse(res, 'message_start', {
    type: 'message_start',
    message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  sse(res, 'ping', { type: 'ping' });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

  let ollamaRes;
  try {
    ollamaRes = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ollamaBody, stream: true }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `\n\n❌ Cannot reach Ollama: ${e.message}` } });
    sse(res, 'content_block_stop',  { type: 'content_block_stop',  index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
    sse(res, 'message_stop',  { type: 'message_stop' });
    return { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  }

  const reader  = ollamaRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', blockIndex = 0, inputTokens = 0, outputTokens = 0, calls = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try { chunk = JSON.parse(line); } catch { continue; }

      if (!chunk.done && chunk.message?.content) {
        sse(res, 'content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'text_delta', text: chunk.message.content },
        });
      }
      if (chunk.done) {
        if (chunk.message?.tool_calls?.length) calls = chunk.message.tool_calls;
        inputTokens  = chunk.prompt_eval_count || 0;
        outputTokens = chunk.eval_count || 0;
      }
    }
  }

  sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
  blockIndex++;

  if (calls?.length) {
    for (const tc of calls) {
      const id = toolId();
      const argsStr = typeof tc.function.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc.function.arguments);
      sse(res, 'content_block_start', {
        type: 'content_block_start', index: blockIndex,
        content_block: { type: 'tool_use', id, name: tc.function.name, input: {} },
      });
      sse(res, 'content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: argsStr },
      });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex++;
    }
  }

  const stopReason = calls?.length ? 'tool_use' : 'end_turn';
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } });
  sse(res, 'message_stop',  { type: 'message_stop' });

  return { inputTokens, outputTokens, toolCalls: calls?.length || 0 };
}

// ─── Non-streaming ────────────────────────────────────────────────────────────

async function handleNonStream(ollamaBody, res, model) {
  const ollamaRes = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...ollamaBody, stream: false }),
    signal: AbortSignal.timeout(180000),
  });
  if (!ollamaRes.ok) throw new Error(`Ollama ${ollamaRes.status}: ${await ollamaRes.text()}`);

  const data = await ollamaRes.json();
  const msg  = data.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of (msg.tool_calls || [])) {
    content.push({ type: 'tool_use', id: toolId(), name: tc.function.name, input: parseArgs(tc.function.arguments) });
  }

  const inputTokens  = data.prompt_eval_count || 0;
  const outputTokens = data.eval_count || 0;

  res.json({
    id: `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: msg.tool_calls?.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });

  return { inputTokens, outputTokens, toolCalls: msg.tool_calls?.length || 0 };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/v1/messages', async (req, res) => {
  const body    = req.body;
  const model   = selectModel(body);
  const session = getOrCreateSession(body.messages || []);

  const ollamaBody = {
    model,
    messages: toOllamaMessages(body),
    options:  { num_predict: body.max_tokens || 8192 },
  };
  const tools = toOllamaTools(body.tools);
  if (tools) ollamaBody.tools = tools;

  try {
    let result;
    if (body.stream !== false) {
      result = await handleStream(ollamaBody, res, model);
      res.end();
    } else {
      result = await handleNonStream(ollamaBody, res, model);
    }
    updateSession(session, { ...result, model });
  } catch (err) {
    console.error('[proxy]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: err.message } });
    }
  }
});

// Claude Code queries this to validate the connection
app.get('/v1/models', (_, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'claude-sonnet-4-6', object: 'model', created: 0, owned_by: 'yk-copilot' },
      { id: MODEL_SMART,         object: 'model', created: 0, owned_by: 'ollama' },
      { id: MODEL_FAST,          object: 'model', created: 0, owned_by: 'ollama' },
    ],
  });
});

// ─── Dashboard API ────────────────────────────────────────────────────────────

app.get('/api/sessions', (_, res) => res.json(serializeSessions()));

app.get('/api/stats', (_, res) => {
  const all = [...sessions.values()];
  res.json({
    totalSessions:     all.length,
    totalRequests:     all.reduce((s, x) => s + x.requests,     0),
    totalInputTokens:  all.reduce((s, x) => s + x.inputTokens,  0),
    totalOutputTokens: all.reduce((s, x) => s + x.outputTokens, 0),
    totalToolCalls:    all.reduce((s, x) => s + x.toolCalls,    0),
    modelFast:  MODEL_FAST,
    modelSmart: MODEL_SMART,
  });
});

app.get('/health', (_, res) => res.json({ ok: true }));

// ─── Dashboard SPA ────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  if (req.path.startsWith('/v1/') || req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`[yk-copilot] port=${PORT} fast=${MODEL_FAST} smart=${MODEL_SMART} ollama=${OLLAMA}`)
);
