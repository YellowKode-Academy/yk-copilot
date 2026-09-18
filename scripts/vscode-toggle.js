// Toggle the Claude Code VS Code extension between the local proxy and the cloud.
//
// The extension's setting is `claudeCode.environmentVariables`, an ARRAY of
// {name, value} pairs — not `claude.apiBaseUrl`, which does not exist. Setting a
// non-existent key looks like it worked and changes nothing.
const fs = require('fs');
const [, , settingsPath, action, proxy] = process.argv;

const KEY  = 'claudeCode.environmentVariables';
const OURS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'];

// VS Code settings.json allows comments and trailing commas; JSON.parse does not.
function parseJsonc(text) {
  let out = '', inStr = false, esc = false, line = false, block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (line) { if (c === '\n') { line = false; out += c; } continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

try {
  const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
  const s = parseJsonc(raw.replace(/^﻿/, '') || '{}');

  // Keep any variables the user set themselves; only own the two that are ours.
  const kept = (Array.isArray(s[KEY]) ? s[KEY] : []).filter(v => v && !OURS.includes(v.name));

  if (action === 'on') {
    s[KEY] = [...kept,
      { name: 'ANTHROPIC_BASE_URL', value: proxy },
      { name: 'ANTHROPIC_API_KEY',  value: 'ollama' },
    ];
  } else {
    if (kept.length) s[KEY] = kept; else delete s[KEY];
  }

  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
  console.log(`[yk] VS Code: ${action === 'on' ? 'apontado para ' + proxy : 'de volta para a nuvem'}`);
  console.log('[yk] recarregue a janela: Ctrl+Shift+P > Reload Window');
} catch (e) {
  console.log('[yk] nao consegui atualizar o settings.json do VS Code: ' + e.message);
  process.exit(1);
}
