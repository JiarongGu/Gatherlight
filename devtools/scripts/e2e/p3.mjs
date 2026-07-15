#!/usr/bin/env node
// e2e P3 — tool registry over both surfaces: GET/POST /api/tools (HTTP) and the /mcp
// JSON-RPC endpoint (initialize / tools/list / tools/call); extract runs through the
// claude stub; chat runs carry the MCP allowlist + config.
import path from 'node:path';
import fs from 'node:fs';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd } from './_e2e-common.mjs';

const dataDir = dataDirFor('p3');
const PORT = 5393;
const { ok, fail, done } = makeReporter('p3');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j } = makeClient(srv.base);

const rpc = async (payload) => {
  const res = await fetch(`${srv.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // --- HTTP surface -----------------------------------------------------------------
  const list = await j('/api/tools');
  ok('GET /api/tools 200', list.status === 200);
  const names = (list.body?.tools ?? []).map((t) => t.name);
  ok('extract + scrape listed', names.includes('extract') && names.includes('scrape'));
  const extractDef = list.body.tools.find((t) => t.name === 'extract');
  ok('inputSchema has required relPath', extractDef?.inputSchema?.required?.includes('relPath'));
  const xhsDef = list.body.tools.find((t) => t.name === 'xhs_search');
  ok('xhs_search registered with required query',
    !!xhsDef && xhsDef.inputSchema?.required?.includes('query'), JSON.stringify(xhsDef?.inputSchema));

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

  const notified = await fetch(`${srv.base}/mcp`, {
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
  fail('e2e-p3 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
