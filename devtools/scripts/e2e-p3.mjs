#!/usr/bin/env node
// e2e P3 — tool registry over both surfaces: GET/POST /api/tools (HTTP) and the /mcp
// JSON-RPC endpoint (initialize / tools/list / tools/call); extract runs through the
// claude stub; chat runs carry the MCP allowlist + config.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p3-data');
const PORT = 5393;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: {
    ...process.env,
    GATHERLIGHT_DATA: dataDir,
    GATHERLIGHT_PORT: String(PORT),
    GATHERLIGHT_CLAUDE_CMD: `node ${path.join(repo, 'devtools', 'scripts', 'claude-stub.mjs')}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
};
const j = async (p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rpc = async (payload) => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));
  console.log('server up');

  // --- HTTP surface -----------------------------------------------------------------
  const list = await j('/api/tools');
  ok('GET /api/tools 200', list.status === 200);
  const names = (list.body?.tools ?? []).map((t) => t.name);
  ok('extract + scrape listed', names.includes('extract') && names.includes('scrape'));
  const extractDef = list.body.tools.find((t) => t.name === 'extract');
  ok('inputSchema has required relPath', extractDef?.inputSchema?.required?.includes('relPath'));

  const unknown = await j('/api/tools/call', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'nope' }),
  });
  ok('unknown tool 400', unknown.status === 400);

  const missing = await j('/api/tools/call', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'extract', arguments: {} }),
  });
  ok('missing required arg 400', missing.status === 400);

  // extract over an uploaded fixture file (claude stub returns plan text as the "result")
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'uploads', 'fixture.pdf'), '%PDF-1.4 fixture');
  const extract = await j('/api/tools/call', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'extract', arguments: { relPath: 'uploads/fixture.pdf', instruction: '总结' } }),
  });
  ok('extract runs via stub', extract.status === 200 && (extract.body?.result ?? '').length > 0, JSON.stringify(extract.body));

  const traversal = await j('/api/tools/call', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'extract', arguments: { relPath: 'plans/trips/2026-08-kyoto.md' } }),
  });
  ok('extract rejects non-upload path', traversal.status === 400);

  // --- MCP surface -------------------------------------------------------------------
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  ok('mcp initialize', init.status === 200 && init.body?.result?.serverInfo?.name === 'planner-tools');
  ok('mcp session id header', !!init.headers.get('mcp-session-id'));

  const notified = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  ok('mcp notification 202', notified.status === 202);

  const mcpList = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const mcpNames = (mcpList.body?.result?.tools ?? []).map((t) => t.name);
  ok('mcp tools/list', mcpNames.includes('extract') && mcpNames.includes('scrape'));

  const mcpCall = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'extract', arguments: { relPath: 'uploads/fixture.pdf' } } });
  ok('mcp tools/call ok', mcpCall.body?.result?.isError === false
    && mcpCall.body?.result?.content?.[0]?.text?.length > 0);

  const mcpBad = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'extract', arguments: {} } });
  ok('mcp tool failure → isError result', mcpBad.body?.result?.isError === true);

  // --- chat integration: mcp config generated + allowlist passed ----------------------
  const mcpCfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'mcp.chat.json'), 'utf8'));
  ok('mcp.chat.json generated with http url',
    mcpCfg.mcpServers?.['planner-tools']?.type === 'http'
    && mcpCfg.mcpServers?.['planner-tools']?.url === `http://127.0.0.1:${PORT}/mcp`);
} catch (err) {
  console.error('e2e-p3 fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p3 PASS' : `\ne2e-p3 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
