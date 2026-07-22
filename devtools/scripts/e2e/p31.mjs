#!/usr/bin/env node
// e2e P31 — external MCP client foundation (Gatherlight-as-MCP-client):
//   register a stub MCP server (stdio AND http) via /api/manage/mcp-servers, assert its tools are
//   proxied into the registry (namespaced {id}__tool) on BOTH surfaces (/api/tools + /mcp) and
//   round-trip a call; prove secret injection (stdio→env, http→header) and that secrets never leak
//   into list DTOs; then toggle-disable and remove and assert the tools disappear.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until, repo } from './_e2e-common.mjs';

const dataDir = dataDirFor('p31');
const PORT = 5431;
const HTTP_STUB_PORT = 5432;
const stubPath = path.join(repo, 'devtools', 'scripts', 'mcp-stub-server.mjs');
const { ok, fail, done } = makeReporter('p31');

makeTestData(dataDir);
const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j } = makeClient(srv.base);

// Spawn the stub as a standalone HTTP MCP server for the remote-transport case.
const httpStub = spawn('node', [stubPath, '--http', String(HTTP_STUB_PORT)], { stdio: ['ignore', 'ignore', 'inherit'] });

const rpc = async (payload) => {
  const res = await fetch(`${srv.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const toolCall = (name, args) => j('/api/tools/call', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, arguments: args }),
});
const toolNames = async () => ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // --- add a stdio MCP server (with a secret → env) ----------------------------------
  const addStdio = await j('/api/manage/mcp-servers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Stub Stdio', transport: 'stdio', command: 'node', args: [stubPath],
      secrets: { STUB_TOKEN: 's3cr3t' },
    }),
  });
  ok('POST add stdio 200', addStdio.status === 200, JSON.stringify(addStdio.body));
  const stdioId = addStdio.body?.id;
  ok('stdio server connected', addStdio.body?.status === 'connected', JSON.stringify(addStdio.body));
  ok('stdio discovered tools', (addStdio.body?.tools ?? []).some((t) => t.name === 'echo'));
  ok('stdio id is a slug', stdioId === 'stub-stdio', stdioId);

  // proxied + namespaced on the HTTP tool surface
  let names = await toolNames();
  ok('proxied echo listed as {id}__echo', names.includes(`${stdioId}__echo`), JSON.stringify(names.filter((n) => n.includes('stub'))));

  // round-trip a call through the proxy
  const echo = await toolCall(`${stdioId}__echo`, { text: 'hello-mcp' });
  ok('proxied echo round-trips', echo.status === 200 && echo.body?.result === 'hello-mcp', JSON.stringify(echo.body));

  // secret was injected into the child's env
  const envEcho = await toolCall(`${stdioId}__env_echo`, { key: 'STUB_TOKEN' });
  ok('stdio secret → env injection', envEcho.body?.result === 's3cr3t', JSON.stringify(envEcho.body));

  // proxied on the MCP surface too
  const mcpList = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const mcpNames = (mcpList.body?.result?.tools ?? []).map((t) => t.name);
  ok('proxied tool on /mcp tools/list', mcpNames.includes(`${stdioId}__echo`));
  const mcpCall = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: `${stdioId}__greet`, arguments: { name: 'Ada' } } });
  ok('proxied tool via /mcp tools/call', mcpCall.body?.result?.content?.[0]?.text === 'hi Ada', JSON.stringify(mcpCall.body));

  // --- secrets never leak in the list DTO --------------------------------------------
  const listAfterStdio = await j('/api/manage/mcp-servers');
  const dto = (listAfterStdio.body ?? []).find((s) => s.id === stdioId);
  ok('list shows hasSecrets=true', dto?.hasSecrets === true, JSON.stringify(dto));
  ok('secret value NOT in list DTO', !JSON.stringify(listAfterStdio.body).includes('s3cr3t'));
  ok('secretsJson NOT in list DTO', !JSON.stringify(listAfterStdio.body).toLowerCase().includes('secretsjson'));

  // --- add an http MCP server (with a secret → header) -------------------------------
  await until(async () => (await fetch(`http://127.0.0.1:${HTTP_STUB_PORT}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' }).then((r) => r.ok).catch(() => false)), 10000);
  const addHttp = await j('/api/manage/mcp-servers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Stub Http', transport: 'http', url: `http://127.0.0.1:${HTTP_STUB_PORT}/`,
      secrets: { 'X-Stub-Token': 'hdr-secret' },
    }),
  });
  ok('POST add http 200', addHttp.status === 200, JSON.stringify(addHttp.body));
  const httpId = addHttp.body?.id;
  ok('http server connected', addHttp.body?.status === 'connected', JSON.stringify(addHttp.body));

  const httpEcho = await toolCall(`${httpId}__echo`, { text: 'over-http' });
  ok('http proxied echo round-trips', httpEcho.body?.result === 'over-http', JSON.stringify(httpEcho.body));
  const hdrEcho = await toolCall(`${httpId}__header_echo`, { name: 'X-Stub-Token' });
  ok('http secret → header injection', hdrEcho.body?.result === 'hdr-secret', JSON.stringify(hdrEcho.body));

  // --- toggle disable → tools disappear ----------------------------------------------
  const dis = await j(`/api/manage/mcp-servers/${stdioId}/enabled`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  ok('disable 200', dis.status === 200);
  names = await toolNames();
  ok('disabled server tools gone', !names.includes(`${stdioId}__echo`), JSON.stringify(names.filter((n) => n.includes('stub'))));
  ok('other server tools remain', names.includes(`${httpId}__echo`));

  // --- remove → server gone ----------------------------------------------------------
  const del = await j(`/api/manage/mcp-servers/${httpId}`, { method: 'DELETE' });
  ok('delete 200', del.status === 200);
  const listFinal = await j('/api/manage/mcp-servers');
  ok('removed server not listed', !(listFinal.body ?? []).some((s) => s.id === httpId));
  names = await toolNames();
  ok('removed server tools gone', !names.includes(`${httpId}__echo`));
} catch (err) {
  fail('e2e-p31 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  try { httpStub.kill(); } catch {}
  srv.stop();
}
done();
