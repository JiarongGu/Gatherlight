#!/usr/bin/env node
// e2e P34 — agent-driven interactive login IN CHAT (the LLM decides it needs to log in):
//   a chat task where the agent emits LOGIN_REQUIRED → the flow parks at awaiting-login showing the
//   server's QR in chat → once the server reports logged-in, the agent RESUMES automatically and
//   finishes. This is the "login is an MCP capability the LLM can invoke" flow.
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, repo, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p34');
const PORT = 5435;
const stubPath = path.join(repo, 'devtools', 'scripts', 'mcp-stub-server.mjs');
const { ok, fail, done } = makeReporter('p34');

makeTestData(dataDir);
const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j, post, waitPhase } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // the login-walled server the agent will ask to log into (id 'login-demo', matches the stub marker)
  const add = await j('/api/manage/mcp-servers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Login Demo', transport: 'stdio', command: 'node', args: [stubPath],
      loginKind: 'qr', loginTool: 'get_login_qrcode', loginCheckTool: 'check_login_status',
    }),
  });
  ok('login server connected', add.body?.status === 'connected', JSON.stringify(add.body));

  // agent-driven flow: the agent decides it needs to log in
  const id = (await post('/api/chat', { message: 'LOGINTEST 帮我搜一下小红书', mode: 'plan' })).body?.id;
  await waitPhase(id, 'awaiting-plan-approval');
  await post(`/api/chat/${id}/plan/approve`);
  const parked = await waitPhase(id, 'awaiting-login');

  // the QR is shown IN CHAT (server-driven, via the generic login service)
  const lp = parked.mcpLogin;
  ok('login prompt in chat', !!lp, JSON.stringify(parked));
  ok('names the server', lp?.serverName === 'Login Demo', JSON.stringify(lp));
  ok('QR rendered in chat', (lp?.imageDataUri ?? '').startsWith('data:image/png;base64,'));

  // the client would poll the server's login status; wait for the (simulated) scan to complete
  await until(async () => {
    const st = await j(`/api/manage/mcp-servers/login-demo/login/status`);
    return st.body?.loggedIn === true;
  }, 12000, 1000);

  // logged in → resume the agent automatically (what the client does on loggedIn)
  const cont = await post(`/api/chat/${id}/login/continue`);
  ok('login/continue accepted', cont.status === 200, JSON.stringify(cont.body));

  // the agent resumes and finishes (writes the file it was blocked on → diff gate)
  const review = await waitPhase(id, 'awaiting-diff-approval');
  ok('agent resumed → reached diff gate', (review.review?.files ?? []).length > 0, JSON.stringify(review.review?.files?.map((f) => f.path)));
} catch (err) {
  fail('e2e-p34 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
