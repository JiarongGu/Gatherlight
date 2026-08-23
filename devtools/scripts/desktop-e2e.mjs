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
  // RETRY THE CLICK, not just the check. Polling only the result assumed the click had landed — but a
  // click dispatched before React has wired the handler is swallowed silently, and then no amount of
  // waiting produces the view. This assertion flapped run to run for exactly that reason, which reads as
  // "the Cortex tab is broken" rather than "we clicked too early".
  const switchTab = async (label, ready) => {
    for (let i = 0; i < 40; i++) {
      if ((await c.evalJs(`!!document.querySelector('${ready}')`)) === true) return true;
      await c.evalJs(`[...document.querySelectorAll('.mng-tab')].find(t=>/${label}/.test(t.textContent))?.click()`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return (await c.evalJs(`!!document.querySelector('${ready}')`)) === true;
  };
  // Polled, not a fixed pause. A 400ms sleep passed on an idle box and produced a FALSE RED under load —
  // this suite ran right after a model benchmark — taking the three assertions below down with it, since
  // they all look inside a view that had not mounted yet. Same fix as the title assertion above: ask the
  // question the check actually means, and give it time to become true.
  const cortexUp = await switchTab('Cortex', '.cx, .cx-lead, .cx-models');
  ok('tab switch (Cortex) works', cortexUp);

  // 3b. Memory recall — the three switches, which live INSIDE Cortex (we are already on that tab).
  // Checked in the DESKTOP CLIENT rather than a browser, and the enrichment switch is the one worth
  // driving through the real UI: it is an app_config value read per call, so it must flip with NO
  // restart — and "no restart" is a claim only a live UI can falsify.
  // POLLED, not a fixed pause — the third time this file has had to learn it. The memory panel fetches
  // its own state after Cortex mounts, so a 900 ms sleep raced the layers into existence: the assertions
  // below read an EMPTY string and reported that the panel renders nothing, while a diagnostic a few
  // lines later found all three. A fixed sleep does not fail honestly; it fails as a wrong description
  // of the product.
  let cards = '';
  for (let i = 0; i < 40; i++) {
    cards = (await c.evalJs("[...document.querySelectorAll('.mem-layer .mem-layer-name')].map(n=>n.textContent).join('|')")) || '';
    if (/Formula/.test(cards) && /Judgement/.test(cards) && /Semantic/.test(cards)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // The LAYER names, which is what these cards are titled with. This asserted /Claude CLI/ and
  // /Local model/ — a BACKEND and a name that was retired when the layers were renamed for what they DO.
  // It rotted silently because this harness is run by hand rather than in the fleet, which is the same
  // reason the assertions below had to be added by hand too.
  ok('Cortex renders the three memory-recall switches',
    /Formula/.test(cards) && /Judgement/.test(cards) && /Semantic/.test(cards), cards);
  ok('and marks the formula floor as always on', /始终启用/.test(cards), cards);

  // The button label IS the state, so flipping it and re-reading is a real round-trip through the API.
  // Located by the LAYER's name. Matching on /Claude CLI/ found it only because that layer happened to be
  // bound to that backend — it would have picked a different card, or none, the moment the binding changed.
  const enrichBtn = "[...document.querySelectorAll('.mem-layer')].find(i=>/Judgement/.test(i.textContent))?.querySelector('.cx-btn')";
  // POLLED for the same reason as the cards above, and it failed the same way: the panel REFETCHES its
  // whole state after a toggle, so 900 ms later the button can be absent mid-render and reads as ''. The
  // assertion then reported "the switch does not flip" — a wrong statement about the product caused
  // entirely by when it looked.
  const settled = async (want) => {
    let seen = '';
    for (let i = 0; i < 40; i++) {
      seen = (await c.evalJs(`${enrichBtn}?.textContent || ''`)) || '';
      if (seen.trim().length > 0 && want(seen)) return seen;
      await new Promise((r) => setTimeout(r, 250));
    }
    return seen;
  };

  const before = await settled(() => true);
  await c.evalJs(`${enrichBtn}?.click()`);
  const after = await settled((t) => t !== before);
  ok('the claude-CLI enrichment toggles live, with no restart',
    before.trim().length > 0 && after.trim().length > 0 && before !== after, `${before} -> ${after}`);
  // Put it back: this fixture is disposable, but a test that leaves a switch off teaches the next
  // reader that off is the default.
  await c.evalJs(`${enrichBtn}?.click()`);
  const restored = await settled((t) => t === before);
  ok('and toggles back', restored === before, `${after} -> ${restored} (want ${before})`);

  // 3c. 资源 — THE FIELDS THAT ARRIVE LATE. Both panels stopped awaiting a process spawn before they
  // answer: the CLI's login line costs ~0.6–0.9s and llama.cpp's build tag costs two process starts, so the
  // server sends null and probes in the background while each panel re-asks ONCE. That retry is a client
  // effect with no server-side signal — if it regresses, the row simply stays blank for ever and every API
  // test still passes. This is the only place in the repo that can catch it, which is why it is here and
  // not in the fleet: it needs a real rendered UI.
  // Same retry-the-click helper as Cortex. This one happened to pass, which is the least reliable
  // reason to leave a race in place.
  const resUp = await switchTab('Resources|资源', '.res-list');
  ok('tab switch (Resources) works', resUp);

  // The CLI's line starts as 检查中… and must become a real answer. Polled rather than slept: the retry is
  // one 900ms timer plus a process spawn, and a fixed pause would make this flaky under load.
  let claudeLine = '';
  for (let i = 0; i < 24; i++) {
    claudeLine = await c.evalJs(
      "([...document.querySelectorAll('.res-item')].find(r=>/Claude CLI/.test(r.textContent))?.textContent || '')");
    if (claudeLine && !/检查中/.test(claudeLine)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok('the CLI row resolves its login state instead of staying on 检查中…',
    claudeLine.length > 0 && !/检查中/.test(claudeLine)
      && /已登录|尚未登录|未安装|无法运行/.test(claudeLine),
    claudeLine.replace(/\s+/g, ' ').slice(0, 120));

  // And llama.cpp's row must gain its build tag. Only asserted when it is INSTALLED — on a machine that
  // never downloaded it there is nothing to fill in, and demanding a version there would be a test that
  // fails for being on the wrong machine.
  // Wait for the ROW before deciding whether the runtime is installed. Reading it immediately answered
  // "not installed" on a machine that has it, and the check below then took its skip branch and reported a
  // green PASS — a vacuous test that hid a real failure for one run.
  const llamaRow = "([...document.querySelectorAll('.res-models .res-item')].find(r=>/llama\\.cpp/.test(r.textContent))?.textContent || '')";
  let llamaSeen = '';
  for (let i = 0; i < 24; i++) {
    llamaSeen = await c.evalJs(llamaRow);
    if (llamaSeen.length > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok('the llama.cpp runtime row renders at all', llamaSeen.length > 0, llamaSeen.slice(0, 80));
  const llamaInstalled = /已安装/.test(llamaSeen);
  if (llamaInstalled) {
    let llamaLine = '';
    for (let i = 0; i < 24; i++) {
      llamaLine = await c.evalJs(
        "([...document.querySelectorAll('.res-models .res-item')].find(r=>/llama\\.cpp/.test(r.textContent))?.textContent || '')");
      if (/\bb\d{3,}/.test(llamaLine)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    ok('the llama.cpp row gains its build tag after the background probe lands',
      /\bb\d{3,}/.test(llamaLine), llamaLine.replace(/\s+/g, ' ').slice(0, 120));
  } else {
    ok('(llama.cpp not installed here) its late-arriving build tag is not exercised', true,
      'needs the runtime downloaded; nothing would fill in on a machine without it');
  }

  // Settings tab renders its config form (the surface for editing settings.json)
  const setUp = await switchTab('Settings', '.set-group');
  ok('Settings tab renders config form', setUp);

  // WAN + no TLS is a bearer token crossing the internet in PLAINTEXT. The token requirement is enforced
  // (the service refuses to start without one) but HTTPS is only advice, and the danger styling keyed
  // solely on the token — so the unsafe half looked exactly as calm as a safe setup.
  //
  // SAFE TO DRIVE on the real data folder: the segmented control sets React state only, and nothing is
  // written until 保存 is pressed, which this never does. It selects 本机 again afterwards regardless.
  const wanWarn = async () => (await c.evalJs(
    "[...document.querySelectorAll('.set-hint.danger')].map(n=>n.textContent).join('|')")) || '';
  const pickMode = (label) => c.evalJs(
    `[...document.querySelectorAll('.set-access-seg button, .set-access-seg .seg-opt')]`
    + `.find(b=>/${label}/.test(b.textContent))?.click()`);
  try {
    await pickMode('WAN');
    let warned = '';
    for (let i = 0; i < 20; i++) {
      warned = await wanWarn();
      if (/HTTPS/.test(warned)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    ok('choosing WAN without HTTPS warns that the token crosses the internet in plaintext',
      /HTTPS/.test(warned) && /明文/.test(warned), JSON.stringify(warned.slice(0, 120)));
  } finally {
    await pickMode('Local');
  }
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
