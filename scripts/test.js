#!/usr/bin/env node
// Smoke test — run after `docker compose up` to verify everything works
// Usage:
//   node scripts/test.js
//   node scripts/test.js --url http://localhost:9999
//   node scripts/test.js --wait   (waits up to 120s for proxy to be ready)

// Generate a solid-color PNG (no external deps) for vision testing
function makeSolidPng(w, h, r, g, b) {
  const crc32 = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
    return (buf) => { let c = 0xFFFFFFFF; for (const byte of buf) c = t[(c ^ byte) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  })();
  const adler = (buf) => { let a = 1, b2 = 0; for (const byte of buf) { a = (a + byte) % 65521; b2 = (b2 + a) % 65521; } return (b2 << 16) | a; };
  const u32 = (n) => Buffer.from([(n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
  const chunk = (type, data) => { const tb = Buffer.from(type, 'ascii'); return Buffer.concat([u32(data.length), tb, data, u32(crc32(Buffer.concat([tb, data])))]); };
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0; for (let x = 0; x < w; x++) { const o = y * (1 + w * 3) + 1 + x * 3; raw[o] = r; raw[o+1] = g; raw[o+2] = b; } }
  const zl = Buffer.alloc(2 + 5 + raw.length + 4);
  zl[0] = 0x78; zl[1] = 0x01; zl[2] = 0x01;
  zl[3] = raw.length & 0xFF; zl[4] = (raw.length >> 8) & 0xFF; zl[5] = (~raw.length) & 0xFF; zl[6] = (~raw.length >> 8) & 0xFF;
  raw.copy(zl, 7); const ad = adler(raw); zl[7+raw.length]=(ad>>24)&0xFF; zl[8+raw.length]=(ad>>16)&0xFF; zl[9+raw.length]=(ad>>8)&0xFF; zl[10+raw.length]=ad&0xFF;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]), chunk('IHDR', Buffer.from([0,0,0,w,0,0,0,h,8,2,0,0,0])), chunk('IDAT', zl), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

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

async function sendMessage({ messages, tools, stream = false, maxTokens = 256 }) {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'ollama', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, stream, messages, tools }),
    signal: AbortSignal.timeout(300000),
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

  // ── 9. Vision pipeline (gemma4 → qwen) ───────────────────────────────────
  console.log(`\n${BOLD}9. Vision pipeline (image → gemma4 → qwen2.5-coder)${RESET}`);
  info('Generating 64x64 test image and sending through vision pipeline...');
  try {
    const imgB64 = makeSolidPng(64, 64, 0, 100, 200); // blue square
    const msg = await sendMessage({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgB64 } },
          { type: 'text',  text: 'Describe what you see in this image in one sentence.' },
        ],
      }],
    });
    const text = msg.content?.find(c => c.type === 'text')?.text?.trim() || '';
    const mentionsColor = /blue|color|solid|uniform|square|image/i.test(text);
    if (mentionsColor) ok(`Vision pipeline → "${text.slice(0, 120)}${text.length > 120 ? '...' : ''}"`);
    else if (text.length > 10) ok(`Vision pipeline responded (${text.length} chars) → "${text.slice(0, 80)}..."`);
    else                       fail('Vision pipeline', 'Empty or no response');
  } catch (e) { fail('Vision pipeline', e.message); }

  // ── 10. Complex coding prompt ─────────────────────────────────────────────
  console.log(`\n${BOLD}10. Complex coding prompt${RESET}`);
  info('Asking for a real coding task (Python function with logic)...');
  try {
    const msg = await sendMessage({
      messages: [{
        role: 'user',
        content: 'Write a Python function called `flatten` that takes a nested list of any depth and returns a flat list. Include a docstring and handle edge cases.',
      }],
      // A larger model explains its plan before writing the code; 256 tokens cuts it
      // off before the function ever appears.
      maxTokens: 1200,
    });
    const text = msg.content?.find(c => c.type === 'text')?.text || '';
    const hasCode   = text.includes('def flatten') || text.includes('def ');
    const hasReturn = text.includes('return');
    if (hasCode && hasReturn) ok(`Complex prompt → function generated (${text.length} chars, contains code)`);
    else if (text.length > 50) fail('Complex coding prompt', `Response has no recognizable Python function:\n    "${text.slice(0, 120)}"`);
    else                       fail('Complex coding prompt', 'Empty or too short response');
  } catch (e) { fail('Complex coding prompt', e.message); }

  // ── 11. Dashboard static ──────────────────────────────────────────────────
  console.log(`\n${BOLD}11. Dashboard UI${RESET}`);
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
