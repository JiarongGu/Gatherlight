#!/usr/bin/env node
// e2e P35 — Windows shell-shim launch (npx-on-Windows support): an MCP server whose command is a
// .cmd shim (like npx/npm) must launch via cmd.exe. Registers a server pointing at a .cmd wrapper
// over the node stub and asserts it connects + proxies a tool — proving ResolveLaunch's cmd path.
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, repo, skipSuite } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p35');
if (process.platform !== 'win32') skipSuite('p35', 'Windows-only (.cmd shell-shim launch)');

const dataDir = dataDirFor('p35');
const PORT = 5436;
const cmdPath = path.join(repo, 'devtools', 'scripts', 'mcp-stub.cmd');

makeTestData(dataDir);
const srv = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const { j } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);
  console.log('server up');

  const add = await j('/api/manage/mcp-servers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Cmd Shim', transport: 'stdio', command: cmdPath, args: [] }),
  });
  ok('add .cmd server 200', add.status === 200, JSON.stringify(add.body));
  ok('.cmd server connected (launched via cmd.exe)', add.body?.status === 'connected', JSON.stringify(add.body));
  const id = add.body?.id;
  ok('discovered tools over the .cmd shim', (add.body?.tools ?? []).some((t) => t.name === 'echo'));

  const echo = await j('/api/tools/call', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${id}__echo`, arguments: { text: 'via-cmd-shim' } }),
  });
  ok('proxied echo round-trips over the .cmd shim', echo.body?.result === 'via-cmd-shim', JSON.stringify(echo.body));
} catch (err) {
  fail('e2e-p35 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
