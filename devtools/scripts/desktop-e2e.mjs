#!/usr/bin/env node
// desktop-e2e.mjs — end-to-end test of the DESKTOP host's WebView2 UI over CDP (Chrome DevTools
// Protocol). Verifies the interactions that only exist inside the desktop app (the in-process server
// restart, tab switches) — things the browser-based e2e/API suites can't reach.
//
// Requires the host running with CDP exposed: `dev.mjs host --dev` (writes devtools/_cdp-port), or an
// explicit port. Usage: node devtools/scripts/desktop-e2e.mjs [cdpPort] [healthUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cdpPort = process.argv[2] || fs.readFileSync(path.join(repo, 'devtools', '_cdp-port'), 'utf8').trim();
const health = process.argv[3] || 'http://127.0.0.1:5317/api/health';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};
const healthOk = async () => { try { return (await fetch(health)).ok; } catch { return false; } };
const pageTarget = async () => {
  const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  return t.find((x) => x.type === 'page' && /manage/.test(x.url)) || t.find((x) => x.type === 'page');
};

// Minimal CDP client over the target's WebSocket.
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const ready = new Promise((r) => (ws.onopen = r));
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  return { ready, evalJs, close: () => ws.close() };
}

const page = await pageTarget();
if (!page) { console.log('no /manage page target on CDP', cdpPort, '— is the host running with --dev?'); process.exit(1); }
const c = connect(page.webSocketDebuggerUrl);
await c.ready;

try {
  // 1. the WebView2 is actually showing /manage
  ok('WebView2 shows /manage', /Gatherlight|拾光/.test((await c.evalJs('document.title')) || ''), page.url);
  ok('health panel rendered', /Healthy|运行/.test((await c.evalJs("document.querySelector('.mng-status .t')?.textContent || ''")) || ''));

  // 2. host-only controls are present (the page detected __gatherlightHost)
  const hasRestart = await c.evalJs("[...document.querySelectorAll('.mng-btn')].some(b => /重启/.test(b.textContent))");
  ok('restart control present (inHost)', hasRestart === true);

  // 3. a tab switch works over CDP (click 校准·Cortex, confirm the view changed)
  await c.evalJs("[...document.querySelectorAll('.mng-tab')].find(t=>/Cortex/.test(t.textContent))?.click()");
  await new Promise((r) => setTimeout(r, 400));
  ok('tab switch (Cortex) works', (await c.evalJs("!!document.querySelector('.cx, .cx-lead, .cx-models')")) === true);
  // Settings tab renders its config form (the surface for editing settings.json)
  await c.evalJs("[...document.querySelectorAll('.mng-tab')].find(t=>/Settings/.test(t.textContent))?.click()");
  await new Promise((r) => setTimeout(r, 700));
  ok('Settings tab renders config form', (await c.evalJs("!!document.querySelector('.set-group')")) === true);
  await c.evalJs("[...document.querySelectorAll('.mng-tab')].find(t=>/Overview/.test(t.textContent))?.click()");
  await new Promise((r) => setTimeout(r, 300));

  // 4. THE feature: fire the restart bridge, confirm the in-process server recycles (health dips + recovers)
  ok('server healthy before restart', await healthOk());
  await c.evalJs("window.chrome.webview.postMessage('restart')");
  let down = false, up = false;
  for (let i = 0; i < 80; i++) {
    const h = await healthOk();
    if (!h) down = true;
    if (down && h) { up = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  ok('in-process server recycled (health dipped then recovered)', down && up, `down=${down} up=${up}`);

  // 5. the WebView reconnected to /manage after the restart's reload
  await new Promise((r) => setTimeout(r, 1800));
  ok('WebView reconnected to /manage after restart', !!(await pageTarget()));
} finally {
  c.close();
}

console.log(failures === 0 ? '\ndesktop-e2e PASS' : `\ndesktop-e2e FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
