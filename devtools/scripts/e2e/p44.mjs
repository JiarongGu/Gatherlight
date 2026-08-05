#!/usr/bin/env node
// e2e P44 — the agent's own MCP channel. The bug this covers is a server that answers politely with
// NOTHING: with TLS on, or trustLoopback off, the agent's MCP connection failed and the CLI simply
// contributed no tools, so the agent reported them missing. Every row therefore asserts the TOOL
// LIST, never merely a 200.
//
// The TLS section talks to the app's OWN generated self-signed cert, which node refuses by default —
// relax verification for THIS suite's client only (never runner-wide). Same reasoning as p18.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p44');
const { ok, fail, done } = makeReporter('p44');
makeTestData(dataDir);

// Free port — suites use up to 5486 (p43); this one is clear.
const PORT = 5488;

const settingsPath = path.join(dataDir, 'state', 'settings.json');
const writeSettings = (security) => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ security }, null, 2), 'utf8');
};
// Kestrel needs a moment to release the public port between boots on Windows.
const settle = () => new Promise((r) => setTimeout(r, 1500));
// Ready = listening AND the startup migration has lifted the 503 gate, or /api/manage/* is refused.
const waitReady = (url, headers = {}) => until(async () => {
  const r = await fetch(url, { headers });
  return r.ok && (await r.json())?.migrating === false;
}, 60000);

// The channel's port + token are in memory; the server reports them on /api/manage/agent-mcp so a
// test can reach the same endpoint the agent is handed.
const toolNames = async (port, scheme, token, headers = {}) => {
  const res = await fetch(`${scheme}://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (!res.ok) return { status: res.status, names: [] };
  const body = await res.json();
  return { status: res.status, names: (body?.result?.tools ?? []).map((t) => t.name) };
};

let server = null;
try {
  // --- 1. default config: the positive control -----------------------------------------------
  writeSettings({});
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  const base = server.base ?? `http://127.0.0.1:${PORT}`;
  const { j, post } = makeClient(base);
  await waitHealthy(base, 60000);

  const ch = (await j('/api/manage/agent-mcp')).body;
  ok('the channel reports a bound port', (ch?.port ?? 0) > 0, JSON.stringify(ch));
  ok('the channel port is not the public port', ch?.port !== PORT, String(ch?.port));

  const def = await toolNames(ch.port, 'http', ch.token);
  ok('default config: the agent channel lists tools', def.names.length > 0, JSON.stringify(def));

  // The restrictions.
  const noTok = await fetch(`http://127.0.0.1:${ch.port}/mcp`, { method: 'POST' });
  ok('the channel refuses a call with no token', noTok.status === 401, String(noTok.status));
  const badTok = await toolNames(ch.port, 'http', 'x');
  ok('the channel refuses a SHORT wrong token (no length-mismatch throw)', badTok.status === 401, String(badTok.status));
  const apiOnChannel = await fetch(`http://127.0.0.1:${ch.port}/api/health`);
  ok('the channel is not a second door into /api', apiOnChannel.status === 404, String(apiOnChannel.status));

  ok('the generated mcp.chat.json is gone', !fs.existsSync(path.join(dataDir, 'state', 'mcp.chat.json')));

  // The rows above test the CHANNEL. This one tests the AGENT: drive a real turn through the stub and
  // have it report the MCP servers the config it was handed actually named. `planner-tools` is the
  // load-bearing part — AllowedTools are mcp__planner-tools__*, so any other name would leave every
  // tool un-approved with nothing anywhere saying so.
  const started = await post('/api/chat', { message: 'MCP_ECHO 看看工具', mode: 'plan' });
  const id = started.body?.id;
  if (!id) throw new Error(`no session id: ${JSON.stringify(started.body)}`);
  await until(async () => {
    const p = (await j(`/api/chat/${id}`)).body?.phase;
    return p && p !== 'idle' && p !== 'planning';
  }, 60000);
  const plan = (await j(`/api/chat/${id}`)).body?.plan ?? '';
  ok('the spawned agent is given the planner-tools server',
    /MCP_SERVERS:[^\n]*planner-tools/.test(plan), plan.slice(0, 160));
  await post(`/api/chat/${id}/cancel`);

  server.stop();
  await settle();

  // --- 2. TLS on — the first configuration that broke -----------------------------------------
  writeSettings({ tls: { enabled: true } });
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitReady(`https://127.0.0.1:${PORT}/api/health`);
  const tlsCh = await (await fetch(`https://127.0.0.1:${PORT}/api/manage/agent-mcp`)).json();
  const withTls = await toolNames(tlsCh.port, 'http', tlsCh.token);
  ok('TLS on: the agent channel still lists tools', withTls.names.length > 0, JSON.stringify(withTls));
  ok('TLS on: the channel is plain http, not https', (tlsCh.url ?? '').startsWith('http://'), tlsCh.url ?? '');
  server.stop();
  await settle();

  // --- 3. trustLoopback off — the second ------------------------------------------------------
  writeSettings({ accessToken: 'p44-token', trustLoopback: false });
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitReady(`http://127.0.0.1:${PORT}/api/health`, { 'X-Gatherlight-Token': 'p44-token' });
  const gatedCh = await (await fetch(`http://127.0.0.1:${PORT}/api/manage/agent-mcp`,
    { headers: { 'X-Gatherlight-Token': 'p44-token' } })).json();
  const withGate = await toolNames(gatedCh.port, 'http', gatedCh.token);
  ok('trustLoopback off: the agent channel still lists tools', withGate.names.length > 0, JSON.stringify(withGate));
  // The public /mcp stays gated exactly as before — the channel does not weaken it.
  const publicMcp = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST' });
  ok('the PUBLIC /mcp is still gated', publicMcp.status === 401, String(publicMcp.status));
} catch (e) {
  fail(e?.stack || String(e));
  console.error((server?.log() ?? '').slice(-2500));
} finally {
  server?.stop();
}

done();
