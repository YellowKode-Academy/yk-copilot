// Vision diagnostic — tries multiple formats against Ollama + proxy
const OLLAMA = process.env.OLLAMA_API_URL || 'http://localhost:11434';
const BASE   = process.env.YK_URL         || 'http://localhost:9999';

// Generate a real solid-color PNG without native libs (32x32 blue square)
function makePng(w = 32, h = 32, r = 0, g = 100, b = 200) {
  const crc32 = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return (buf) => {
      let c = 0xFFFFFFFF;
      for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
  })();

  const adler32 = (buf) => {
    let a = 1, b2 = 0;
    for (const byte of buf) { a = (a + byte) % 65521; b2 = (b2 + a) % 65521; }
    return (b2 << 16) | a;
  };

  const u32be = (n) => Buffer.from([(n>>24)&0xFF,(n>>16)&0xFF,(n>>8)&0xFF,n&0xFF]);

  // Raw scanlines: filter byte 0x00 + RGB pixels per row
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0x00;
    for (let x = 0; x < w; x++) {
      const off = y * (1 + w * 3) + 1 + x * 3;
      raw[off] = r; raw[off+1] = g; raw[off+2] = b;
    }
  }

  // Simple zlib (no compression: block header + data)
  const zlibLen = 2 + 5 + raw.length + 4;
  const zlib = Buffer.alloc(zlibLen);
  zlib[0] = 0x78; zlib[1] = 0x01;          // zlib header
  zlib[2] = 0x01;                            // BFINAL=1 BTYPE=00 (no compression)
  const lenBytes = raw.length & 0xFFFF;
  zlib[3] = lenBytes & 0xFF; zlib[4] = (lenBytes >> 8) & 0xFF;
  zlib[5] = (~lenBytes) & 0xFF; zlib[6] = (~lenBytes >> 8) & 0xFF;
  raw.copy(zlib, 7);
  const ad = adler32(raw);
  zlib[7 + raw.length]     = (ad >> 24) & 0xFF;
  zlib[7 + raw.length + 1] = (ad >> 16) & 0xFF;
  zlib[7 + raw.length + 2] = (ad >> 8)  & 0xFF;
  zlib[7 + raw.length + 3] =  ad        & 0xFF;

  const chunk = (type, data) => {
    const len = u32be(data.length);
    const typeBytes = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBytes, data]);
    return Buffer.concat([len, typeBytes, data, u32be(crc32(crcInput))]);
  };

  const ihdr = Buffer.from([
    0,0,0,w, 0,0,0,h, 8, 2, 0, 0, 0
  ]);

  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]), // sig
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function tryPost(label, url, body) {
  console.log(`\n${label}`);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0,200) }; }
    const reply = data.message?.content || data.content || data.error || data.raw || '';
    console.log(`  HTTP ${r.status} → ${JSON.stringify(String(reply)).slice(0, 200)}`);
    return r.ok;
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    return false;
  }
}

async function main() {
  const imgBuf = makePng(64, 64, 0, 100, 200);
  const b64    = imgBuf.toString('base64');
  console.log(`Generated PNG: ${imgBuf.length} bytes, b64 length ${b64.length}`);
  console.log(`PNG sig valid: ${imgBuf[0]===0x89 && imgBuf[1]===0x50 && imgBuf[2]===0x4E && imgBuf[3]===0x47}`);

  // Format 1: images array (classic Ollama vision)
  await tryPost('Format 1: images[] in message', `${OLLAMA}/api/chat`, {
    model: 'gemma4:e4b', stream: false, options: { num_predict: 40 },
    messages: [{ role: 'user', content: 'What color is in this image? One word.', images: [b64] }],
  });

  // Format 2: images array via /api/generate
  await tryPost('Format 2: /api/generate with images[]', `${OLLAMA}/api/generate`, {
    model: 'gemma4:e4b', stream: false, options: { num_predict: 40 },
    prompt: 'What color is in this image? One word.',
    images: [b64],
  });

  // Format 3: data URI in content
  await tryPost('Format 3: data URI in content text', `${OLLAMA}/api/chat`, {
    model: 'gemma4:e4b', stream: false, options: { num_predict: 40 },
    messages: [{ role: 'user', content: `[img]data:image/png;base64,${b64}[/img]\nWhat color is in this image? One word.` }],
  });

  // Format 4: via proxy (Anthropic format)
  console.log('\nFormat 4: via proxy /v1/messages (Anthropic format)');
  try {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'ollama', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 100, stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
            { type: 'text', text: 'Describe this image in one sentence.' },
          ],
        }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json();
    const text = data.content?.find(c => c.type === 'text')?.text || JSON.stringify(data).slice(0,200);
    console.log(`  HTTP ${r.status} → "${text.slice(0,200)}"`);
  } catch (e) { console.log(`  ERROR: ${e.message}`); }
}

main().catch(console.error);
