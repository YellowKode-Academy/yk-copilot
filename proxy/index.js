'use strict';
const express = require('express');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const OLLAMA      = process.env.OLLAMA_API_URL     || 'http://ollama:11434';
const PLAYWRIGHT  = process.env.PLAYWRIGHT_MCP_URL || 'http://yk_playwright:8931';
const MODEL_FAST  = process.env.MODEL_FAST         || 'qwen2.5-coder:7b';
const MODEL_SMART = process.env.MODEL_SMART        || 'qwen2.5-coder:14b';
const MODEL_VISION= process.env.MODEL_VISION       || 'gemma4:e4b';
const PORT        = Number(process.env.PROXY_PORT  || 9999);

// ─── Playwright MCP client ────────────────────────────────────────────────────

class PlaywrightClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.sessionId = null;
    this.reqId = 0;
    this.initialized = false;
  }

  async _post(body) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const r = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const sid = r.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;
    const text = await r.text();
    if (text.includes('\ndata:') || text.startsWith('data:')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (body.id !== undefined && d.id === body.id) return d;
          if (body.id === undefined) return d;
        } catch {}
      }
      return null;
    }
    try { return JSON.parse(text); } catch { return null; }
  }

  async init() {
    if (this.initialized) return;
    const id = ++this.reqId;
    await this._post({ jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'yk-copilot', version: '1.0.0' } } });
    fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    }).catch(() => {});
    this.initialized = true;
  }

  async tool(name, args = {}) {
    await this.init();
    const id = ++this.reqId;
    const resp = await this._post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    if (!resp) return '';
    if (resp.error) throw new Error(resp.error.message || JSON.stringify(resp.error));
    return (resp.result?.content || []).map(c => c.text || '').join('\n').trim();
  }

  async navigate(url) { await this.tool('browser_navigate', { url }); return this.snapshot(); }

  async snapshot() {
    const text = await this.tool('browser_snapshot', {});
    return text.length > 10000 ? text.slice(0, 10000) + '\n[... truncated ...]' : text;
  }
}

// ─── Vision: image extraction and Gemma 4 preprocessing ──────────────────────

function extractImages(messages) {
  const images = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === 'image' && c.source?.type === 'base64' && c.source.data) {
        images.push(c.source.data);
      }
    }
  }
  return images;
}

function stripImages(messages) {
  return messages.map(m => {
    if (!Array.isArray(m.content) || !m.content.some(c => c.type === 'image')) return m;
    const n = m.content.filter(c => c.type === 'image').length;
    const texts = m.content.filter(c => c.type === 'text');
    return { ...m, content: [...texts, { type: 'text', text: `[${n} image(s) — vision analysis injected above]` }] };
  });
}

async function describeImages(images, userContext) {
  if (!images.length) return null;
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_VISION,
        messages: [{
          role: 'user',
          content: `You are a vision assistant helping a coding AI. Analyze this image and describe precisely:\n- Any visible code, error messages, stack traces\n- UI layouts, components, design elements\n- Diagrams, architecture, flowcharts\n- Terminal output, file structures\n- Any text visible in the image\n- What the user likely wants help with\n\nBe technical and thorough.${userContext ? `\n\nUser context: "${userContext}"` : ''}`,
          images,
        }],
        stream: false,
        options: { num_predict: 1500 },
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.message?.content || null;
  } catch (e) {
    console.error('[vision]', e.message);
    return null;
  }
}

// ─── Web search via Playwright (100% local, no external API) ─────────────────

async function webSearch(query, pw) {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&kl=wt-wt`;
  try {
    return await pw.navigate(url);
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

// ─── Browser tools injected into every request ───────────────────────────────

const BROWSER_TOOL_NAMES = new Set(['web_search', 'browser_navigate', 'browser_snapshot']);

const BROWSER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for documentation, examples, packages, answers. Opens a real browser locally, no external API.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Open a URL in a real browser and return the full page content. Handles JavaScript-rendered pages.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL with https://' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Read the content of the currently open browser page.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ─── Structured planning system prompt ───────────────────────────────────────

const PLANNING_SYSTEM = `You are a precise, methodical coding assistant with web research and vision capabilities.

For every non-trivial task follow this process:
1. READ the full request carefully before any action
2. PLAN: write a numbered list of steps before executing anything
3. EXECUTE one step at a time, checking results before continuing
4. VERIFY: after each tool call, confirm the result matches expectations
5. ADJUST: if something fails, re-read the task, revise the plan, continue

Available research tools (all 100% local via Playwright, no external APIs):
- web_search(query): search the web by query, returns page content
- browser_navigate(url): open any URL in a real browser (handles JavaScript-rendered pages)
- browser_snapshot(): read the content of the currently open browser page

Code editing tools are provided by your environment (file read/write, bash, etc.).
Respond in the same language as the user. Be concise in explanations, thorough in execution.`;

// ─── Session store ────────────────────────────────────────────────────────────

const sessions = new Map();

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 400); i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function firstUserText(messages) {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const c = Array.isArray(m.content)
      ? m.content.filter(x => x.type === 'text').map(x => x.text).join(' ')
      : (m.content || '');
    if (c) return c.slice(0, 300);
  }
  return `anon_${Date.now()}`;
}

function getOrCreateSession(messages) {
  const key = simpleHash(firstUserText(messages));
  if (!sessions.has(key)) {
    sessions.set(key, { id: key, firstMsg: firstUserText(messages).slice(0, 120), startedAt: new Date().toISOString(), lastActivity: new Date().toISOString(), requests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, models: new Set() });
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
  return [...sessions.values()].map(s => ({ ...s, models: [...s.models] })).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

// ─── Model routing ────────────────────────────────────────────────────────────

function selectModel(body) {
  const msgs = body.messages || [];
  const hasTools       = (body.tools?.length || 0) > 0;
  const hasToolResults = msgs.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
  const totalLen = msgs.reduce((acc, m) => {
    const c = Array.isArray(m.content) ? m.content.map(x => x.text || '').join('') : (m.content || '');
    return acc + c.length;
  }, 0);
  // Always use the smart model when tools are involved — smaller models miss tool calls too often
  return (hasTools || hasToolResults || totalLen > 6000 || msgs.length > 10) ? MODEL_SMART : MODEL_FAST;
}

// ─── Format translation ───────────────────────────────────────────────────────

function extractSystem(body) {
  if (!body.system) return null;
  if (typeof body.system === 'string') return body.system;
  if (Array.isArray(body.system)) return body.system.map(s => s.text || s).join('\n');
  return null;
}

function toOllamaMessages(body) {
  const out = [];
  const envSystem = extractSystem(body);
  out.push({ role: 'system', content: [PLANNING_SYSTEM, envSystem].filter(Boolean).join('\n\n') });

  for (const msg of (body.messages || [])) {
    if (msg.role === 'system') continue;

    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
        const toolCalls = msg.content.filter(c => c.type === 'tool_use').map(c => ({ function: { name: c.name, arguments: c.input || {} } }));
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
            const content = Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('\n') : (typeof tr.content === 'string' ? tr.content : '');
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
  if (!tools?.length) return [];
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

// Fallback: some small models return tool calls as JSON text instead of tool_calls field.
// Supports: {"name":"x","arguments":{}} and {"name":"x","parameters":{}}
function tryParseTextToolCalls(text, knownNames) {
  const t = (text || '').trim();
  // Strip markdown code fences if present
  const stripped = t.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();
  try {
    const obj = JSON.parse(stripped);
    // Single call: {name, arguments|parameters|input}
    const name = obj.name || obj.function;
    const args = obj.arguments ?? obj.parameters ?? obj.input ?? {};
    if (typeof name === 'string' && knownNames.has(name)) {
      return [{ function: { name, arguments: args } }];
    }
    // Array of calls
    if (Array.isArray(obj)) {
      const parsed = obj
        .filter(o => typeof (o.name || o.function) === 'string' && knownNames.has(o.name || o.function))
        .map(o => ({ function: { name: o.name || o.function, arguments: o.arguments ?? o.parameters ?? o.input ?? {} } }));
      if (parsed.length) return parsed;
    }
  } catch {}
  return null;
}

function parseArgs(args) {
  if (typeof args === 'object' && args !== null) return args;
  try { return JSON.parse(args); } catch { return {}; }
}

function toolId() {
  return `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

function sseOpen(res, model) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  sse(res, 'message_start', { type: 'message_start', message: { id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', content: [], model, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  sse(res, 'ping', { type: 'ping' });
}

async function sseText(res, text, blockIndex) {
  sse(res, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < text.length; i += 8) {
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: text.slice(i, i + 8) } });
    if (i % 80 === 0) await new Promise(r => setTimeout(r, 5));
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
  return blockIndex + 1;
}

function sseToolUse(res, calls, blockIndex, outputTokens) {
  let idx = blockIndex;
  for (const tc of calls) {
    const id = toolId();
    const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id, name: tc.function.name, input: {} } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: args } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    idx++;
  }
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: outputTokens } });
  sse(res, 'message_stop', { type: 'message_stop' });
}

// ─── Core agent loop ──────────────────────────────────────────────────────────

async function runAgentLoop(body, res) {
  const stream  = body.stream !== false;
  const session = getOrCreateSession(body.messages || []);

  // ── Step 1: Vision preprocessing ──────────────────────────
  const rawImages = extractImages(body.messages || []);
  let visionDescription = null;

  if (rawImages.length) {
    console.log(`[vision] processing ${rawImages.length} image(s) with ${MODEL_VISION}...`);
    visionDescription = await describeImages(rawImages, firstUserText(body.messages));
    if (visionDescription) console.log(`[vision] description ready (${visionDescription.length} chars)`);
  }

  // Strip raw images from messages before sending to code model
  const cleanBody = visionDescription ? { ...body, messages: stripImages(body.messages) } : body;

  // ── Step 2: Select code model and build history ────────────
  const model       = selectModel(cleanBody);
  const claudeTools = toOllamaTools(cleanBody.tools);
  const allTools    = [...claudeTools, ...BROWSER_TOOLS];
  const history     = toOllamaMessages(cleanBody);

  // Inject vision description as context at the top of the conversation
  if (visionDescription) {
    // Insert after system message
    history.splice(1, 0,
      { role: 'user',      content: `[Vision Analysis by ${MODEL_VISION}]\n\n${visionDescription}` },
      { role: 'assistant', content: 'I have analyzed the image(s) and will use this context to help you.' }
    );
  }

  let totalInput = 0, totalOutput = 0, totalToolCalls = 0;

  if (stream) sseOpen(res, model);

  // ── Step 3: Code model agent loop ─────────────────────────
  for (let turn = 0; turn < 8; turn++) {
    let data;
    try {
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: history, tools: allTools, stream: false, options: { num_predict: body.max_tokens || 8192 } }),
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
      data = await r.json();
    } catch (e) {
      const errMsg = `\n\n❌ ${e.message}`;
      if (stream) { await sseText(res, errMsg, 0); sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }); sse(res, 'message_stop', { type: 'message_stop' }); res.end(); }
      else res.json({ id: `msg_err`, type: 'message', role: 'assistant', content: [{ type: 'text', text: errMsg }], model, stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } });
      updateSession(session, { inputTokens: totalInput, outputTokens: totalOutput, toolCalls: totalToolCalls, model: `${MODEL_VISION}+${model}` });
      return;
    }

    totalInput  += data.prompt_eval_count || 0;
    totalOutput += data.eval_count || 0;

    const msg = data.message || {};
    // Some smaller models embed tool calls as JSON in content instead of tool_calls field.
    // Detect and normalise so Claude Code always gets proper tool_use blocks.
    let calls = msg.tool_calls;
    if (!calls?.length && msg.content) {
      const knownNames = new Set(allTools.map(t => t.function.name));
      calls = tryParseTextToolCalls(msg.content, knownNames) || calls;
    }

    // No tool calls: final text response
    if (!calls?.length) {
      const text = msg.content || '';
      if (stream) {
        await sseText(res, text, 0);
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: totalOutput } });
        sse(res, 'message_stop', { type: 'message_stop' });
        res.end();
      } else {
        res.json({ id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }], model, stop_reason: 'end_turn', usage: { input_tokens: totalInput, output_tokens: totalOutput } });
      }
      break;
    }

    const browserCalls = calls.filter(tc => BROWSER_TOOL_NAMES.has(tc.function.name));
    const claudeCalls  = calls.filter(tc => !BROWSER_TOOL_NAMES.has(tc.function.name));

    // Only Claude Code tools: return to Claude Code to execute
    if (!browserCalls.length) {
      if (stream) {
        let idx = 0;
        if (msg.content) idx = await sseText(res, msg.content, idx);
        sseToolUse(res, claudeCalls, idx, totalOutput);
        res.end();
      } else {
        const content = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of claudeCalls) content.push({ type: 'tool_use', id: toolId(), name: tc.function.name, input: parseArgs(tc.function.arguments) });
        res.json({ id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', content, model, stop_reason: 'tool_use', usage: { input_tokens: totalInput, output_tokens: totalOutput } });
      }
      break;
    }

    // Browser tools: execute internally and loop back
    history.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    const pw = new PlaywrightClient(PLAYWRIGHT);

    for (const tc of calls) {
      const args = parseArgs(tc.function.arguments);
      let result = '';
      try {
        if      (tc.function.name === 'web_search')       result = await webSearch(args.query, pw);
        else if (tc.function.name === 'browser_navigate') result = await pw.navigate(args.url);
        else if (tc.function.name === 'browser_snapshot') result = await pw.snapshot();
        else result = `Tool ${tc.function.name} is handled by your environment.`;
      } catch (e) { result = `Error: ${e.message}`; }
      totalToolCalls++;
      history.push({ role: 'tool', content: result });
    }
  }

  const usedModels = visionDescription ? `${MODEL_VISION}+${model}` : model;
  updateSession(session, { inputTokens: totalInput, outputTokens: totalOutput, toolCalls: totalToolCalls, model: usedModels });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/v1/messages', async (req, res) => {
  try { await runAgentLoop(req.body, res); }
  catch (err) {
    console.error('[proxy]', err.message);
    if (!res.headersSent) res.status(500).json({ type: 'error', error: { type: 'api_error', message: err.message } });
  }
});

app.get('/v1/models', (_, res) => {
  res.json({ object: 'list', data: [
    { id: 'claude-sonnet-4-6', object: 'model', created: 0, owned_by: 'yk-copilot' },
    { id: MODEL_SMART,         object: 'model', created: 0, owned_by: 'ollama' },
    { id: MODEL_FAST,          object: 'model', created: 0, owned_by: 'ollama' },
    { id: MODEL_VISION,        object: 'model', created: 0, owned_by: 'ollama' },
  ]});
});

app.get('/api/sessions', (_, res) => res.json(serializeSessions()));

app.get('/api/stats', (_, res) => {
  const all = [...sessions.values()];
  res.json({
    totalSessions:     all.length,
    totalRequests:     all.reduce((s, x) => s + x.requests, 0),
    totalInputTokens:  all.reduce((s, x) => s + x.inputTokens, 0),
    totalOutputTokens: all.reduce((s, x) => s + x.outputTokens, 0),
    totalToolCalls:    all.reduce((s, x) => s + x.toolCalls, 0),
    modelFast:   MODEL_FAST,
    modelSmart:  MODEL_SMART,
    modelVision: MODEL_VISION,
  });
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  if (req.path.startsWith('/v1/') || req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`[yk-copilot] port=${PORT} fast=${MODEL_FAST} smart=${MODEL_SMART} vision=${MODEL_VISION} ollama=${OLLAMA}`)
);
