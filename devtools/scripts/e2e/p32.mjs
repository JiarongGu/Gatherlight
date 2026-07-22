#!/usr/bin/env node
// e2e P32 — chat confirmation gate for adding an external MCP server (awaiting-mcp-approval):
//   a chat task proposes MCP_ADD → the flow parks showing the CONCRETE spec (server-rendered, no
//   secrets) → the human approves WITH credentials → the server registers + connects and the tool
//   becomes callable, with the chat-entered credential injected into the server's env. Also: reject
//   → nothing added; the credential value never leaks into the chat snapshot/transcript.
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd } from './_e2e-common.mjs';

const dataDir = dataDirFor('p32');
const PORT = 5433;
const { ok, fail, done } = makeReporter('p32');

makeTestData(dataDir);
const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, waitPhase } = makeClient(srv.base);

const start = async (message) => (await post('/api/chat', { message, mode: 'plan' })).body?.id;
const toolNames = async () => ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);
const toolCall = (name, args) => j('/api/tools/call', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, arguments: args }),
});

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // === approve path ==================================================================
  const id = await start('MCPADDTEST 帮我接入一个 MCP 服务');
  ok('chat started', !!id);
  await waitPhase(id, 'awaiting-plan-approval');
  await post(`/api/chat/${id}/plan/approve`);
  const parked = await waitPhase(id, 'awaiting-mcp-approval');

  // the gate shows the CONCRETE spec, server-rendered from the parsed draft
  const prop = parked.mcpProposal;
  ok('proposal present at gate', !!prop, JSON.stringify(parked));
  ok('proposal shows concrete command', prop?.command === 'node' && Array.isArray(prop?.args) && prop.args[0].includes('mcp-stub-server.mjs'), JSON.stringify(prop));
  ok('proposal lists needed credential', (prop?.neededCredentials ?? []).includes('STUB_TOKEN'));
  ok('proposal carries NO secret value', !JSON.stringify(prop).includes('s3cr3t'));

  // approve WITH the credential the human "entered" at the gate
  const appr = await j(`/api/chat/${id}/mcp/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secrets: { STUB_TOKEN: 's3cr3t' } }),
  });
  ok('approve accepted (202/200)', appr.status === 200, JSON.stringify(appr.body));
  await waitPhase(id, 'committed');

  // server registered + connected
  const servers = await j('/api/manage/mcp-servers');
  const server = (servers.body ?? []).find((s) => s.id === 'stub-mcp');
  ok('server registered as stub-mcp', !!server, JSON.stringify(servers.body));
  ok('server connected', server?.status === 'connected', JSON.stringify(server));
  ok('server has secrets (from chat)', server?.hasSecrets === true);

  // its tools are callable, and the chat-entered credential reached the server's env
  const names = await toolNames();
  ok('proxied tool present', names.includes('stub-mcp__echo'), JSON.stringify(names.filter((n) => n.includes('stub-mcp'))));
  const envEcho = await toolCall('stub-mcp__env_echo', { key: 'STUB_TOKEN' });
  ok('chat credential → server env', envEcho.body?.result === 's3cr3t', JSON.stringify(envEcho.body));

  // credential value never leaked into the chat snapshot
  const snap = await j(`/api/chat/${id}`);
  ok('secret NOT in chat snapshot', !JSON.stringify(snap.body).includes('s3cr3t'), JSON.stringify(snap.body).slice(0, 300));

  // === reject path ===================================================================
  const id2 = await start('MCPADDTEST 再接入一个(这次我会拒绝)');
  await waitPhase(id2, 'awaiting-plan-approval');
  await post(`/api/chat/${id2}/plan/approve`);
  await waitPhase(id2, 'awaiting-mcp-approval');
  const rej = await post(`/api/chat/${id2}/mcp/reject`);
  ok('reject accepted', rej.status === 200);
  await waitPhase(id2, 'rejected');
  const serversAfter = await j('/api/manage/mcp-servers');
  ok('reject added no server', (serversAfter.body ?? []).filter((s) => s.id.startsWith('stub-mcp')).length === 1, JSON.stringify((serversAfter.body ?? []).map((s) => s.id)));
} catch (err) {
  fail('e2e-p32 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
