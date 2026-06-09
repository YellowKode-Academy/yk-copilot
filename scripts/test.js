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

function ok(label)   { console.log(`  ${GREEN}✔${RESET} ${label}`); passed++; }
function fail(label, detail) { console.log(`  ${RED}✘${RESET} ${label}`); if (detail) console.log(`    ${RED}${detail}${RESET}`); failed++; }
function info(msg)   { console.log(`  ${YELLOW}•${RESET} ${msg}`); }

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

async function testMessage(stream) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 60,
    stream,
    messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
  };
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'ollama', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);

  if (!stream) {
    const data = await r.json();
    const text = data.content?.find(c => c.type === 'text')?.text || '';
    return text.trim();
  } else {
    const text = await r.text();
    const chunks = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const d = JSON.parse(line.slice(5).trim());
        if (d.delta?.text) chunks.push(d.delta.text);
      } catch {}
    }
    return chunks.join('').trim();
  }
}

async function run() {
  console.log(`\n${BOLD}yk-copilot smoke test${RESET}  ${YELLOW}${BASE}${RESET}\n`);

  // ── Wait ──────────────────────────────────────────────────────────────────
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

  // ── 2. Stats / Sessions API ───────────────────────────────────────────────
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

  // ── 4. Non-streaming message (full pipeline: proxy → Ollama → response) ──
  console.log(`\n${BOLD}4. Message pipeline (non-streaming)${RESET}`);
  info('Sending test message — first call may take 30-60s while Ollama loads the model...');
  try {
    const reply = await testMessage(false);
    if (reply) ok(`POST /v1/messages → "${reply}"`);
    else       fail('POST /v1/messages', 'Empty response');
  } catch (e) { fail('POST /v1/messages (non-stream)', e.message); }

  // ── 5. Streaming message ──────────────────────────────────────────────────
  console.log(`\n${BOLD}5. Message pipeline (streaming SSE)${RESET}`);
  try {
    const reply = await testMessage(true);
    if (reply) ok(`POST /v1/messages stream=true → "${reply}"`);
    else       fail('POST /v1/messages stream=true', 'Empty SSE response');
  } catch (e) { fail('POST /v1/messages (stream)', e.message); }

  // ── 6. Static dashboard served ────────────────────────────────────────────
  console.log(`\n${BOLD}6. Dashboard UI${RESET}`);
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
