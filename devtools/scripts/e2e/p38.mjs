#!/usr/bin/env node
// e2e P38 — capability enforcement + a real sandbox-escape battery (S2a). A hot-loaded script tool
// is invisible and refused while absent from site.json's capabilities.enabled, appears once a human
// enables it with an explicit fs/net grant, and — while enabled — is contained by node --permission
// plus the cap-guard.mjs network preload. Every denial the battery asserts is a genuine attempt
// paired with a positive control (readGranted/writeCache, and a net:true re-grant that flips the
// network verdicts), so a launcher that denies everything or never spawns the process cannot pass.
// This is the evidence behind the S2b household-facing promise: "it can read your plans and save to
// scratch; it cannot reach the internet, change your settings, or touch anything else."
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataDir = dataDirFor('p38');
const { ok, fail, done } = makeReporter('p38');
makeTestData(dataDir);

// Free ports — not used by any other suite (checked against every `startServer({ port: ... })` /
// `const PORT = ...` in devtools/scripts/e2e/*.mjs; p37 is the closest neighbour at 5464/5465).
const PORT_NOT_ENABLED = 5466;
const PORT_ENABLED = 5467;
const PORT_NET_TRUE = 5468;
const PORT_DENY = 5469;

const toolDir = path.join(dataDir, 'tools', 'cap_escape');
const manifestPath = path.join(dataDir, 'site.json');
const settle = () => new Promise((r) => setTimeout(r, 800));

// --- the fixture capability: written directly into the test data folder's tools/ dir, the same
// convention e2e-p5 uses for its hand-authored manifests (broken_tool, fake_scrape) — no separate
// fixtures directory exists for script tools, and inventing one here would diverge from that. -----
fs.mkdirSync(toolDir, { recursive: true });
fs.writeFileSync(path.join(toolDir, 'tool.json'), JSON.stringify({
  name: 'cap_escape',
  description: 'e2e fixture — probes the capability sandbox from inside',
  inputSchema: {
    type: 'object',
    properties: { site: { type: 'string', description: 'absolute path to the site data folder' } },
    required: ['site'],
  },
  command: { exe: 'node', args: ['run.mjs'] },
  timeoutSeconds: 30,
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(toolDir, 'run.mjs'), `#!/usr/bin/env node
// A capability that genuinely tries to escape its sandbox. Each probe reports allowed/blocked and
// the suite asserts the expected verdict for EACH — including the positive controls, so a launcher
// that denied everything, or never ran the process, cannot pass.
import fs from 'node:fs';
let input = ''; for await (const c of process.stdin) input += c;
const args = JSON.parse(input || '{}');
const site = args.site;

const probe = async (fn) => { try { await fn(); return 'allowed'; } catch { return 'blocked'; } };

const out = {
  readGranted:  await probe(() => fs.readFileSync(\`\${site}/plans/trips/2026-08-kyoto.md\`, 'utf8')),
  writeCache:   await probe(() => fs.writeFileSync(\`\${site}/cache/probe.txt\`, 'x')),
  readState:    await probe(() => fs.readFileSync(\`\${site}/state/gatherlight.db\`)),
  writeRecords: await probe(() => fs.writeFileSync(\`\${site}/plans/evil.md\`, 'x')),
  spawn:        await probe(async () => { const cp = await import('node:child_process');
                                          const r = cp.spawnSync(process.execPath, ['-e', '1']);
                                          if (r.error) throw r.error; }),
  worker:       await probe(async () => { const w = await import('node:worker_threads');
                                          new w.Worker('', { eval: true }); }),
  // Network probes make NO round trip. The question is whether the capability can OBTAIN the
  // ability to reach the network; whether a socket then connects depends on the machine, and a
  // suite that needs the internet fails for the wrong reasons.
  fetchAvailable: typeof globalThis.fetch === 'function',
  netModule:    await probe(async () => { await import('node:net'); }),
  netBare:      await probe(async () => { await import('net'); }),
  httpModule:   await probe(async () => { await import('node:http'); }),
};
process.stdout.write(JSON.stringify(out));
`, 'utf8');

// Full-manifest read/mutate/write, mirroring e2e-p37's manifest rewrite — preserves every field the
// startup migration already wrote (template/agent/records/ui), touching only capabilities.
const patchManifest = (mutate) => {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  mutate(m);
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
};

const listNames = async (client) => ((await client.j('/api/tools')).body?.tools ?? []).map((t) => t.name);

let srv = null;
try {
  // --- 1: not enabled -> not registered ------------------------------------------------------
  srv = startServer({ dataDir, port: PORT_NOT_ENABLED });
  await waitHealthy(srv.base);
  let client = makeClient(srv.base);

  ok('site.json exists after first boot', fs.existsSync(manifestPath));
  const names1 = await listNames(client);
  ok('not enabled -> absent from GET /api/tools', !names1.includes('cap_escape'), JSON.stringify(names1));
  ok('platform tool present even though nothing is enabled (provenance, not enablement)',
    names1.includes('pdf_inspect'), JSON.stringify(names1));

  const call1 = await client.call('cap_escape', { site: dataDir });
  ok('calling a not-enabled capability is refused (4xx)',
    call1.status >= 400 && call1.status < 500, JSON.stringify(call1));

  srv.stop();
  srv = null;
  await settle();

  // --- 2: enabled -> registered, then the battery ---------------------------------------------
  patchManifest((m) => {
    m.capabilities.enabled.push({ id: 'cap_escape', fs: { read: ['plans'], write: ['cache'] }, net: false });
  });

  srv = startServer({ dataDir, port: PORT_ENABLED });
  await waitHealthy(srv.base);
  client = makeClient(srv.base);

  const names2 = await listNames(client);
  ok('enabled -> present in GET /api/tools', names2.includes('cap_escape'), JSON.stringify(names2));
  ok('platform tool still present', names2.includes('pdf_inspect'), JSON.stringify(names2));

  const battery = await client.call('cap_escape', { site: dataDir });
  ok('battery call succeeded (200)', battery.status === 200, JSON.stringify(battery));
  const v = battery.result ?? {};
  console.log('  battery verdict:', JSON.stringify(v));

  ok('readGranted = allowed (positive control — declared fs.read)', v.readGranted === 'allowed', v.readGranted);
  ok('writeCache = allowed (positive control — declared fs.write)', v.writeCache === 'allowed', v.writeCache);
  ok('readState = blocked (platform state/ outside any grant)', v.readState === 'blocked', v.readState);
  ok('writeRecords = blocked (plans/ granted read-only, not write)', v.writeRecords === 'blocked', v.writeRecords);
  ok('spawn = blocked (node --permission denies child_process spawn)', v.spawn === 'blocked', v.spawn);
  ok('worker = blocked (node --permission denies worker_threads)', v.worker === 'blocked', v.worker);
  ok('fetchAvailable = false (net:false — cap-guard.mjs deleted fetch)', v.fetchAvailable === false, v.fetchAvailable);
  ok('netModule = blocked (net:false — cap-guard.mjs blocks node:net)', v.netModule === 'blocked', v.netModule);
  ok('netBare = blocked (net:false — cap-guard.mjs blocks bare "net")', v.netBare === 'blocked', v.netBare);
  ok('httpModule = blocked (net:false — cap-guard.mjs blocks node:http)', v.httpModule === 'blocked', v.httpModule);

  srv.stop();
  srv = null;
  await settle();

  // --- 3: the net grant is real ------------------------------------------------------------------
  patchManifest((m) => {
    const g = m.capabilities.enabled.find((e) => e.id === 'cap_escape');
    g.net = true;
  });

  srv = startServer({ dataDir, port: PORT_NET_TRUE });
  await waitHealthy(srv.base);
  client = makeClient(srv.base);

  ok('platform tool present under net:true too', (await listNames(client)).includes('pdf_inspect'));

  const netBattery = await client.call('cap_escape', { site: dataDir });
  ok('net:true battery call succeeded (200)', netBattery.status === 200, JSON.stringify(netBattery));
  const v2 = netBattery.result ?? {};
  console.log('  net:true battery verdict:', JSON.stringify(v2));

  ok('net:true -> fetchAvailable = true (fetch survives — no preload was imported)',
    v2.fetchAvailable === true, v2.fetchAvailable);
  ok('net:true -> netModule = allowed (node:net import no longer blocked)',
    v2.netModule === 'allowed', v2.netModule);
  ok('net:true -> netBare = allowed', v2.netBare === 'allowed', v2.netBare);
  ok('net:true -> httpModule = allowed', v2.httpModule === 'allowed', v2.httpModule);
  // The fs verdicts are untouched by the net flag — same grant, same jail on that axis.
  ok('net:true -> readGranted still allowed (fs grant unchanged)', v2.readGranted === 'allowed', v2.readGranted);
  ok('net:true -> writeRecords still blocked (fs grant unchanged)', v2.writeRecords === 'blocked', v2.writeRecords);

  srv.stop();
  srv = null;
  await settle();

  // --- 4: deny beats enabled -----------------------------------------------------------------------
  patchManifest((m) => {
    m.capabilities.deny.push('cap_escape'); // still present in enabled — deny must win anyway
  });

  srv = startServer({ dataDir, port: PORT_DENY });
  await waitHealthy(srv.base);
  client = makeClient(srv.base);

  const names4 = await listNames(client);
  ok('deny (while still enabled) -> absent again from GET /api/tools',
    !names4.includes('cap_escape'), JSON.stringify(names4));
  ok('platform tool present throughout deny', names4.includes('pdf_inspect'), JSON.stringify(names4));

  const call4 = await client.call('cap_escape', { site: dataDir });
  ok('calling a denied capability is refused (4xx)',
    call4.status >= 400 && call4.status < 500, JSON.stringify(call4));
} catch (err) {
  fail('e2e-p38 fatal: ' + err.message);
  console.error(srv?.log?.().slice(-3000) ?? '');
} finally {
  try { srv?.stop(); } catch {}
}
done();
