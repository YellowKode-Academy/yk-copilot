#!/usr/bin/env node
// Smoke test — run after `docker compose up` to verify everything works
// Usage:
//   node scripts/test.js
//   node scripts/test.js --url http://localhost:9999
//   node scripts/test.js --wait   (waits up to 120s for proxy to be ready)

const BASE = (() => {
  const i = process.argv.indexOf('--url');
  return i !== -1 ? process.argv[i + 1] : (process.env.YK_URL || 'http://localhost:9999');
})();
const WAIT = process.argv.includes('--wait');

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';

let passed = 0, failed = 0;

function ok(label)        { console.log(`  ${GREEN}✔${RESET} ${label}`); passed++; }
function fail(label, detail) { console.log(`  ${RED}✘${RESET} ${label}`); if (detail) console.log(`    ${RED}${detail}${RESET}`); failed++; }
function info(msg)        { console.log(`  ${YELLOW}•${RESET} ${msg}`); }

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function waitForProxy(maxMs = 120000) {
  const start = Date.now();
  process.stdout.write(`  Waiting for proxy at ${BASE}`);
  while (Date.now() - start < maxMs) {
    try {
      await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      process.stdout.write(` ready\n`);
      return true;
    } catch {
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  process.stdout.write(' timeout\n');
  return false;
}

async function sendMessage({ messages, tools, stream = false }) {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'ollama', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 256, stream, messages, tools }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);

  if (!stream) {
    return await r.json();
  }

  // Parse SSE stream into a synthetic message object
  const text = await r.text();
  const contentBlocks = [];
  let stopReason = 'end_turn';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const d = JSON.parse(line.slice(5).trim());
      if (d.delta?.text)          contentBlocks.push({ type: 'text', text: d.delta.text });
      if (d.delta?.stop_reason)   stopReason = d.delta.stop_reason;
      if (d.content_block?.type === 'tool_use') contentBlocks.push({ ...d.content_block, input: '' });
      if (d.delta?.partial_json !== undefined) {
        const last = contentBlocks[contentBlocks.length - 1];
        if (last?.type === 'tool_use') last.input += d.delta.partial_json;
      }
    } catch {}
  }
  // Parse tool_use inputs
  for (const b of contentBlocks) {
    if (b.type === 'tool_use' && typeof b.input === 'string') {
      try { b.input = JSON.parse(b.input); } catch { b.input = {}; }
    }
  }
  return { content: contentBlocks, stop_reason: stopReason };
}

async function run() {
  console.log(`\n${BOLD}yk-copilot smoke test${RESET}  ${YELLOW}${BASE}${RESET}\n`);

  if (WAIT) {
    const ready = await waitForProxy();
    if (!ready) { fail('Proxy never became ready in 120s'); process.exit(1); }
  }

  // ── 1. Health ─────────────────────────────────────────────────────────────
  console.log(`${BOLD}1. Proxy${RESET}`);
  try {
    const h = await get('/health');
    if (h.ok) ok('GET /health → { ok: true }');
    else      fail('GET /health returned ok=false');
  } catch (e) { fail('GET /health', e.message); }

  // ── 2. Dashboard API ──────────────────────────────────────────────────────
  console.log(`\n${BOLD}2. Dashboard API${RESET}`);
  try {
    const s = await get('/api/stats');
    ok(`GET /api/stats → fast=${s.modelFast}  smart=${s.modelSmart}  vision=${s.modelVision}`);
  } catch (e) { fail('GET /api/stats', e.message); }
  try {
    await get('/api/sessions');
    ok('GET /api/sessions → OK');
  } catch (e) { fail('GET /api/sessions', e.message); }

  // ── 3. Models list ────────────────────────────────────────────────────────
  console.log(`\n${BOLD}3. Models endpoint${RESET}`);
  try {
    const m = await get('/v1/models');
    const ids = m.data?.map(x => x.id) || [];
    ok(`GET /v1/models → ${ids.join(', ')}`);
  } catch (e) { fail('GET /v1/models', e.message); }

  // ── 4. Non-streaming message ──────────────────────────────────────────────
  console.log(`\n${BOLD}4. Message pipeline (non-streaming)${RESET}`);
  info('First call may take 30-60s while Ollama loads the model...');
  let nonStreamOk = false;
  try {
    const msg = await sendMessage({ messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }] });
    const text = msg.content?.find(c => c.type === 'text')?.text?.trim() || '';
    if (text) { ok(`POST /v1/messages → "${text}"`); nonStreamOk = true; }
    else       fail('POST /v1/messages', 'Empty response');
  } catch (e) { fail('POST /v1/messages (non-stream)', e.message); }

  // ── 5. Streaming message ──────────────────────────────────────────────────
  console.log(`\n${BOLD}5. Message pipeline (streaming SSE)${RESET}`);
  try {
    const msg = await sendMessage({ messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }], stream: true });
    const text = msg.content?.filter(c => c.type === 'text').map(c => c.text).join('').trim() || '';
    if (text) ok(`POST /v1/messages stream=true → "${text}"`);
    else      fail('POST /v1/messages stream=true', 'Empty SSE response');
  } catch (e) { fail('POST /v1/messages (stream)', e.message); }

  // ── 6. Tool calling roundtrip ─────────────────────────────────────────────
  console.log(`\n${BOLD}6. Tool calling (Anthropic format → Ollama → back)${RESET}`);
  info('Sending request with a tool definition...');
  try {
    const tools = [{
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }];
    const messages = [{ role: 'user', content: 'What is the weather in São Paulo? Use the get_weather tool.' }];
    const msg = await sendMessage({ messages, tools });
    const toolCall = msg.content?.find(c => c.type === 'tool_use');
    const stopReason = msg.stop_reason;
    if (toolCall && toolCall.name === 'get_weather') {
      ok(`tool_use returned → name="${toolCall.name}" input=${JSON.stringify(toolCall.input)}`);
    } else if (stopReason === 'tool_use' && msg.content?.some(c => c.type === 'tool_use')) {
      const tc = msg.content.find(c => c.type === 'tool_use');
      ok(`tool_use returned → name="${tc.name}" input=${JSON.stringify(tc.input)}`);
    } else {
      // Model may answer in text without calling tool — not a hard failure for small models
      const text = msg.content?.find(c => c.type === 'text')?.text?.slice(0, 80) || '';
      fail('Tool call not triggered', `stop_reason=${stopReason} text="${text}"`);
    }
  } catch (e) { fail('Tool calling roundtrip', e.message); }

  // ── 7. Tool result roundtrip (multi-turn) ─────────────────────────────────
  console.log(`\n${BOLD}7. Tool result ingestion (multi-turn)${RESET}`);
  info('Simulating Claude Code sending a tool_result back...');
  try {
    const messages = [
      { role: 'user', content: 'What files are in the current directory?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_test01', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_test01', content: 'index.js\npackage.json\nREADME.md' }] },
    ];
    const msg = await sendMessage({ messages });
    const text = msg.content?.find(c => c.type === 'text')?.text?.trim() || '';
    if (text.length > 0) ok(`Multi-turn tool_result ingested → model replied (${text.length} chars)`);
    else                 fail('Multi-turn tool_result', 'Empty response after tool_result');
  } catch (e) { fail('Multi-turn tool_result', e.message); }

  // ── 8. Web search via Playwright ──────────────────────────────────────────
  console.log(`\n${BOLD}8. Web search via Playwright${RESET}`);
  info('Asking model to search the web (may take 20-40s)...');
  try {
    const messages = [{ role: 'user', content: 'Use the web_search tool to search for "node.js latest version" and tell me what you find.' }];
    const msg = await sendMessage({ messages, stream: false });
    const hasText = msg.content?.some(c => c.type === 'text' && c.text.length > 10);
    const usedSearch = msg.content?.some(c => c.type === 'tool_use' && c.name === 'web_search');
    if (hasText) ok(`Web search completed → model responded (${usedSearch ? 'used web_search tool' : 'answered directly'})`);
    else         fail('Web search', 'No response from model');
  } catch (e) { fail('Web search via Playwright', e.message); }

  // ── 9. Dashboard static ───────────────────────────────────────────────────
  console.log(`\n${BOLD}9. Dashboard UI${RESET}`);
  try {
    const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) ok(`GET / → HTTP ${r.status} (dashboard HTML served)`);
    else      fail(`GET /`, `HTTP ${r.status}`);
  } catch (e) { fail('GET /', e.message); }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All ${passed} checks passed.${RESET} Run ${BOLD}yk-copilot on${RESET} and start coding.\n`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}${failed} check(s) failed${RESET}, ${passed} passed.`);
    console.log(`Fix the issues above before running ${BOLD}yk-copilot on${RESET}.\n`);
    process.exit(1);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
