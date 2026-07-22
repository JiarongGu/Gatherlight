#!/usr/bin/env node
// e2e P33 — generic interactive-login for MCP servers (the reusable QR/browser-login component):
//   register a server that declares login_tool + login_check_tool; /login/start calls the login tool
//   and returns its QR image as a data URI; /login/status polls the check tool and reports logged-in.
//   Server-agnostic — Xiaohongshu is just one instance of this shape.
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, repo, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p33');
const PORT = 5434;
const stubPath = path.join(repo, 'devtools', 'scripts', 'mcp-stub-server.mjs');
const { ok, fail, done } = makeReporter('p33');

makeTestData(dataDir);
const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);
  console.log('server up');

  // add a server that declares an interactive (QR) login
  const add = await j('/api/manage/mcp-servers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Login Stub', transport: 'stdio', command: 'node', args: [stubPath],
      loginKind: 'qr', loginTool: 'get_login_qrcode', loginCheckTool: 'check_login_status',
    }),
  });
  ok('add login server 200', add.status === 200, JSON.stringify(add.body));
  const id = add.body?.id;
  ok('connected', add.body?.status === 'connected');
  ok('DTO reports loginKind=qr', add.body?.loginKind === 'qr', JSON.stringify(add.body));
  ok('DTO reports needsLogin', add.body?.needsLogin === true);

  // start login → the QR image comes back as a data URI, ready to render + scan
  const start = await j(`/api/manage/mcp-servers/${id}/login/start`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  ok('login/start 200', start.status === 200, JSON.stringify(start.body));
  ok('challenge is a QR image data URI', (start.body?.imageDataUri ?? '').startsWith('data:image/png;base64,'), JSON.stringify(start.body).slice(0, 120));
  ok('challenge has a scan message', (start.body?.message ?? '').length > 0);

  // poll status → logged in (the stub reports logged-in a few seconds after the QR was shown,
  // simulating the phone scan; the real UI polls on a 2s timer the same way)
  let statusBody = null;
  await until(async () => {
    const st = await j(`/api/manage/mcp-servers/${id}/login/status`);
    statusBody = st.body;
    return st.status === 200 && st.body?.loggedIn === true;
  }, 12000, 1000);
  ok('reports logged in (after scan delay)', statusBody?.loggedIn === true, JSON.stringify(statusBody));

  // a server WITHOUT login config rejects the login endpoints
  const plain = await j('/api/manage/mcp-servers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Plain Stub', transport: 'stdio', command: 'node', args: [stubPath] }),
  });
  const plainId = plain.body?.id;
  const noLogin = await j(`/api/manage/mcp-servers/${plainId}/login/start`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  ok('no-login server → 400 on login/start', noLogin.status === 400, JSON.stringify(noLogin.body));
  ok('plain server needsLogin=false', plain.body?.needsLogin === false);

  // the session dir was created under the data folder (persistence)
  const fs = await import('node:fs');
  ok('session dir under data folder', fs.existsSync(path.join(dataDir, 'state', 'mcp', id)));
} catch (err) {
  fail('e2e-p33 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
