#!/usr/bin/env node
// e2e P47 — every capability is DISCOVERABLE and INVOCABLE by the inner agent, and MCP servers
// survive a backup round trip.
//
// Two gaps this closes, both of which passed every other check:
//   1. p44 proves the agent's channel lists SOME tools. Nothing proved that each registered
//      capability reaches it — a tool present in /api/tools but absent from the channel is invisible
//      to the agent while the console shows it, which is exactly how "the tool is missing" reports
//      start. Nor that a listed tool can actually be CALLED through the channel: listing is metadata,
//      invocation is the wiring.
//   2. External MCP servers live in the mcp_server table, which the whole-install backup did not
//      carry. A restore came back complete in every visible way and silently without them — every
//      server re-added by hand, every interactive login redone.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p47');
const restoreDir = dataDirFor('p47-restore');
const { ok, fail, done } = makeReporter('p47');
makeTestData(dataDir);
makeTestData(restoreDir);

const PORT = 5494;
const RESTORE_PORT = 5496;
const settle = () => new Promise((r) => setTimeout(r, 1500));

// Speak to the agent's own loopback channel — the endpoint the spawned CLI is handed, not the
// public listener. Same shape p44 uses.
// ch.url already ENDS in /mcp — appending another one gets a 405, not a 404, which reads like a
// method problem rather than a path problem.
const rpc = async (ch, method, params) => {
  const res = await fetch(ch.url ?? `http://127.0.0.1:${ch.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ch.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let server = null;
let restore = null;
try {
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  const base = server.base ?? `http://127.0.0.1:${PORT}`;
  const { j, post } = makeClient(base);
  await waitHealthy(base, 60000);

  const ch = (await j('/api/manage/agent-mcp')).body;
  ok('the agent channel is up', (ch?.port ?? 0) > 0, JSON.stringify(ch));

  // --- 1. EVERY registered capability reaches the agent ---------------------------------------
  const registry = ((await j('/api/tools')).body?.tools ?? []).map((t) => t.name);
  ok('the registry exposes tools', registry.length > 0, String(registry.length));

  const listed = await rpc(ch, 'tools/list');
  const channelNames = (listed.body?.result?.tools ?? []).map((t) => t.name);
  ok('the channel answers tools/list', listed.status === 200 && channelNames.length > 0, String(listed.status));

  // The comparison that matters: set equality, not "both non-empty". A tool the console offers but
  // the agent cannot see is the failure this suite exists for.
  const missingFromAgent = registry.filter((n) => !channelNames.includes(n));
  const extraOnAgent = channelNames.filter((n) => !registry.includes(n));
  ok(`all ${registry.length} registered capabilities are visible to the agent`,
    missingFromAgent.length === 0, `missing: ${missingFromAgent.join(', ')}`);
  ok('and the agent sees nothing the registry does not expose',
    extraOnAgent.length === 0, `extra: ${extraOnAgent.join(', ')}`);

  // --- 2. every one of them is INVOCABLE through the channel ----------------------------------
  // Called with EMPTY arguments on purpose. A tool that needs a URL or a file will refuse — that is
  // fine and expected. What is asserted is that the CHANNEL carried the call and the tool answered:
  // a JSON-RPC result or a tool-level error, never a transport failure, a 404, or a hang. Inventing
  // valid arguments for thirty-odd tools would test the fixtures, not the wiring.
  const unreachable = [];
  const answered = [];
  for (const name of channelNames) {
    let r;
    try {
      r = await rpc(ch, 'tools/call', { name, arguments: {} });
    } catch (err) {
      unreachable.push(`${name}: threw ${err.message}`);
      continue;
    }
    if (r.status !== 200) { unreachable.push(`${name}: http ${r.status}`); continue; }
    // The registry answers an UNKNOWN tool with a normal result whose text says 未知工具 — so
    // "got a result" is not evidence of routing, and checking only that would have passed for a tool
    // the channel never reached. Routed means: not that message.
    const text = JSON.stringify(r.body ?? {});
    const notRouted = /未知工具/.test(text) || r.body?.error?.code === -32601;
    if (notRouted) { unreachable.push(`${name}: ${text.slice(0, 80)}`); continue; }
    answered.push(name);
  }
  ok(`all ${channelNames.length} capabilities answer a call through the channel`,
    unreachable.length === 0, unreachable.slice(0, 6).join(' | '));
  ok('and every one of them was actually exercised', answered.length === channelNames.length,
    `${answered.length}/${channelNames.length}`);

  // The negative control that gives the two rows above their meaning: a tool that does not exist is
  // NAMED as unknown rather than quietly accepted. (The registry answers it as a result carrying that
  // message rather than a JSON-RPC error — friendlier to a model, which is why the loop above tests
  // for the message rather than for the presence of a result.)
  const bogus = await rpc(ch, 'tools/call', { name: 'no_such_tool_at_all', arguments: {} });
  ok('a call to a tool that does not exist is refused as unknown',
    /未知工具/.test(JSON.stringify(bogus.body ?? {})), JSON.stringify(bogus.body).slice(0, 140));

  // --- 3. an external MCP server joins the same list ------------------------------------------
  // Added directly through the management API (the chat gate that normally does this is p32's job),
  // then it must appear to the AGENT like any platform tool — one registry, one channel.
  const stubServer = path.join(process.cwd(), 'devtools', 'scripts', 'mcp-stub-server.mjs');
  const added = await post('/api/manage/mcp-servers', {
    name: 'P47 Stub', transport: 'stdio',
    command: 'node', args: [stubServer], env: { STUB_TOKEN: 'p47-secret' }, enabled: true,
  });
  ok('an external MCP server can be added', added.status >= 200 && added.status < 300,
    `${added.status} ${JSON.stringify(added.body).slice(0, 140)}`);
  const servers = (await j('/api/manage/mcp-servers')).body ?? [];
  const stubId = servers.find((s) => s.name === 'P47 Stub')?.id;
  ok('it is listed with an id', !!stubId, JSON.stringify(servers).slice(0, 160));
  // Secrets are accepted on add and never handed back — the view says only that it HAS them.
  ok('its secret is held, not echoed', !JSON.stringify(servers).includes('p47-secret'),
    JSON.stringify(servers).slice(0, 160));

  const proxied = await until(async () => {
    const names = (await rpc(ch, 'tools/list')).body?.result?.tools?.map((t) => t.name) ?? [];
    return names.some((n) => !registry.includes(n)) ? names : null;
  }, 30000).catch(() => null);
  ok('the external server\'s tools reach the agent channel too', !!proxied,
    JSON.stringify(proxied ?? []).slice(0, 160));

  // --- 4. the backup carries MCP servers ------------------------------------------------------
  const exported = await fetch(`${base}/api/backup/export`);
  const zipBytes = Buffer.from(await exported.arrayBuffer());
  ok('backup exported', exported.ok && zipBytes.length > 0, `${exported.status} ${zipBytes.length}b`);

  restore = startServer({ dataDir: restoreDir, port: RESTORE_PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  const rBase = restore.base ?? `http://127.0.0.1:${RESTORE_PORT}`;
  const rc = makeClient(rBase);
  await waitHealthy(rBase, 60000);

  const before = (await rc.j('/api/manage/mcp-servers')).body ?? [];
  ok('the restore target starts with no MCP servers', (before.length ?? 0) === 0, JSON.stringify(before));

  const imported = await fetch(`${rBase}/api/backup/import`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: zipBytes,
  });
  const impBody = await imported.json().catch(() => null);
  ok('backup imported', imported.ok, `${imported.status} ${JSON.stringify(impBody).slice(0, 120)}`);
  ok('the import reports the MCP servers it restored', (impBody?.restored?.mcpServers ?? 0) >= 1,
    JSON.stringify(impBody?.restored));

  const after = (await rc.j('/api/manage/mcp-servers')).body ?? [];
  const restored = after.find?.((s) => s.id === stubId);
  ok('THE POINT: the MCP server survived the backup round trip', !!restored,
    JSON.stringify(after).slice(0, 200));
  ok('it came back with its command', restored?.command === 'node', String(restored?.command));
  // Status is connection state, not configuration — a restored server has not been reached yet, and
  // importing "connected" would have the console claim a live link to a process that does not exist.
  ok('it came back pending, not falsely connected', restored?.status !== 'connected', String(restored?.status));

  // --- 5. an OLD backup must not roll back the app-managed files ------------------------------
  // Import replaces .claude/ wholesale with the archive's copy. Anything the APP owns in there —
  // the scope guard (a security boundary), the UI contract, the form maps — is not user content but
  // derived from the app version, exactly like the plan index the import already rebuilds. Restoring
  // a backup taken by an older build therefore rolled them BACK, and EnsureFiles only runs at
  // startup, so the downgrade persisted for the rest of the session.
  //
  // Reproduced with a minimal hand-made archive rather than a fixture file, so the test states the
  // condition precisely: a valid backup whose .claude carries an ANCIENT guard and no UI contract.
  const guardPath = path.join(restoreDir, '.claude', 'hooks', 'scope-guard.mjs');
  const specPath = path.join(restoreDir, '.claude', 'ui-spec.md');
  const formPath = path.join(restoreDir, '.claude', 'forms', 'japan-visa-itinerary.json');
  const guardVersion = () => (fs.existsSync(guardPath)
    ? Number(/GUARD_VERSION:\s*(\d+)/.exec(fs.readFileSync(guardPath, 'utf8'))?.[1] ?? 0)
    : 0);
  const currentGuard = guardVersion();
  ok('the restore target is on the current guard before the old import', currentGuard >= 1, String(currentGuard));

  const oldZip = path.join(restoreDir, 'cache', '_p47-old-backup.zip');
  fs.mkdirSync(path.dirname(oldZip), { recursive: true });
  {
    // Minimal zip writer (stored, no compression) — avoids a dependency for a three-entry archive.
    const entries = [
      ['manifest.json', JSON.stringify({ gatherlightBackup: 1, createdAt: '2026-01-01T00:00:00Z', version: '0.0.1', files: 1 })],
      ['data/.claude/hooks/scope-guard.mjs', '// GUARD_VERSION: 1\n// an ancient guard: no WRITE_EXTS, no DENIED\n'],
      ['data/.claude/keep.md', 'household content that must survive\n'],
    ];
    const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const locals = [], central = []; let offset = 0;
    for (const [name, text] of entries) {
      const nb = Buffer.from(name, 'utf8'), db = Buffer.from(text, 'utf8'), crc = crc32(db);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 8);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22);
      lh.writeUInt16LE(nb.length, 26);
      locals.push(lh, nb, db);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 10);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(db.length, 20); ch.writeUInt32LE(db.length, 24);
      ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
      central.push(ch, nb);
      offset += lh.length + nb.length + db.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    fs.writeFileSync(oldZip, Buffer.concat([...locals, cd, end]));
  }

  const oldImport = await fetch(`${rBase}/api/backup/import`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: fs.readFileSync(oldZip),
  });
  ok('an older backup imports', oldImport.ok, String(oldImport.status));

  ok('the household content in it was restored', fs.existsSync(path.join(restoreDir, '.claude', 'keep.md')));
  const guardAfter = guardVersion();
  ok('THE POINT: the scope guard was NOT rolled back by the restore', guardAfter >= currentGuard,
    `guard is v${guardAfter}, app ships v${currentGuard}`);
  ok('the UI contract survives the restore', fs.existsSync(specPath));
  ok('the form map survives the restore', fs.existsSync(formPath));

  // The visible symptom this was found through: a visa PDF could not be generated after a restore.
  const afterImportTools = makeClient(rBase);
  const fill = await afterImportTools.call('fill_itinerary', {
    templatePath: 'uploads/none.pdf', dataPath: 'uploads/none.json', outPath: 'uploads/none-out.pdf',
  });
  ok('fill_itinerary no longer fails for a MISSING FORM MAP after a restore',
    !/找不到表单映射文件/.test(JSON.stringify(fill.result ?? {})), JSON.stringify(fill.result).slice(0, 160));
} catch (err) {
  fail('e2e-p47 fatal: ' + err.message);
  console.error((server?.log?.() ?? '').slice(-2500));
} finally {
  try { server?.stop(); } catch {}
  try { restore?.stop(); } catch {}
}
done();
