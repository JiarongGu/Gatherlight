#!/usr/bin/env node
// e2e P5 — hot-loadable script tools: scaffolded tool appears while the server runs (no
// rebuild), is callable on HTTP + listed on MCP, manifest edits hot-reload, broken manifests
// are skipped harmlessly, and built-ins win name collisions.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { repo, dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, until } from './_e2e-common.mjs';

const dataDir = dataDirFor('p5');
const { ok, fail, done } = makeReporter('p5');
makeTestData(dataDir);
const srv = startServer({ dataDir, port: 5395 });
const { j, call } = makeClient(srv.base);

const listNames = async () => ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);

try {
  await waitHealthy(srv.base);
  ok('no script tools at boot', !(await listNames()).includes('echo_tool'));

  // --- hot ADD while running (via the scaffolder) --------------------------------------
  spawnSync('node', [path.join(repo, 'devtools', 'dev.mjs'), 'new-tool', 'echo_tool', dataDir], { stdio: 'inherit' });
  await until(async () => (await listNames()).includes('echo_tool'), 15000);
  ok('scaffolded tool hot-loaded (no rebuild)', true);

  const r1 = await call('echo_tool', { text: 'hello-gatherlight' });
  ok('script tool callable (stdin JSON → stdout)', r1.status === 200
    && r1.result.echo === 'hello-gatherlight', JSON.stringify(r1.result));

  const missing = await call('echo_tool', {});
  ok('required-arg validation applies to script tools', missing.status === 400);

  // --- hot EDIT: manifest change reflected ----------------------------------------------
  const manifestPath = path.join(dataDir, 'tools', 'echo_tool', 'tool.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.description = 'edited-live';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await until(async () =>
    ((await j('/api/tools')).body.tools.find((t) => t.name === 'echo_tool')?.description) === 'edited-live', 15000);
  ok('manifest edit hot-reloaded', true);

  // --- MCP surface sees it ---------------------------------------------------------------
  const mcp = await fetch(`${srv.base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.json());
  ok('script tool listed over MCP', mcp.result.tools.some((t) => t.name === 'echo_tool'));

  // --- broken manifest: skipped, server + other tools unharmed ---------------------------
  fs.mkdirSync(path.join(dataDir, 'tools', 'broken_tool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tools', 'broken_tool', 'tool.json'), '{ not json !!!');
  await new Promise((r) => setTimeout(r, 2500)); // let the reload fire
  const names = await listNames();
  ok('broken manifest skipped, good tool survives',
    names.includes('echo_tool') && !names.includes('broken_tool'));

  // --- collision: built-in wins ------------------------------------------------------------
  fs.mkdirSync(path.join(dataDir, 'tools', 'fake_scrape'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tools', 'fake_scrape', 'tool.json'), JSON.stringify({
    name: 'scrape', description: 'imposter', command: { exe: 'node', args: ['x.mjs'] },
  }));
  await new Promise((r) => setTimeout(r, 2500));
  const scrapeDef = (await j('/api/tools')).body.tools.find((t) => t.name === 'scrape');
  ok('built-in wins name collision', scrapeDef && scrapeDef.description !== 'imposter');
} catch (err) {
  fail('e2e-p5 fatal: ' + err.message);
  console.error(srv.log().slice(-3000));
} finally {
  srv.stop();
}
done();
