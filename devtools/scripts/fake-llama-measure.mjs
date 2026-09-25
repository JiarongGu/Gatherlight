#!/usr/bin/env node
// A stand-in for llama-server as the RERANKER DEVICE MEASUREMENT launches it (RerankDeviceMeter) — reached only through
// the measurement-only seam GATHERLIGHT_LLAMA_MEASURE_CMD, the way the claude stub is reached through
// GATHERLIGHT_CLAUDE_CMD. The app spawns `node fake-llama-measure.mjs <the same argv it would give llama-server>`:
//   -m <file.gguf> --n-gpu-layers 99 --reranking --ctx-size W --batch-size W --ubatch-size W --device <id|none>
//   --host 127.0.0.1 --port <P>
//
// Behaviour per (model, device) comes from the JSON file named by FAKE_LLAMA_MEASURE_CONFIG, re-read at every start so
// a suite can change it between router starts:
//   { "log": "<jsonl path>",
//     "rates": { "<model id>": { "<device>": <ms per pair token> | "partial" | "http500" | "hang" | "exit" } } }
// A number: /v1/rerank answers after (pair tokens × rate) ms — pair tokens counted as RerankPace counts them (0.83 per
// UTF-16 unit from U+2E80 up, 0.25 below), so the app's measured rate reads back the configured one. "partial" answers at
// once scoring all documents but the last; "http500" refuses; "hang" accepts and never answers; "exit" exits before it
// listens (code 3). A (model, device) with no entry answers at once.
//
// Every start (with its parent pid — the app, which a suite can end with TerminateProcess to prove the child dies with it),
// request and anomaly is appended to the log as one JSON line, so a suite asserts what the app actually
// launched — its argv, one device at a time, the batch it sent — rather than what the app reports about itself.
// OVERLAP is detected here: a start that finds another fake of this kind still alive logs `overlap: true`.
// A safety net, never relied on: the process exits by itself after 5 minutes.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const cfgPath = process.env.FAKE_LLAMA_MEASURE_CONFIG;
const cfg = cfgPath && fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const logPath = cfg.log ?? (cfgPath ? path.join(path.dirname(cfgPath), 'fake-measure.jsonl') : null);
const log = (o) => { if (logPath) fs.appendFileSync(logPath, JSON.stringify({ at: Date.now(), pid: process.pid, ...o }) + '\n'); };

const model = path.basename(arg('-m') ?? '', '.gguf');
const device = arg('--device') ?? '(none given)';
const port = Number(arg('--port'));
const behaviour = cfg.rates?.[model]?.[device] ?? 0;

// Is another fake of this kind alive? Its pid is in the registry and the process answers signal 0.
const registry = logPath ? `${logPath}.alive` : null;
let overlap = false;
if (registry) {
  const alive = fs.existsSync(registry) ? fs.readFileSync(registry, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  const still = alive.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  overlap = still.length > 0;
  fs.writeFileSync(registry, [...still, process.pid].join('\n') + '\n');
}
log({ event: 'start', model, device, port, argv, overlap, behaviour, ppid: process.ppid });
if (behaviour === 'exit') { log({ event: 'exit', code: 3 }); process.exit(3); }
setTimeout(() => process.exit(0), 5 * 60 * 1000).unref();

const tokens = (s) => { let t = 0; for (let i = 0; i < s.length; i++) t += s.charCodeAt(i) >= 0x2e80 ? 0.83 : 0.25; return t; };
const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body); } catch { /* recorded raw */ }
    const docs = Array.isArray(json.documents) ? json.documents.map(String) : [];
    const pairTokens = docs.reduce((a, d) => a + tokens(String(json.query ?? '')) + tokens(d), 0);
    log({ event: 'rerank', model: json.model, device, query: json.query, documents: docs.length,
      characters: docs.reduce((a, d) => a + d.length, 0), pairTokens, head: docs[0]?.slice(0, 24) ?? null });
    if (req.url !== '/v1/rerank') return send(404, { error: { code: 404, message: 'not found' } });
    if (behaviour === 'hang') return;   // accepted, never answered; the app's cap ends it and kills this process
    if (behaviour === 'http500') return send(500, { error: { code: 500, message: 'zzfake refused' } });
    const scored = behaviour === 'partial' ? docs.slice(0, -1) : docs;
    const results = scored.map((d, index) => ({ index, relevance_score: 1 - index / 10 }));
    const wait = typeof behaviour === 'number' ? Math.round(pairTokens * behaviour) : 0;
    setTimeout(() => { if (!res.destroyed) send(200, { model: json.model, results }); }, wait);
  });
});
server.listen(port, '127.0.0.1', () => log({ event: 'listening', port }));
