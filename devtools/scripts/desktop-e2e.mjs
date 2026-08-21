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
  // Polled, for the same reason the health panel below is: the target exists as soon as the WebView
  // navigates, but the document's title is set by the app once it has parsed and run. Reading it on the
  // first frame made this assert on TIMING rather than on what it means — it failed once with the URL
  // already `/manage`, which is the tell that the page was there and simply not titled yet.
  let title = '';
  for (let i = 0; i < 20; i++) {
    title = (await c.evalJs('document.title')) || '';
    if (/Gatherlight|拾光/.test(title)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok('WebView2 shows /manage', /Gatherlight|拾光/.test(title), `${page.url} — title=${title || '(empty)'}`);
  // Poll: the console mounts as soon as the migration gate lifts, but its first health poll lands a
  // moment later. Asserting on the first frame made this pass or fail on timing rather than on health.
  let healthText = '';
  for (let i = 0; i < 20; i++) {
    healthText = (await c.evalJs("document.querySelector('.mng-status .t')?.textContent || ''")) || '';
    if (/Healthy|运行/.test(healthText)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok('health panel rendered', /Healthy|运行/.test(healthText), healthText || '(empty)');

  // 2. host-only controls are present (the page detected the host bridge)
  // Query every button rather than one class: this asserted `.mng-btn` and went stale when the control
  // was reclassed to `.mng-srv-b`, so it reported "missing" for a button sitting right there. The
  // assertion means "a restart control exists", so ask that question instead of naming a class.
  const hasRestart = await c.evalJs("[...document.querySelectorAll('button')].some(b => /重启/.test(b.textContent))");
  ok('restart control present (inHost)', hasRestart === true);

  // 3. a tab switch works over CDP (click 校准·Cortex, confirm the view changed)
  await c.evalJs("[...document.querySelectorAll('.mng-tab')].find(t=>/Cortex/.test(t.textContent))?.click()");
  // Polled, not a fixed pause. A 400ms sleep passed on an idle box and produced a FALSE RED under load —
  // this suite ran right after a model benchmark — taking the three assertions below down with it, since
  // they all look inside a view that had not mounted yet. Same fix as the title assertion above: ask the
  // question the check actually means, and give it time to become true.
  let cortexUp = false;
  for (let i = 0; i < 20; i++) {
    cortexUp = (await c.evalJs("!!document.querySelector('.cx, .cx-lead, .cx-models')")) === true;
    if (cortexUp) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok('tab switch (Cortex) works', cortexUp);

  // 3b. Memory recall — the three switches, which live INSIDE Cortex (we are already on that tab).
  // Checked in the DESKTOP CLIENT rather than a browser, and the enrichment switch is the one worth
  // driving through the real UI: it is an app_config value read per call, so it must flip with NO
  // restart — and "no restart" is a claim only a live UI can falsify.
  await new Promise((r) => setTimeout(r, 900));
  const cards = await c.evalJs("[...document.querySelectorAll('.mem-layer .mem-layer-name')].map(n=>n.textContent).join('|')");
  ok('Cortex renders the three memory-recall switches',
    /Formula/.test(cards) && /Claude CLI/.test(cards) && /Local model/.test(cards), cards);
  ok('and marks the formula floor as always on', /始终启用/.test(cards), cards);

  // The button label IS the state, so flipping it and re-reading is a real round-trip through the API.
  const enrichBtn = "[...document.querySelectorAll('.mem-layer')].find(i=>/Claude CLI/.test(i.textContent))?.querySelector('.cx-btn')";
  const before = await c.evalJs(`${enrichBtn}?.textContent || ''`);
  await c.evalJs(`${enrichBtn}?.click()`);
  await new Promise((r) => setTimeout(r, 900));
  const after = await c.evalJs(`${enrichBtn}?.textContent || ''`);
  ok('the claude-CLI enrichment toggles live, with no restart',
    before.trim().length > 0 && after.trim().length > 0 && before !== after, `${before} -> ${after}`);
  // Put it back: this fixture is disposable, but a test that leaves a switch off teaches the next
  // reader that off is the default.
  await c.evalJs(`${enrichBtn}?.click()`);
  await new Promise((r) => setTimeout(r, 900));
  ok('and toggles back', (await c.evalJs(`${enrichBtn}?.textContent || ''`)) === before, before);

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
