#!/usr/bin/env node
// e2e P48 — the derived graph recall index over the fact store (Lyntai memory engine).
//
// `knowledge` stays the record of truth; the graph ranks it. What has to hold:
//   1. a remembered fact is indexed, and recall says which ranker answered
//   2. recall reports how well remembered each fact is, and what it is linked to
//   3. expand_fact opens a hit and reaches its neighbours — including material the query never matched
//   4. facts recalled TOGETHER become linked (the model-free half; no embedder involved)
//   5. the FTS fallback still answers when the index has nothing — an empty index must never read as
//      "the household knows nothing", which is a lie told on their own data
//   6. a backup import REBUILDS the index — every graph_ref in the archive addresses a node this
//      install never had, so without the rebuild recall silently falls through to FTS forever
//   7. an UPGRADE that moves the scope rebuilds too, including for a household with no layout marker
//      at all — the marker postdates the layout it names, so "no marker" IS the upgrade case
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p48');
const restoreDir = dataDirFor('p48-restore');
const { ok, fail, done } = makeReporter('p48');
makeTestData(dataDir);
makeTestData(restoreDir);

const PORT = 5498;
const RESTORE_PORT = 5499;
const UPGRADE_PORT = 5497;

let server = null;
let restoreServer = null;
let upgraded = null;

const remember = (c, kind, topic, content, confidence = 0.8) =>
  c.call('remember_fact', { kind, topic, content, source: `https://example.test/${encodeURIComponent(topic)}`, confidence });

try {
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  const base = `http://127.0.0.1:${PORT}`;
  await waitHealthy(base);
  const c = makeClient(base);

  // --- 1. the tools exist and a fact is indexed on the way in -------------------------------------
  const tools = await c.getJson('/api/tools');
  const names = (Array.isArray(tools) ? tools : tools.tools ?? []).map((t) => t.name);
  ok('expand_fact is registered', names.includes('expand_fact'), names.filter((n) => n.includes('fact')).join(','));

  // A tool the agent is never TOLD about stays unused while every other check passes — which is
  // exactly what happened here: the fact store had 16 entries and zero recalls because nothing in the
  // seeded knowledge base mentioned it. Assert the ROUTING, not just the registration.
  const seededClaudeMd = fs.readFileSync(path.join(dataDir, 'CLAUDE.md'), 'utf8');
  ok('the auto-loaded CLAUDE.md tells the agent the fact store exists',
    seededClaudeMd.includes('recall_facts') && seededClaudeMd.includes('remember_fact'),
    'CLAUDE.md is loaded every session — a tool absent from it is one the agent has no reason to reach for');
  const toolLoader = fs.readFileSync(
    path.join(dataDir, '.claude', 'skills', 'tool-loader', 'SKILL.md'), 'utf8');
  ok('the tool-loader routes a research task to recall_facts FIRST',
    toolLoader.includes('recall_facts') && /before you research|BEFORE researching|recall_facts \*\*FIRST\*\*/i.test(toolLoader),
    'the routing table is what turns a registered tool into a used one');

  const wrote = await remember(c, 'venue-url', 'harbour teahouse listing',
    'The harbour teahouse listing is verified at listing-id 4417 and open on weekends.');
  ok('remember_fact stores a fact', wrote.status === 200 && wrote.result?.ok === true, JSON.stringify(wrote.result));

  await remember(c, 'price', 'harbour teahouse set menu',
    'The harbour teahouse set menu was 2800 per head as checked on 2026-08-01.');
  await remember(c, 'policy', 'harbour teahouse booking policy',
    'The harbour teahouse holds a booking for fifteen minutes past the reserved time.');

  // --- 2. recall is answered by the graph, and says so --------------------------------------------
  const recalled = await c.call('recall_facts', { query: 'harbour teahouse', limit: 5 });
  const facts = recalled.result?.facts ?? [];
  ok('recall_facts returns the facts', facts.length >= 3, `got ${facts.length}`);
  ok('THE POINT: the graph index answered, not the FTS fallback', recalled.result?.ranked === 'graph',
    `ranked=${recalled.result?.ranked}`);
  // Pins the ASYMMETRIC fail-open: the stub judge cannot produce a parseable verdict, so nothing
  // was judged and `answered` must be ABSENT — never false. A future change mapping a failed judge
  // to false would tell the agent "nothing answered" on every CLI outage, with the fleet green.
  ok('answered is absent when nothing was judged (failed judge = null, never false)',
    !('answered' in recalled.result), JSON.stringify(recalled.result?.answered));
  ok('each hit carries a ref to expand', facts.every((f) => typeof f.ref === 'string' && f.ref.includes('#')),
    JSON.stringify(facts[0]));
  ok('each hit reports how well remembered it is',
    facts.every((f) => typeof f.retrievability === 'number' && f.retrievability > 0 && f.retrievability <= 1),
    facts.map((f) => f.retrievability).join(','));
  // The record of truth still owns provenance — the whole reason recall hydrates from `knowledge`
  // instead of answering out of the index.
  ok('a hit still carries its source and confidence from the record of truth',
    facts.every((f) => typeof f.source === 'string' && f.source.length > 0 && typeof f.confidence === 'number'),
    JSON.stringify(facts[0]));

  // --- 3 + 4. co-recall links them; expand reaches a neighbour ------------------------------------
  // Recalling the three together is what forms the edges — nothing was told they are related.
  await c.call('recall_facts', { query: 'harbour teahouse', limit: 5 });
  const afterCoRecall = await c.call('recall_facts', { query: 'harbour teahouse', limit: 5 });
  const linkedCount = (afterCoRecall.result?.facts ?? []).filter((f) => (f.linked ?? 0) > 0).length;
  ok('THE POINT: facts recalled together became linked, with no embedder', linkedCount > 0,
    `linked degrees: ${(afterCoRecall.result?.facts ?? []).map((f) => f.linked).join(',')}`);

  const top = (afterCoRecall.result?.facts ?? [])[0];
  const expanded = await c.call('expand_fact', { ref: top.ref });
  ok('expand_fact opens the fact', expanded.result?.ok === true, JSON.stringify(expanded.result).slice(0, 200));
  ok('expand_fact returns the full content', typeof expanded.result?.content === 'string'
    && expanded.result.content.length > 0, JSON.stringify(expanded.result?.content));
  ok('expand_fact reaches what it is linked to', (expanded.result?.linkedTopics ?? []).length > 0,
    JSON.stringify(expanded.result?.linkedTopics));

  // A ref that does not exist must be told apart from an index that is off — different next moves.
  const bogus = await c.call('expand_fact', { ref: 'facts/graph#999999' });
  ok('an unknown ref is refused, not faked', bogus.result?.ok === false, JSON.stringify(bogus.result));

  // --- 5. the FTS fallback still answers ----------------------------------------------------------
  // A query that matches a stored fact by keyword but that the graph has no entry for must still come
  // back. Nothing here is indexed under this topic, so the graph contributes nothing and FTS answers.
  const viaFts = await c.call('recall_facts', { query: 'fifteen minutes', limit: 5 });
  ok('a fact is still found when the graph does not rank it', (viaFts.result?.facts ?? []).length > 0,
    JSON.stringify(viaFts.result).slice(0, 200));

  // --- 5b. every fact shares ONE scope -----------------------------------------------------------
  // Asserted against the store, because no API response can show it and the cost of getting it wrong is
  // invisible. A vector collection is keyed {member}|{task}|{scope}, so putting each fact's KIND in the
  // scope — which reads like the obvious home for it — splits the embeddings per kind, and a recall
  // naming no kind then searches "facts/graph|facts|", which is empty. That is the default recall_facts
  // call, so meaning-based recall silently answered only the rare scoped ask while every check here
  // stayed green (this suite runs without an embedder and cannot see vectors at all). Kind filtering
  // never depended on scope: ByGraphRefsAsync applies it in SQL when it resolves refs to rows.
  const scopes = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'))
    .prepare("SELECT DISTINCT scope FROM lyntai_memory_node WHERE engine = 'facts/graph'").all()
    .map((r) => r.scope);
  ok('THE POINT: facts of different kinds share one scope, so an unscoped recall has somewhere to look',
    scopes.length === 1, `scopes=${JSON.stringify(scopes)} (3 kinds were written)`);

  // --- 5c. coverage is reported as STATE ----------------------------------------------------------
  // What the console shows instead of a history of rebuilds: how much of what the household knows is
  // actually searchable. A rebuild interrupted by a restart shows here as a shortfall and is repaired by
  // the next startup back-fill, so nothing needs to remember that a run once existed.
  const cov = (await c.getJson('/api/manage/memory'))?.localModel?.coverage;
  ok('the console can report index coverage, and it is complete after normal writes',
    cov && cov.total >= 3 && cov.indexed === cov.total, JSON.stringify(cov));

  // --- 6. a backup import rebuilds the index ------------------------------------------------------
  const zip = await fetch(`${base}/api/backup/export`);
  ok('backup exports', zip.status === 200, `status ${zip.status}`);
  const bytes = Buffer.from(await zip.arrayBuffer());
  const zipPath = path.join(dataDir, '..', '_p48-backup.zip');
  fs.writeFileSync(zipPath, bytes);

  restoreServer = startServer({ dataDir: restoreDir, port: RESTORE_PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  const restoreBase = `http://127.0.0.1:${RESTORE_PORT}`;
  await waitHealthy(restoreBase);
  const rc = makeClient(restoreBase);

  const imported = await fetch(`${restoreBase}/api/backup/import`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: bytes,
  });
  ok('backup imports into a fresh install', imported.status === 200, `status ${imported.status}`);

  const afterImport = await rc.call('recall_facts', { query: 'harbour teahouse', limit: 5 });
  const importedFacts = afterImport.result?.facts ?? [];
  ok('the facts survived the import', importedFacts.length >= 3, `got ${importedFacts.length}`);
  // The load-bearing one. The archive's graph_refs address nodes this install never had; without the
  // rebuild every one of them resolves to nothing and recall drops to FTS with no sign anything broke.
  ok('THE POINT: the index was REBUILT, so the graph still ranks after a restore',
    afterImport.result?.ranked === 'graph', `ranked=${afterImport.result?.ranked}`);
  ok('a rebuilt hit expands again', await (async () => {
    const e = await rc.call('expand_fact', { ref: importedFacts[0]?.ref });
    return e.result?.ok === true;
  })(), 'expand after restore');

  // --- 7. an UPGRADE re-reaches entries left at the old address -----------------------------------
  // The graph is addressed BY scope, so a release that moves the scope strands every existing entry:
  // nothing is corrupt, the entries are simply unreachable, and recall answers from the FTS floor with
  // no sign anything changed. FactIndexStep carries a layout marker and pays a one-off RebuildAsync.
  //
  // The trap this case exists for: a MISSING marker is not a fresh install. The marker did not exist
  // before the layout it describes, so every upgrading household arrives with no marker AND with facts
  // indexed at the old address — reading null as "fresh" skips the rebuild for exactly the population
  // that needs it. Simulated the only honest way: put the entries back at an old address and take the
  // marker away, which is the state such a household actually boots in.
  server.stop();
  server = null;
  const db = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'));
  db.prepare("UPDATE lyntai_memory_node SET scope = 'price' WHERE engine = 'facts/graph'").run();
  db.prepare("DELETE FROM app_config WHERE key = 'facts.index.layout'").run();
  const stranded = db.prepare(
    "SELECT COUNT(*) n FROM lyntai_memory_node WHERE engine = 'facts/graph' AND scope = 'price'").get().n;
  db.close();
  ok('(fixture) entries were moved to an old-layout address', stranded >= 3, `moved ${stranded}`);

  // A DIFFERENT port. Restarting on the one just released races the dying listener under load, and the
  // request lands on the instance on its way out — which reads as a feature failure, not a port reuse.
  upgraded = startServer({ dataDir, port: UPGRADE_PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  const upgradedBase = `http://127.0.0.1:${UPGRADE_PORT}`;
  await waitHealthy(upgradedBase);
  const uc = makeClient(upgradedBase);

  const afterUpgrade = await uc.call('recall_facts', { query: 'harbour teahouse', limit: 5 });
  ok('THE POINT: an upgrade with no marker still rebuilds, so the graph ranks again',
    afterUpgrade.result?.ranked === 'graph', `ranked=${afterUpgrade.result?.ranked}`);
  const afterScopes = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'))
    .prepare("SELECT DISTINCT scope FROM lyntai_memory_node WHERE engine = 'facts/graph'").all()
    .map((r) => r.scope);
  ok('and the entries moved to the current layout', afterScopes.length === 1 && afterScopes[0] !== 'price',
    `scopes=${JSON.stringify(afterScopes)}`);
} catch (err) {
  fail('e2e-p48 fatal: ' + (err?.stack || err?.message || String(err)));
} finally {
  try { server?.stop(); } catch {}
  try { restoreServer?.stop(); } catch {}
  try { upgraded?.stop(); } catch {}
}

done();
