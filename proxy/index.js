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
// Claude Code's system prompt plus its tool definitions run well past 15k tokens.
// Ollama defaults to a 4096-token window and drops the rest in silence, so the model
// never sees the actual task. This has to be set explicitly or nothing works.
const NUM_CTX     = Number(process.env.NUM_CTX      || 32768);
// A local model on a laptop GPU is slow; a long ceiling costs nothing when idle.
const OLLAMA_TIMEOUT = Number(process.env.OLLAMA_TIMEOUT_MS || 900000);
// Claude Code's tool descriptions are written for a frontier model and are enormous:
// all of them together came to ~18k tokens in testing, which on a small context is
// the whole window before the user has said anything. A local model needs the name,
// the parameters and a sentence of intent — not the full manual. 0 disables.
const TOOL_DESC_LIMIT = Number(process.env.TOOL_DESC_LIMIT || 400);
const ARG_DESC_LIMIT  = Number(process.env.ARG_DESC_LIMIT  || 120);
// The host's system prompt is written for a frontier model: ~12k tokens of policy,
// style and harness detail. A 7B model given the whole thing reliably drops the task
// and answers in prose instead of calling the next tool — with the same prompt
// trimmed it calls the tool correctly. 0 disables the trimming.
const SYSTEM_LIMIT = Number(process.env.SYSTEM_LIMIT || 8000);
// How much of a web page to hand the model. Reading is the slow part locally.
const SNAPSHOT_LIMIT = Number(process.env.SNAPSHOT_LIMIT || 4000);
// The proxy's own Playwright-backed browser tools, off by default. Claude Code
// already has WebSearch and WebFetch, and offering a second near-identical set makes
// the model shop between them — asked for a plain `flatten` function it spent six
// turns trying to search the web for one. Set BROWSER_TOOLS=1 to offer them anyway,
// which is worth doing when something other than Claude Code calls this API.
const BROWSER_TOOLS_ENABLED = process.env.BROWSER_TOOLS === '1';
// Ceiling on what the tool schemas may take of the context, as a fraction of NUM_CTX.
// The VS Code extension loads every MCP server on the account without asking: measured
// here, 334 tools and ~69,000 tokens of schema against a 24,576-token window. That
// does not surface as a context error — the runner dies and the chat reports a
// dropped connection, which looks like a broken install.
const TOOL_BUDGET = Number(process.env.TOOL_BUDGET || 0.35);
// Comma-separated fragments of tool names to keep ahead of everything else, for when
// a particular MCP server matters more than the ranking would guess.
const TOOL_PRIORITY = (process.env.TOOL_PRIORITY || '')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
// Largest single tool result to keep verbatim. A directory listing or a page of logs
// can run to tens of thousands of characters and is mostly noise by the next turn.
const RESULT_LIMIT = Number(process.env.RESULT_LIMIT || 6000);
// A model that does not fit in VRAM lives partly in system RAM, and on a busy desktop
// the runner occasionally gets killed mid-request. Ollama reports that as a dropped
// TCP connection, then reloads the model on the next call — so the retry usually
// succeeds where the first attempt died.
const OLLAMA_RETRIES = Number(process.env.OLLAMA_RETRIES || 2);

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

  // A full page snapshot runs to tens of thousands of characters. A local model
  // spends longer reading that than the browser spent fetching it, so cap it low.
  async snapshot() {
    const text = await this.tool('browser_snapshot', {});
    return text.length > SNAPSHOT_LIMIT ? text.slice(0, SNAPSHOT_LIMIT) + '\n[... truncated ...]' : text;
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
        options: { num_ctx: 8192, num_predict: 1500 },
      }),
      signal: AbortSignal.timeout(180000),
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

// Same guidance, minus the research tools, for when they are not being offered.
// Advertising a tool the model does not have sends it looking for one.
const PLANNING_SYSTEM_NO_BROWSER = `You are a precise, methodical coding assistant.

For every non-trivial task follow this process:
1. READ the full request carefully before any action
2. PLAN: write a numbered list of steps before executing anything
3. EXECUTE one step at a time, checking results before continuing
4. VERIFY: after each tool call, confirm the result matches expectations
5. ADJUST: if something fails, re-read the task, revise the plan, continue

Answer from your own knowledge. You have no web access, so do not attempt to search
or browse — if you are unsure, write the best answer you can and say what you are
unsure about.

Respond in the same language as the user. Be concise in explanations, thorough in execution.`;

// ─── Session store ────────────────────────────────────────────────────────────

// The chat template already renders tool schemas, but a small model reading 15+ of
// them routinely invents a name close to the right one. A short, explicit roster of
// exact names and parameters costs little context and prevents most of that.
function toolRoster(tools) {
  if (!tools?.length) return '';
  const lines = tools.map(t => {
    const props = t.function.parameters?.properties || {};
    const req   = t.function.parameters?.required || [];
    const args  = Object.keys(props).map(k => (req.includes(k) ? k : k + '?')).join(', ');
    return `- ${t.function.name}(${args})`;
  });
  // Deliberately no instruction about output format here. A model with native tool
  // calling handles that itself, and telling it to emit JSON instead makes it treat
  // functions it reads in a source file as tools it is being offered.
  return `Tool names available to you, for reference. Use these exact names and exact parameter names, and never invent one:\n${lines.join('\n')}`;
}

// Small models habitually narrate an action instead of taking it — "Let me modify
// the function accordingly." — and then end the turn having changed nothing. Saying
// so plainly, right at the end of the system message, fixes most of it.
// Appended to the last message the model reads, where it carries the most weight.
// Short on purpose: a long reminder here gets skimmed like the rest.
const STEP_REMINDER = `[Call a tool now if the task is not finished. Do not write what you are going to do, and never write the output of a command you have not actually run.]`;

const EXEC_NOTE = `Act, do not announce. If a step needs a tool, call the tool in this same turn. Never end your turn describing what you are about to do — either do it now, or report what you actually did. Only answer in prose when the work is finished or you genuinely need the user to decide something.`;

const BROWSER_NOTE = `You also have three research tools provided by this proxy and run locally on this machine (no external API):
- web_search(query): search the web, returns page content
- browser_navigate(url): open any URL in a real browser (handles JavaScript-rendered pages)
- browser_snapshot(): read the currently open browser page
Use them whenever you need documentation or facts you do not already have.`;

const sessions = new Map();

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 400); i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The newest user message: the request being answered, as opposed to the one that
// opened the session.
function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const c = Array.isArray(m.content)
      ? m.content.filter(x => x.type === 'text').map(x => x.text).join(' ')
      : (m.content || '');
    if (c) return c.slice(0, 500);
  }
  return '';
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

// Keep the opening (identity and how to use tools) and the closing (working
// directory, platform, project instructions), and drop the middle, which is mostly
// policy a local model will not act on anyway.
function trimSystem(text) {
  if (!SYSTEM_LIMIT || !text || text.length <= SYSTEM_LIMIT) return text;
  const head = Math.floor(SYSTEM_LIMIT * 0.6);
  const tail = SYSTEM_LIMIT - head;
  return `${text.slice(0, head)}\n\n[...trimmed for a local model's context...]\n\n${text.slice(-tail)}`;
}

function toOllamaMessages(body, allTools) {
  const out = [];
  const rawSystem = extractSystem(body);
  // DEBUG_FIND=<text>: report where a string lands in the payload, to tell whether
  // something the host sent is being lost to trimming.
  if (process.env.DEBUG_FIND) {
    const needle = process.env.DEBUG_FIND;
    const inSys  = (rawSystem || '').includes(needle);
    const kept   = (trimSystem(rawSystem) || '').includes(needle);
    const inMsgs = JSON.stringify(body.messages || []).includes(needle);
    const inTools= JSON.stringify(body.tools || []).includes(needle);
    console.log(`[find] "${needle}" system=${inSys} (sobrevive ao corte=${kept}) mensagens=${inMsgs} tools=${inTools}`);
  }
  const envSystem = trimSystem(rawSystem);
  if (rawSystem && envSystem !== rawSystem) {
    console.log(`[system] host prompt ${Math.round(rawSystem.length / 1024)}KB -> ${Math.round(envSystem.length / 1024)}KB`);
  }
  // Claude Code ships a long system prompt of its own. Stacking a second full set of
  // instructions on top of it contradicts the host and burns context a small model
  // cannot spare, so when a host prompt is present we only add the browser-tool note.
  const preamble = rawSystem && rawSystem.length > 2000 ? '' : (BROWSER_TOOLS_ENABLED ? PLANNING_SYSTEM : PLANNING_SYSTEM_NO_BROWSER);
  const roster   = toolRoster(allTools);

  // tool_use id -> name, so every tool result can say which call it answers
  const toolNames = new Map();
  for (const m of (body.messages || [])) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) if (c.type === 'tool_use' && c.id) toolNames.set(c.id, c.name);
    }
  }
  out.push({ role: 'system', content: [preamble, envSystem, roster, EXEC_NOTE].filter(Boolean).join('\n\n') });

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
            // Small models lose track of which result answers which call without this
            out.push({
              role: 'tool',
              tool_name: toolNames.get(tr.tool_use_id) || 'tool',
              content: clip(content, RESULT_LIMIT),
            });
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

  // Every turn resends the whole conversation, so a long session eventually asks for
  // more than the window holds. Ollama does not report that: the runner dies and the
  // caller sees a dropped TCP connection. Drop the middle of the history instead,
  // keeping the opening (the task) and the recent turns (where the work is).
  const roomForHistory = Math.floor(NUM_CTX * (1 - TOOL_BUDGET) * 0.8) * 4;
  const weight = (m) => JSON.stringify(m).length;
  let historySize = out.reduce((n, m) => n + weight(m), 0);
  if (historySize > roomForHistory && out.length > 4) {
    const head = out.slice(0, 2);            // system, and the first user turn
    const tail = [];
    let used = head.reduce((n, m) => n + weight(m), 0);
    for (let i = out.length - 1; i >= 2; i--) {
      const w = weight(out[i]);
      if (used + w > roomForHistory && tail.length) break;
      tail.unshift(out[i]);
      used += w;
    }
    const cut = out.length - head.length - tail.length;
    if (cut > 0) {
      console.warn(`[history] conversation exceeded the window; dropped ${cut} middle message(s), kept ${head.length + tail.length}`);
      // A tool result must never arrive without the assistant turn that called it.
      while (tail.length && tail[0].role === 'tool') tail.shift();
      out.length = 0;
      out.push(...head, { role: 'user', content: '[...earlier turns omitted to fit the context window...]' }, ...tail);
    }
  }

  // A small model weights the end of the context far more than the middle, and the
  // system message is followed by thousands of tokens of host prompt and tool
  // schemas. On a task with several steps the directive there gets diluted and the
  // model starts writing what it would do — including inventing command output it
  // never ran. Repeating it as the last thing it reads is what holds the loop.
  if (allTools?.length && out.length > 1) {
    const last = out[out.length - 1];
    last.content = `${last.content || ''}\n\n${STEP_REMINDER}`;
  }

  return out;
}

// Cut at a sentence or line break where possible, so the text does not end mid-word.
function clip(text, limit) {
  if (!limit || !text || text.length <= limit) return text || '';
  const head = text.slice(0, limit);
  const cut  = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'));
  return (cut > limit * 0.5 ? head.slice(0, cut + 1) : head).trim();
}

function compactSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const props = {};
  for (const [k, v] of Object.entries(schema.properties || {})) {
    const p = { type: v.type || 'string' };
    if (v.description) p.description = clip(v.description, ARG_DESC_LIMIT);
    if (v.enum) p.enum = v.enum;
    if (v.items?.type) p.items = { type: v.items.type };
    props[k] = p;
  }
  const out = { type: 'object', properties: props };
  if (schema.required?.length) out.required = schema.required;
  return out;
}

function toOllamaTools(tools) {
  if (!tools?.length) return [];
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: clip(t.description || '', TOOL_DESC_LIMIT),
      parameters: compactSchema(t.input_schema),
    },
  }));
}

// When the schemas cannot fit, drop tools rather than let the request fail. The
// model's own file and shell tools are what make it able to code at all, so those go
// in first and MCP tools fill whatever room is left. Losing an MCP tool costs a
// capability; losing Edit costs everything.
// Words worth matching on: long enough to mean something, and not the filler that
// turns up in every request, in either language.
const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','have','what','when','which','there',
  'please','could','would','about','into','your','you','are','can','get','use','using',
  'para','que','como','uma','dos','das','por','com','mais','meu','minha','pode','fazer',
  'tenho','temos','quero','sobre','favor','entao','ultimos','estao','analisa','mesmo',
]);

function terms(text) {
  return new Set(
    (text || '').toLowerCase()
      .split(/[^a-z0-9\u00e0-\u00ff]+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
  );
}

// How well a tool matches what was asked. The name carries far more signal than the
// description, which is long and mostly shared boilerplate.
function relevance(tool, wanted) {
  if (!wanted.size) return 0;
  const name = tool.function.name.toLowerCase();
  const desc = (tool.function.description || '').toLowerCase().slice(0, 300);
  let score = 0;
  for (const w of wanted) {
    if (name.includes(w)) { score += 10; continue; }
    // Tool names are English; the request often is not. A shared prefix catches the
    // cognates that carry most of the signal here — transcrever/transcribe,
    // audio/audio, imagem/image — without pretending to be translation.
    const stem = w.slice(0, 6);
    if (stem.length >= 5 && name.includes(stem)) { score += 6; continue; }
    if (desc.includes(w)) score += 1;
  }
  return score;
}

// Which tier a tool belongs to. Lower sorts first.
//
// Tier 0 — the model's own file and shell tools. Losing an MCP tool costs one
//   capability; losing Edit costs the ability to code at all.
// Tier 1 — anything named in TOOL_PRIORITY, for when you want a specific server kept.
// Tier 2 — MCP servers from the project's own .mcp.json. You put them there on
//   purpose, so they outrank the rest.
// Tier 3 — connectors attached to the claude.ai account. The VS Code extension loads
//   all of them whether or not the project asked for any, and they are what blows
//   past the budget in the first place.
function toolTier(name) {
  if (!name.startsWith('mcp__')) return 0;
  const lower = name.toLowerCase();
  if (TOOL_PRIORITY.some(p => lower.includes(p))) return 1;
  if (lower.startsWith('mcp__claude_ai_')) return 3;
  return 2;
}

// When the schemas cannot fit, drop tools rather than let the request fail. Within a
// tier, tools compete on how well they match the request: ask about Instagram posts
// and the Instagram tools get the room, instead of whichever happened to be listed
// first.
function fitToolBudget(tools, askedFor) {
  const budget = Math.floor(NUM_CTX * TOOL_BUDGET) * 4;   // ~4 chars per token
  const size = (t) => JSON.stringify(t).length;
  const total = tools.reduce((n, t) => n + size(t), 0);
  if (total <= budget) return { tools, dropped: 0, total, ranked: false, byTier: null };

  const wanted = terms(askedFor);
  const ordered = tools
    .map(t => ({ t, tier: toolTier(t.function.name), score: relevance(t, wanted) }))
    .sort((a, b) => a.tier - b.tier || b.score - a.score);

  const kept = [];
  let used = 0;
  for (const { t } of ordered) {
    const n = size(t);
    if (used + n > budget && kept.length) continue;
    kept.push(t);
    used += n;
  }

  const byTier = [0, 0, 0, 0];
  for (const t of kept) byTier[toolTier(t.function.name)]++;
  return { tools: kept, dropped: tools.length - kept.length, total: used, ranked: wanted.size > 0, byTier };
}

// Small models frequently narrate a tool call as text instead of using the native
// tool_calls field. qwen2.5-coder never uses the native field at all. So the text has
// to be mined for calls, tolerating <tool_call> tags, code fences, JSON embedded in
// prose, and the several argument key names different models settle on.
function extractJsonObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const open = text[i], close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { out.push(JSON.parse(text.slice(i, j + 1))); } catch {}
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

// Models get the tool name almost right ("read_file", "ReadFile" for "Read"). Match
// on a normalised form, then on prefix, before giving up.
function resolveToolName(raw, knownNames) {
  if (typeof raw !== 'string' || !raw) return null;
  if (knownNames.has(raw)) return raw;
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(raw);
  for (const k of knownNames) if (norm(k) === n) return k;
  let best = null;
  for (const k of knownNames) {
    const nk = norm(k);
    if (nk.length < 3) continue;
    if (n === nk || n.startsWith(nk) || nk.startsWith(n)) {
      if (!best || nk.length > norm(best).length) best = k;
    }
  }
  return best;
}

// Qwen3-Coder falls back to an XML-ish form of its own rather than JSON:
//   <function=Edit><parameter=file_path>calc.py</parameter>...</function>
// It uses the native tool_calls field most of the time, but not always, and a missed
// call here reads to the user as the model refusing to act.
function parseXmlToolCalls(text, knownNames) {
  const calls = [];
  for (const m of text.matchAll(/<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/gi)) {
    const name = resolveToolName(m[1].trim(), knownNames);
    if (!name) continue;
    const args = {};
    for (const p of m[2].matchAll(/<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gi)) {
      args[p[1].trim()] = p[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    }
    calls.push({ function: { name, arguments: args } });
  }
  return calls.length ? calls : null;
}

function tryParseTextToolCalls(text, knownNames) {
  let t = (text || '').trim();
  if (!t) return null;

  const xml = parseXmlToolCalls(t, knownNames);
  if (xml) return xml;

  // <tool_call>{...}</tool_call>, the Qwen/Hermes convention
  const tagged = [...t.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)].map(m => m[1]);
  if (tagged.length) t = tagged.join('\n');

  // Strip code fences
  t = t.replace(/```(?:json|tool_code)?\s*/gi, '').replace(/```/g, '');

  const calls = [];
  for (const obj of extractJsonObjects(t)) {
    for (const cand of Array.isArray(obj) ? obj : [obj]) {
      if (!cand || typeof cand !== 'object') continue;
      const rawName = cand.name || cand.tool || cand.tool_name || cand.function;
      const name = resolveToolName(typeof rawName === 'object' ? rawName?.name : rawName, knownNames);
      if (!name) continue;
      const args = cand.arguments ?? cand.parameters ?? cand.input ?? cand.args ?? cand.function?.arguments ?? {};
      calls.push({ function: { name, arguments: args } });
    }
  }
  return calls.length ? calls : null;
}

function parseArgs(args) {
  if (typeof args === 'object' && args !== null) return args;
  try { return JSON.parse(args); } catch { return {}; }
}

// Each pass of the agent loop appends its own text block. Clients commonly read only
// the first one, so collapse runs of text into a single block.
function mergeText(parts) {
  if (!parts.length) return [{ type: 'text', text: '' }];
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (p.type === 'text' && prev?.type === 'text') prev.text += (prev.text ? '\n\n' : '') + p.text;
    else out.push({ ...p });
  }
  return out;
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

// ─── Ollama call (real streaming) ────────────────────────────────────────────

// Streams from Ollama and reports text as it arrives. Returning only at the end
// would leave Claude Code staring at a blank screen for minutes on a local model.
// True for the failures that come from the runner dying rather than from a bad
// request: retrying those is worth it, retrying a malformed request is not.
function isTransient(err) {
  const m = String(err && err.message || err);
  return /forcibly closed|ECONNRESET|socket hang up|EPIPE|fetch failed|terminated|500/i.test(m);
}

async function ollamaChat(opts) {
  let lastErr;
  for (let attempt = 0; attempt <= OLLAMA_RETRIES; attempt++) {
    try {
      return await ollamaChatOnce(opts);
    } catch (e) {
      lastErr = e;
      if (attempt === OLLAMA_RETRIES || !isTransient(e)) break;
      // Give Ollama a moment to reload the model it just lost.
      const wait = 2000 * (attempt + 1);
      console.warn(`[ollama] ${e.message.slice(0, 120)} — retrying in ${wait / 1000}s (${attempt + 1}/${OLLAMA_RETRIES})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function ollamaChatOnce({ model, history, tools, maxTokens, onText }) {
  // What actually goes to Ollama, so a failure can be tied to a size rather than guessed at.
  const payloadChars = JSON.stringify(history).length + JSON.stringify(tools || []).length;
  console.log(`[send] ${history.length} msgs + ${(tools || []).length} tools = ${Math.round(payloadChars / 1024)}KB (~${Math.round(payloadChars / 4)} tokens) of ${NUM_CTX}`);
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: history,
      tools,
      stream: true,
      options: { num_ctx: NUM_CTX, num_predict: Math.min(maxTokens || 8192, 16384) },
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', content = '', promptEval = 0, evalCount = 0;
  const toolCalls = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let d;
      try { d = JSON.parse(t); } catch { continue; }
      if (d.error) throw new Error(String(d.error));
      const piece = d.message?.content || '';
      if (piece) { content += piece; if (onText) onText(piece, content); }
      if (d.message?.tool_calls?.length) toolCalls.push(...d.message.tool_calls);
      if (d.done) { promptEval = d.prompt_eval_count || 0; evalCount = d.eval_count || 0; }
    }
  }
  return { content, toolCalls, promptEval, evalCount };
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

  // Always strip raw images from messages before sending to the code model
  const cleanMessages = rawImages.length ? stripImages(body.messages) : body.messages;
  const cleanBody = { ...body, messages: cleanMessages };

  // If vision failed, inject a fallback note so the model knows images existed
  const visionContext = rawImages.length && !visionDescription
    ? `[Note: ${rawImages.length} image(s) were attached but the vision model could not process them.]`
    : null;

  // ── Step 2: Select code model and build history ────────────
  const model       = selectModel(cleanBody);
  const claudeTools = toOllamaTools(cleanBody.tools);
  const offered     = BROWSER_TOOLS_ENABLED ? [...claudeTools, ...BROWSER_TOOLS] : claudeTools;
  // Rank against the newest user message — that is the request being answered now.
  const budgeted    = fitToolBudget(offered, lastUserText(cleanBody.messages));
  const allTools    = budgeted.tools;
  if (budgeted.dropped) {
    console.warn(`[tools] ${offered.length} offered exceeds the budget; kept ${allTools.length} [core ${budgeted.byTier[0]}, priority ${budgeted.byTier[1]}, project-mcp ${budgeted.byTier[2]}, account-mcp ${budgeted.byTier[3]}]${budgeted.ranked ? ', ranked by relevance' : ''}; dropped ${budgeted.dropped}.`);
  }
  const knownNames  = new Set(allTools.map(t => t.function.name));
  const history     = toOllamaMessages(cleanBody, allTools);

  if (claudeTools.length) {
    const before = JSON.stringify(cleanBody.tools).length;
    const after  = JSON.stringify(allTools).length;
    console.log(`[tools] ${cleanBody.tools.length} offered -> ${allTools.length} sent, schema ${Math.round(before / 1024)}KB -> ${Math.round(after / 1024)}KB (~${Math.round(after / 4)} tokens)`);
    // DEBUG_TOOLS=1 prints which tools survived, in the order they were ranked.
    if (process.env.DEBUG_TOOLS === '1') {
      console.log('[tools] kept: ' + allTools.map(t => t.function.name).join(', '));
    }
  }

  const visionInject = visionDescription
    ? `[Vision Analysis by ${MODEL_VISION}]\n\n${visionDescription}`
    : visionContext;
  if (visionInject) {
    history.splice(1, 0,
      { role: 'user',      content: visionInject },
      { role: 'assistant', content: visionDescription ? 'I have analyzed the image(s) and will use this context.' : 'Understood, I will proceed without the image content.' }
    );
  }

  let totalInput = 0, totalOutput = 0, totalToolCalls = 0;
  let blockIndex = 0, textOpen = false;
  const parts = [];   // assembled response, non-streaming path

  const openText  = () => {
    if (textOpen) return;
    sse(res, 'content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
    textOpen = true;
  };
  const deltaText = (t) => {
    if (!t) return;
    openText();
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: t } });
  };
  const closeText = () => {
    if (!textOpen) return;
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
    textOpen = false;
  };
  const finish = (stopReason) => {
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: totalOutput } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  };
  const done = () => updateSession(session, {
    inputTokens: totalInput, outputTokens: totalOutput, toolCalls: totalToolCalls,
    model: visionDescription ? `${MODEL_VISION}+${model}` : model,
  });

  if (stream) sseOpen(res, model);

  // ── Step 3: Code model agent loop ─────────────────────────
  for (let turn = 0; turn < 8; turn++) {
    // A model may narrate a tool call as text rather than use the native field: bare
    // JSON, <tool_call>, or Qwen3-Coder's <function=Name>. None of that should reach
    // the user, and it cannot be taken back once streamed. So a reply that opens like
    // a call is held entirely, and one that starts as prose is streamed only up to
    // the point a call marker appears.
    let gate = null;   // null = undecided, 'hold' | 'pass'
    let held = '';
    let emitted = 0;   // chars of `full` already sent, in 'pass' mode

    const CALL_MARKER = /<function=|<tool_call>/i;

    const onText = (piece, full) => {
      if (!stream) return;
      // A retry restarts the stream from nothing, so forget what the failed attempt sent.
      if (full.length < emitted) { emitted = 0; gate = null; held = ''; }
      if (gate === null) {
        const t = full.trimStart();
        if (!t) return;
        gate = /^[`{[<]/.test(t) ? 'hold' : 'pass';
        if (gate === 'hold') { held = full; return; }
      }
      if (gate === 'hold') { held += piece; return; }

      // Prose so far — send only what precedes any tool-call marker.
      const at = full.search(CALL_MARKER);
      const safeEnd = at === -1 ? full.length : at;
      if (safeEnd > emitted) {
        deltaText(full.slice(emitted, safeEnd));
        emitted = safeEnd;
      }
    };

    let result;
    try {
      result = await ollamaChat({ model, history, tools: allTools, maxTokens: cleanBody.max_tokens, onText });
    } catch (e) {
      const errMsg = `\n\n❌ ${e.message}`;
      console.error('[ollama]', e.message);
      if (stream) { deltaText(errMsg); closeText(); finish('end_turn'); }
      else res.json({ id: 'msg_err', type: 'message', role: 'assistant', content: [{ type: 'text', text: errMsg }], model, stop_reason: 'end_turn', usage: { input_tokens: totalInput, output_tokens: totalOutput } });
      done();
      return;
    }

    totalInput  += result.promptEval;
    totalOutput += result.evalCount;

    let calls = result.toolCalls;
    let callsFromText = false;
    if (!calls?.length && result.content) {
      const parsed = tryParseTextToolCalls(result.content, knownNames);
      if (parsed) { calls = parsed; callsFromText = true; }
    }

    // What we held back was prose after all, not a tool call — release it
    if (stream && gate === 'hold' && !callsFromText) { deltaText(held); held = ''; }
    if (!callsFromText && result.content) parts.push({ type: 'text', text: result.content });

    // No tool calls: this is the final answer
    if (!calls?.length) {
      if (stream) { closeText(); finish('end_turn'); }
      else res.json({ id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', content: mergeText(parts), model, stop_reason: 'end_turn', usage: { input_tokens: totalInput, output_tokens: totalOutput } });
      break;
    }

    const browserCalls = calls.filter(tc => BROWSER_TOOL_NAMES.has(tc.function.name));
    const claudeCalls  = calls.filter(tc => !BROWSER_TOOL_NAMES.has(tc.function.name));

    // Only Claude Code tools: hand them back for Claude Code to execute
    if (!browserCalls.length) {
      if (stream) {
        closeText();
        sseToolUse(res, claudeCalls, blockIndex, totalOutput);
        res.end();
      } else {
        for (const tc of claudeCalls) parts.push({ type: 'tool_use', id: toolId(), name: tc.function.name, input: parseArgs(tc.function.arguments) });
        res.json({ id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', content: mergeText(parts), model, stop_reason: 'tool_use', usage: { input_tokens: totalInput, output_tokens: totalOutput } });
      }
      break;
    }

    // Browser tools: run them here and loop back
    if (stream) closeText();
    history.push({ role: 'assistant', content: result.content || '', tool_calls: calls });
    const pw = new PlaywrightClient(PLAYWRIGHT);

    for (const tc of calls) {
      const args = parseArgs(tc.function.arguments);
      let out = '';
      try {
        if      (tc.function.name === 'web_search')       out = await webSearch(args.query, pw);
        else if (tc.function.name === 'browser_navigate') out = await pw.navigate(args.url);
        else if (tc.function.name === 'browser_snapshot') out = await pw.snapshot();
        else out = `Tool ${tc.function.name} is handled by your environment.`;
      } catch (e) { out = `Error: ${e.message}`; }
      totalToolCalls++;
      history.push({ role: 'tool', tool_name: tc.function.name, content: out });
    }
  }

  done();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/v1/messages', async (req, res) => {
  try { await runAgentLoop(req.body, res); }
  catch (err) {
    console.error('[proxy]', err.message);
    if (!res.headersSent) res.status(500).json({ type: 'error', error: { type: 'api_error', message: err.message } });
  }
});

// Rough token estimate. Claude Code calls this to size the context window; an
// approximation from character count is close enough and costs no inference.
app.post('/v1/messages/count_tokens', (req, res) => {
  const b = req.body || {};
  let chars = (extractSystem(b) || '').length;
  for (const m of (b.messages || [])) {
    if (!Array.isArray(m.content)) { chars += String(m.content || '').length; continue; }
    for (const c of m.content) {
      if      (c.type === 'text')        chars += (c.text || '').length;
      else if (c.type === 'tool_result') chars += JSON.stringify(c.content || '').length;
      else if (c.type === 'tool_use')    chars += JSON.stringify(c.input || {}).length;
      else if (c.type === 'image')       chars += 6000;   // stand-in for image tokens
    }
  }
  for (const t of (b.tools || [])) chars += JSON.stringify(t).length;
  res.json({ input_tokens: Math.ceil(chars / 4) });
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

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[yk-copilot] port=${PORT} ctx=${NUM_CTX} fast=${MODEL_FAST} smart=${MODEL_SMART} vision=${MODEL_VISION}`);
  console.log(`[yk-copilot] ollama=${OLLAMA}`);
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const names = (await r.json()).models?.map(m => m.name) || [];
    console.log(`[yk-copilot] ollama OK, ${names.length} model(s): ${names.join(', ')}`);
    for (const need of [MODEL_FAST, MODEL_SMART, MODEL_VISION]) {
      if (!names.includes(need)) console.warn(`[yk-copilot] WARNING: model not pulled: ${need}`);
    }
  } catch (e) {
    console.error(`[yk-copilot] WARNING: cannot reach Ollama at ${OLLAMA} (${e.message})`);
  }
});
