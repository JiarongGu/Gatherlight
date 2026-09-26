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
//   8. …but an upgrade that moved only the VECTORS (Lyntai 3.2's collection address) does NOT rebuild an
//      install with no embedder: nothing there reads a vector, and a rebuild would erase decay and links
//   9. an EDITED fact whose re-index fails — and one edited by the memory import, which never indexes — keeps
//      no ref to its previous content's node, so the next start's back-fill indexes the NEW content
//  10. a back-fill never runs BESIDE a rebuild: a memory import landing while a backup import rebuilds starts a
//      detached back-fill, which waits for the rebuild and then indexes only what is still unindexed — rather than
//      reading every fact the rebuild had just detached as pending and annotating each a second time
//  11. a SINGLE write racing a rebuild leaves no stale ref: a remember_fact held open across a backup import's rebuild
//      does not put back the ref it read (a node the rebuild forgot), and an edit landing after the rebuild's snapshot
//      is not overwritten by the ref of the content it replaced — both ref writes are conditional
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
const VECTOR_MOVE_PORT = 5495;
const BACKFILL_PORT = 5512;
const RACE_PORT = 5513;

/** A fact whose content carries this marker is never annotated by the stub while the server runs with
 *  GATHERLIGHT_STUB_HANG_ANNOTATION set to it — case 9's failing re-index. */
const HANG = 'zzhangindex';

/** A fact whose content carries this marker takes 6 s to annotate while the server runs with
 *  GATHERLIGHT_STUB_SLOW_ANNOTATION set to it — case 10's rebuild, kept in progress. */
const SLOW = 'zzslowindex';

/** A fact whose content carries this marker has ONE annotation held open (30 s) while the race server runs with
 *  GATHERLIGHT_STUB_HANG_ONCE_FILE: the one that creates the claim file — case 11's single write. */
const HANG_ONCE = 'zzhangonce';

let server = null;
let restoreServer = null;
let upgraded = null;
let vectorMove = null;
let backfill = null;
let race = null;

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
  // The usage counter has a READER now. It was incremented on every recall and consumed by nothing —
  // not the ranking, not this projection, not the client — which is the "bought and never consulted"
  // shape one level down from the embedding at SemanticSeedK 0. It earns its place on rows matched by
  // TEXT or SUBJECT, which carry no retrievability and would otherwise have no usage signal at all.
  ok('a hit reports how much use the fact actually gets',
    facts.every((f) => typeof f.used === 'number'),
    JSON.stringify(facts.map((f) => f.used)));
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
  // Read off the SEMANTIC layer's row: 记忆检索 is layers[] now, each with its own backend and model.
  const cov = ((await c.getJson('/api/manage/memory'))?.layers ?? [])
    .find((l) => l.id === 'semantic')?.coverage;
  ok('the console can report index coverage, and it is complete after normal writes',
    cov && cov.total >= 3 && cov.indexed === cov.total, JSON.stringify(cov));

  // --- N. PHRASINGS LAND ON THE FACT THEY CAME FROM -----------------------------------------------
  //
  // The 语义 CLI arm expands each fact at write time and stores the wordings in `knowledge.aka`, which the
  // trigram index searches. The first version found the row it had just written by SEARCHING for its topic
  // — RecallAsync(topic), full-text, ordered by CONFIDENCE — so it could attach one fact's phrasings to a
  // different fact. Phrasings on the wrong fact are worse than none: an unrelated fact starts answering a
  // question it has nothing to do with, and nothing reports it.
  //
  // This repro is built to make the old code fail deterministically rather than by luck:
  //   · the second topic is TWO characters, so FtsQuery drops it and recall falls back to LIKE %..%
  //   · the first topic CONTAINS the second as a substring, so that LIKE matches both rows
  //   · the first fact has the higher confidence, and the fallback orders by confidence DESC
  // so the old lookup would have returned fact ONE while writing fact TWO.
  const bindRephrase = await fetch(`${base}/api/manage/memory/layer/semantic`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'claude-cli', model: 'haiku' }),
  });
  ok('(setup) 语义 binds to the CLI rephrasing arm', bindRephrase.status === 200, String(bindRephrase.status));

  await remember(c, 'pet', '猫粮偏好', '家里的猫只吃鱼味罐头,不碰鸡肉味的。', 0.95);
  await remember(c, 'pet', '猫粮', '猫粮放在玄关的柜子里。', 0.30);

  const akaDb = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'));
  const akaRows = akaDb.prepare(
    "SELECT topic, COALESCE(aka,'') AS aka FROM knowledge WHERE kind = 'pet' ORDER BY topic").all();
  const akaOf = (t) => akaRows.find((r) => r.topic === t)?.aka ?? '';

  // The stub answers every prompt, so if NOTHING came back the seam is broken rather than the routing —
  // say which, instead of reporting a routing failure for a plumbing one.
  const anyExpanded = akaRows.some((r) => r.aka.length > 0);
  ok('the CLI arm expands a fact on write, storing other wordings beside it',
    anyExpanded, JSON.stringify(akaRows));

  if (anyExpanded) {
    // THE ASSERTION. Under the old lookup the second write would have overwritten the FIRST row and left
    // its own empty — so "both rows carry their own" is exactly the discriminator.
    // THE ASSERTION: BOTH rows carry phrasings. Under the old lookup the second write would have resolved
    // to the FIRST row (two-character topic → no FTS token → LIKE %猫粮% matches both → ordered by
    // confidence, and fact one is 0.95 against 0.30), overwriting that row and leaving its own empty.
    //
    // Deliberately NOT asserting the two differ: the claude stub answers every prompt with the same canned
    // text, so content cannot discriminate here and an inequality check would be asserting the stub. What
    // it CAN prove is which ROW each write reached, which is precisely what was broken.
    ok('and each fact keeps its OWN phrasings — the second write cannot land on the first row',
      akaOf('猫粮').length > 0 && akaOf('猫粮偏好').length > 0,
      JSON.stringify(akaRows.map((r) => [r.topic, r.aka.length])));
  }
  akaDb.close();

  // BACKFILL: binding the arm must reach facts that ALREADY EXISTED.
  //
  // The harbour facts were written at the top of this suite, before 语义 was bound to anything, so they
  // carry no phrasings. Rebuilding is the only control the product offers for that — and for this arm it
  // used to be a silent no-op: ReindexSemanticAsync guarded on `_semantic`, which is non-null only when an
  // EMBEDDER was registered, and the CLI arm registers nothing by design. So the endpoint accepted, the
  // detached run "finished", and an existing knowledge base could never gain phrasings. The layer applied
  // to future writes only, which is not what binding it says.
  const akaOfTopic = (t) => {
    const db = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'));
    try {
      return db.prepare("SELECT COALESCE(aka,'') AS aka FROM knowledge WHERE topic = ?").get(t)?.aka ?? '';
    } finally { db.close(); }
  };
  ok('(fixture) a fact written BEFORE the binding has no phrasings',
    akaOfTopic('harbour teahouse listing') === '', JSON.stringify(akaOfTopic('harbour teahouse listing')));

  const reindex = await fetch(`${base}/api/manage/memory/layer/semantic/reindex`, { method: 'POST' });
  ok('a rebuild is accepted for the rephrasing arm', reindex.status === 202 || reindex.status === 200,
    String(reindex.status));

  let backfilled = '';
  for (let i = 0; i < 60; i++) {
    backfilled = akaOfTopic('harbour teahouse listing');
    if (backfilled.length > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  ok('THE POINT: rebuilding reaches the facts that predate the binding',
    backfilled.length > 0, JSON.stringify(backfilled));

  // ...AND IT COSTS NOTHING TO DO SO. The rephrasing arm writes a knowledge COLUMN; nothing of it lives in
  // the graph. Routing it through the destructive rebuild — which the first version did — discarded every
  // decay position and link the household had accumulated in exchange for nothing, and made "bind it, then
  // rebuild" advice with a hidden price. `linked` is the observable: the co-recall section above built
  // those edges, and a rebuild resets them to zero.
  const linkedAfter = (await c.call('recall_facts', { query: 'harbour teahouse', limit: 5 }))
    .result?.facts?.filter((f) => (f.linked ?? 0) > 0).length ?? 0;
  ok('…and the graph kept its links — the phrasing backfill is not a rebuild',
    linkedAfter > 0, `facts still linked: ${linkedAfter}`);

  // STORED IS NOT FOUND. Everything above proves phrasings were WRITTEN; none of it proves they can be
  // reached, which is the only thing this layer is for. `zzfishpref` appears in no fact's text — only in
  // the phrasings — so a hit can have come from nowhere else.
  //
  // This is the seam where the arm could be silently inert: recall tries the GRAPH first, and the graph
  // indexes the fact's content, which never contained the phrasings. `aka` lives in the FTS table, and
  // MemoryTools falls back to FTS only when the graph resolved NOTHING. So the phrasings are consulted
  // exactly when the graph abstains — and if the graph answers with something irrelevant instead, they
  // are never consulted at all.
  const viaPhrase = await c.call('recall_facts', { query: 'zzfishpref', limit: 5 });
  const phraseTopics = (viaPhrase.result?.facts ?? []).map((f) => f.topic);
  ok('THE POINT: a wording that exists ONLY in the stored phrasings finds the fact',
    phraseTopics.includes('猫粮偏好'),
    `ranked=${viaPhrase.result?.ranked} topics=${JSON.stringify(phraseTopics)}`);

  // …and it finds the RIGHT one. The other fact carries its own distinct phrasing, so a hit on both would
  // mean the phrasings are being matched loosely enough to be worthless.
  ok('and the other fact, with its own phrasings, is not dragged along',
    !phraseTopics.includes('猫粮'), JSON.stringify(phraseTopics));
  // A DIFFERENT LANGUAGE REACHES THE FACT. This is the layer's actual purpose and it was not being
  // served: the rephrase prompt offered 另一种语言的常见叫法 as one of three options, the model always
  // chose same-language synonyms, and a household writing in Chinese and asking in English got nothing
  // from a feature costing a model call per fact. The prompt now REQUIRES a line in another language;
  // this asserts the retrieval half, which is the half that can silently rot.
  const viaEnglish = await c.call('recall_facts', { query: 'zzseafood tins', limit: 5 });
  ok('THE POINT: an English query reaches a fact whose text is entirely Chinese',
    (viaEnglish.result?.facts ?? []).some((f) => f.topic === '猫粮偏好'),
    JSON.stringify((viaEnglish.result?.facts ?? []).map((f) => f.topic)));

  // …AND IT SURVIVES THE GRAPH ANSWERING SOMETHING ELSE. This is the assertion that matters most for
  // this layer, and it FAILED when written: `harbour` matches three unrelated facts lexically, the graph
  // therefore resolved a full answer, and FTS — the only index that holds `aka` — used to run solely when
  // the graph resolved NOTHING. So a household's paid-for phrasings were reachable only by a query that
  // matched nothing else at all, which is a much narrower promise than the layer makes.
  //
  // The first version of this probe was vacuous and passed: it used `猫粮`, which matches 猫粮偏好's own
  // TOPIC, so the graph found the fact lexically and the phrasing was never needed. The lexical term has
  // to match an UNRELATED fact for the question to be asked at all.
  const mixed = await c.call('recall_facts', { query: 'zzfishpref harbour', limit: 5 });
  ok('a phrasing still wins when the query ALSO matches unrelated facts lexically',
    (mixed.result?.facts ?? []).map((f) => f.topic).includes('猫粮偏好'),
    `ranked=${mixed.result?.ranked} topics=${JSON.stringify((mixed.result?.facts ?? []).map((f) => f.topic))}`);

  // Put the layer back as it was, so later cases in this suite see the state they expect.
  await fetch(`${base}/api/manage/memory/layer/semantic/off`, { method: 'POST' });

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


  // ---- A VERDICT REACHES THE ORDERING ----------------------------------------------------------
  //
  // The panel tells the household that facts the judge marks as answering rank higher. A clause with no
  // enforcement behind it is a defect, so this holds Lyntai to it — and it is a CANARY rather than a test
  // of our code: if a release stops the verdict reaching the ordering, that sentence silently becomes a
  // false promise and nothing else would notice.
  //
  // ONE CALL, with the baseline taken from inside it. The stub records the numbered notes it was shown,
  // which is the engine's ranking BEFORE the verdict is applied, then endorses the LAST of them. Four
  // earlier fixtures were vacuous because they tried to establish a baseline with a SECOND recall — and
  // recall reinforces what it returns, so the control call moves the very ranking it was meant to measure.
  try { fs.unlinkSync(path.join(process.cwd(), 'devtools', '_stub-verdict.txt')); } catch {}
  const verdictPage = (await uc.call('recall_facts', { query: 'harbour teahouse zzjudge', limit: 6 }))
    .result?.facts ?? [];
  const shown = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'devtools', '_stub-verdict.txt'), 'utf8') || '[]');

  ok('(fixture) the judge saw several candidates and endorsed the last of them',
    shown.length >= 2 && verdictPage.length >= 2, JSON.stringify({ shown, page: verdictPage.map((f) => f.topic) }));

  // THE JUDGE SEES THE FACT, NOT ITS LABEL. Lyntai's LLM verifier renders `{n}. {Headline}` by default, and the
  // fact index writes each fact's TOPIC as its headline — so the judge used to decide "did this answer?" from
  // topics alone. JudgeWiring.Llm sets Lyntai's ContentChars, which shows each candidate's content instead (an
  // app-side decorator did it until 2026-09-27). `listing-id 4417` exists only in the content of one fact, so its
  // presence in the notes is proof the content arrived.
  ok('the judge is shown the facts’ CONTENT, not only their topics',
    shown.some((n) => n.includes('listing-id 4417')), JSON.stringify(shown));
  // …AND THE CONTENT ALONE, NOT "topic — content". The booking fact's topic says `policy`, a word no fact's content
  // holds, so a note carrying it can only have come from a topic. Content alone was measured equivalent to "topic —
  // content" for the Claude judge (docs/judge-bench.md Run 1) with ~24% less text, and it is what ContentChars renders:
  // with ContentChars left at 0 the notes are the topics (`policy` present, `fifteen minutes` absent), and under the
  // old decorator's `both` mode they carried both.
  ok('THE POINT: the judge is shown each fact’s content ALONE — the booking fact’s content arrives, its topic does not',
    shown.some((n) => n.includes('fifteen minutes past the reserved time')) && !shown.some((n) => /\bpolicy\b/.test(n)),
    JSON.stringify(shown));

  ok('THE POINT: the endorsed candidate was NOT top of the pre-verdict ranking',
    shown[shown.length - 1] !== shown[0], JSON.stringify(shown));

  // The endorsed note carries the fact's content in every rendering (topic — content, or content alone),
  // so it is matched by the content of the page's top row.
  ok('...and it comes back at the top of the page',
    !!verdictPage[0]?.content && String(shown[shown.length - 1] ?? '').includes(verdictPage[0].content),
    JSON.stringify({ endorsed: shown[shown.length - 1], page: verdictPage.map((f) => f.topic) }));

  // A LONG CHINESE NOTE WITH AN EARLY SPACE IS READ PAST IT. ContentChars cuts content longer than 400 characters, and
  // through Lyntai 3.4.0 it cut at the LAST space at or before the cap however early — so a Chinese note whose only
  // spaces follow a leading English name reached the judge as that name and "…". 3.5.0 (its Part 302) takes a space
  // only in the cap's latter half, else cuts at the last text-element boundary, which is what this note needs: its
  // three spaces all sit in its first 30 characters, and the rest is 480 characters of Chinese with none.
  const longNote = `harbour teahouse zzlongnote ${'茶馆的包间要提前一天预订,周末人多时最好提前三天,靠窗的位置要单独说明。'.repeat(20)}`.slice(0, 508);
  await remember(uc, 'venue-note', 'harbour teahouse private room notes', longNote);
  try { fs.unlinkSync(path.join(process.cwd(), 'devtools', '_stub-verdict.txt')); } catch {}
  await uc.call('recall_facts', { query: 'harbour teahouse zzjudge', limit: 6 });
  const shownLong = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'devtools', '_stub-verdict.txt'), 'utf8') || '[]');
  const longLine = shownLong.find((n) => n.startsWith('harbour teahouse zzlongnote')) ?? null;
  ok('(fixture) the long note is over the 400-character cap, with its only spaces in its first 30 characters',
    longNote.length > 400 && longNote.lastIndexOf(' ') < 30, `length ${longNote.length}, last space at ${longNote.lastIndexOf(' ')}`);
  ok('THE POINT: a long Chinese note with an early space reaches the judge with at least half the cap of its content, cut and marked',
    !!longLine && longLine.endsWith('…') && longLine.length - 1 >= 200 && longLine.length - 1 <= 400
      && longNote.startsWith(longLine.slice(0, -1)),
    JSON.stringify({ length: longLine?.length ?? null, line: longLine }));

  // ---- SUBJECT HANDLES ARE SEARCHABLE ----------------------------------------------------------
  //
  // With 判断 on, every write is annotated and its subjects — stable handles naming what the fact is
  // ABOUT — are recorded. They used to be read by exactly two things, both at WRITE time: linking two
  // facts, and prompting the annotator to reuse a handle. No recall path touched them, so the household
  // paid a model call for them and could never search them.
  //
  // The handles here appear in NO fact's text (the stub answers the annotation prompt with words the
  // content does not contain). That is what makes this test mean something: lexical recall cannot
  // produce these hits, so if the fact comes back, the subject lookup is the only thing that found it.
  await remember(uc, 'household', 'partner celebration date', '伴侣的生日在春天,通常在家里过。');
  await remember(uc, 'household', 'document renewal', '旅行证件下个月到期,要提前去换。');

  // NON-VACUITY, and the assertion that would have caught the whole feature being inert: prove the
  // annotation actually RAN and stored handles. Without this, every check below could pass by the
  // fallback path returning something plausible for an unrelated reason.
  const subjectRows = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'))
    .prepare("SELECT subject FROM lyntai_memory_subject WHERE engine = 'facts/graph'").all()
    .map((r) => r.subject);
  ok('the annotation recorded subject handles for the new facts',
    subjectRows.includes('pairbond') && subjectRows.includes('paperwork'),
    JSON.stringify(subjectRows));

  // …and NONE of them is a word the facts actually say, so a hit below cannot come from the text.
  const partnerText = '伴侣的生日在春天,通常在家里过。';
  ok('the handles are absent from the fact text — so lexical recall cannot produce them',
    !partnerText.includes('pairbond') && !partnerText.includes('paperwork'), partnerText);

  const bySubject = await uc.call('recall_facts', { query: 'pairbond', limit: 5 });
  const subjHits = bySubject.result?.facts ?? [];
  ok('THE POINT: a query naming a subject handle finds the fact whose text never says it',
    subjHits.some((f) => f.topic === 'partner celebration date'),
    JSON.stringify(subjHits.map((f) => f.topic)));

  // The ENGINE found it, and ranked it like any other candidate. Until Lyntai 3.1 this lookup was ours,
  // appended after the ranking with no measurement at all — so it was flagged matched:"subject" and its
  // retrievability withheld rather than printed as a false 0.0. Since 3.1 the engine seeds recall from the
  // handles itself (SubjectSeedSource), so the hit carries a REAL retrievability; the app-side append is
  // deleted, and a leftover flag here would mean it came back.
  const partnerHit = subjHits.find((f) => f.topic === 'partner celebration date');
  ok('…as an ordinary RANKED hit, with a measured retrievability (the engine subject channel, not an append)',
    partnerHit?.matched === undefined && typeof partnerHit?.retrievability === 'number',
    JSON.stringify(partnerHit));

  // SELECTIVITY. A handle is not a wildcard: the other annotated fact carries a different one and must
  // stay out. Without this the feature could "pass" by appending every annotated fact to every recall.
  ok('a handle pulls in ITS facts, not every annotated fact',
    !subjHits.some((f) => f.topic === 'document renewal'),
    JSON.stringify(subjHits.map((f) => f.topic)));

  // A HANDLE MUST BE NAMED, NOT MERELY SPELLED. An ASCII handle needs a word boundary: `pairbond` sits
  // inside `repairbonded`, and a household asking about one thing must not be handed a fact about
  // another because its handle happens to be a substring. (CJK handles keep plain substring matching —
  // Chinese has no spaces to anchor to, the same reason this product's FTS is trigram.)
  const spurious = await uc.call('recall_facts', { query: 'repairbonded surfaces', limit: 5 });
  ok('a handle spelled INSIDE a longer word does not count as naming it',
    !(spurious.result?.facts ?? []).some((f) => f.topic === 'partner celebration date'),
    JSON.stringify((spurious.result?.facts ?? []).map((f) => f.topic)));

  // A handle-free query is untouched: subject candidates enter the rank fusion only when the query names
  // a handle, so an ordinary recall still leads with a graph-ranked, measured hit.
  const stillRanked = await uc.call('recall_facts', { query: 'harbour teahouse', limit: 5 });
  const stillTop = (stillRanked.result?.facts ?? [])[0];
  ok('an ordinary ranked recall is unchanged — the addition cannot displace a better hit',
    stillRanked.result?.ranked === 'graph' && stillTop?.matched === undefined
      && typeof stillTop?.retrievability === 'number',
    JSON.stringify({ ranked: stillRanked.result?.ranked, top: stillTop?.topic, m: stillTop?.matched }));

  // --- 8. a VECTORS-ONLY layout move leaves an embedder-less graph alone ----------------------------
  // Lyntai 3.2 changed the vector collection address, orphaning vectors written before it. That strands
  // semantic recall — but only on an install that HAS an embedder; this fixture has none, so nothing here
  // reads a vector and nothing was stranded. Rebuilding anyway would throw away every decay position and
  // link for no gain. Case 7 is the positive control: an older layout DOES rebuild. The embedder branch
  // itself is not drivable here (the suite runs with no local model), and is stated as a gap.
  upgraded.stop();
  upgraded = null;
  const vdb = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'));
  const nodeIds = () => vdb.prepare(
    "SELECT id FROM lyntai_memory_node WHERE engine = 'facts/graph' ORDER BY id").all().map((r) => r.id).join(',');
  const idsBefore = nodeIds();
  vdb.prepare("UPDATE app_config SET value = '2' WHERE key = 'facts.index.layout'").run();
  ok('(fixture) the marker names the pre-3.2 layout',
    vdb.prepare("SELECT value FROM app_config WHERE key = 'facts.index.layout'").get()?.value === '2');

  // The hang marker is case 9's; no fact before case 9 carries it, so case 8 sees an ordinary server.
  vectorMove = startServer({ dataDir, port: VECTOR_MOVE_PORT,
    env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_HANG_ANNOTATION: HANG } });
  await waitHealthy(`http://127.0.0.1:${VECTOR_MOVE_PORT}`);
  const vc = makeClient(`http://127.0.0.1:${VECTOR_MOVE_PORT}`);
  // Something must go through the index after boot, or "unchanged" could just mean "not run yet" — the
  // marker moving is the proof the step ran at all.
  const afterMove = await vc.call('recall_facts', { query: 'harbour teahouse', limit: 5 });
  ok('the step ran: the marker moved to the current layout',
    vdb.prepare("SELECT value FROM app_config WHERE key = 'facts.index.layout'").get()?.value === '3');
  ok('THE POINT: with no embedder the graph was KEPT — same nodes, so decay and links survive the upgrade',
    idsBefore.length > 0 && nodeIds() === idsBefore, `before=${idsBefore} after=${nodeIds()}`);
  ok('…and it still ranks', afterMove.result?.ranked === 'graph', `ranked=${afterMove.result?.ranked}`);
  vdb.close();

  // --- 9. an EDITED fact whose re-index fails is re-indexed at the next start -----------------------
  // Same kind+topic is an EDIT: the row's content changes in place, and the graph — which dedups by content hash —
  // gets a NEW node for the new text. The back-fill that repairs a failed index (FactIndexStep → SyncAsync) revisits
  // only rows whose ref is EMPTY. A NEW fact whose index fails has none, so it was retried; an edited one kept the
  // ref to its PREVIOUS content's node — RememberFactTool wrote the ref only when the index returned one, and
  // LearnAsync updated the content without touching it — so the new content and its subjects stayed out of the graph
  // until a rebuild, while the docs promised the back-fill would index it WITH subjects. The memory import had the
  // same hole with no failure at all: it edits through LearnAsync and never indexes.
  //
  // The failure is the one those docs describe: the annotation never answers (the stub hangs on the marker while
  // this server runs with GATHERLIGHT_STUB_HANG_ANNOTATION), and the write's CALLER gives up — here the HTTP client,
  // whose abort cancels the tool's token exactly as the tool's own 120 s deadline would, only sooner. Lyntai
  // propagates a caller cancellation out of the annotation, so nothing reaches the graph and IndexAsync returns null.
  const vbase = `http://127.0.0.1:${VECTOR_MOVE_PORT}`;
  const dbFile = path.join(dataDir, 'state', 'gatherlight.db');
  const rowOf = (topic) => {
    const db = new DatabaseSync(dbFile);
    try {
      return db.prepare("SELECT content, COALESCE(graph_ref, '') AS ref FROM knowledge WHERE kind = 'schedule' AND topic = ?")
        .get(topic) ?? null;
    } finally { db.close(); }
  };
  const nodeOf = (ref) => {
    const db = new DatabaseSync(dbFile);
    try {
      const id = Number(String(ref).split('#').pop());
      return {
        content: db.prepare("SELECT content FROM lyntai_memory_node WHERE engine = 'facts/graph' AND id = ?").get(id)?.content ?? null,
        subjects: db.prepare("SELECT subject FROM lyntai_memory_subject WHERE engine = 'facts/graph' AND node_id = ?")
          .all(id).map((r) => r.subject),
      };
    } finally { db.close(); }
  };

  await remember(vc, 'schedule', 'ferry timetable', 'The ferry leaves the east pier at 07:40 on weekdays.');
  await remember(vc, 'schedule', 'museum hours', 'The city museum opens at 09:00 and closes at 17:00.');
  const ferryBefore = rowOf('ferry timetable');
  const museumBefore = rowOf('museum hours');
  ok('(fixture) both facts were indexed on the way in', !!ferryBefore?.ref && !!museumBefore?.ref,
    JSON.stringify({ ferryBefore, museumBefore }));

  // THE EDIT THROUGH THE TOOL, whose re-index cannot finish.
  const ferryV2 = `The ferry now leaves the east pier at 08:10 on weekdays ${HANG}.`;
  let gaveUp = false;
  try {
    await fetch(`${vbase}/api/tools/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'remember_fact', arguments: {
        kind: 'schedule', topic: 'ferry timetable', content: ferryV2, source: 'https://example.test/ferry', confidence: 0.8 } }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { gaveUp = true; }
  ok('(fixture) the edit was still waiting on the hung annotation when its caller gave up', gaveUp);

  // The server finishes the call after the client has gone: the record of truth is written first, then the index is
  // cancelled and logged, then the ref is written. The SYNC POINT is the index failing — polling the row alone would
  // stop as soon as the content changed, before the index had ended at all.
  const logDir = path.join(dataDir, 'state', 'logs');
  const logText = () => (fs.existsSync(logDir)
    ? fs.readdirSync(logDir).map((n) => fs.readFileSync(path.join(logDir, n), 'utf8')).join('\n') : '');
  const failedIndex = /could not index schedule\/ferry timetable/;
  for (let i = 0; i < 60 && !failedIndex.test(logText()); i++) await new Promise((r) => setTimeout(r, 500));
  // Non-vacuity: the index REALLY failed — by cancellation, the tool-deadline path — rather than the ref being empty
  // because nothing had finished yet.
  ok('(fixture) the re-index of the edit really failed — the fact index logged it',
    failedIndex.test(logText()),
    logText().split('\n').filter((l) => /fact index/.test(l)).slice(-3).join(' | ') || '(no fact index lines)');
  await new Promise((r) => setTimeout(r, 500));   // the ref is written right after IndexAsync returns
  const ferryEdited = rowOf('ferry timetable');
  ok('(fixture) the edit reached the record of truth', ferryEdited?.content === ferryV2, JSON.stringify(ferryEdited));
  ok('THE POINT: a failed re-index of an EDITED fact leaves no ref to its previous content\'s node',
    ferryEdited?.ref === '', JSON.stringify({ before: ferryBefore?.ref, after: ferryEdited?.ref }));

  // THE EDIT THROUGH THE MEMORY IMPORT, which never indexes.
  const museumV2 = 'The city museum now opens at 10:00 and closes at 18:00 on weekdays.';
  const imported2 = await fetch(`${vbase}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gatherlightMemory: 1, knowledge: [{
      kind: 'schedule', topic: 'museum hours', content: museumV2, source: 'https://example.test/museum', confidence: 0.8 }] }),
  });
  const museumEdited = rowOf('museum hours');
  ok('(fixture) the memory import edited the fact in place',
    imported2.status === 200 && museumEdited?.content === museumV2, `${imported2.status} ${JSON.stringify(museumEdited)}`);
  // No longer "the ref is EMPTY": the import endpoint now starts a detached back-fill (DetachedFactBackfill; e2e-p14
  // asserts it indexes an import's facts without a restart), so the ref may already name the NEW content's node — or,
  // here, still be empty, the back-fill being queued behind the ferry fact's hung annotation. Either way it must never
  // name the PREVIOUS content's node, which is the hole this case exists for.
  ok('THE POINT: an edit by the memory import leaves no ref to the previous content\'s node either',
    !!museumBefore?.ref && museumEdited?.ref !== museumBefore.ref,
    JSON.stringify({ before: museumBefore?.ref, after: museumEdited?.ref }));

  // …AND THE NEXT START INDEXES THE NEW CONTENT. A new port (see case 7), and no hang marker: the same fact now
  // annotates. The layout marker is current, so this start only back-fills.
  vectorMove.stop();
  vectorMove = null;
  backfill = startServer({ dataDir, port: BACKFILL_PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await waitHealthy(`http://127.0.0.1:${BACKFILL_PORT}`);
  const bc = makeClient(`http://127.0.0.1:${BACKFILL_PORT}`);

  const ferryAfter = rowOf('ferry timetable');
  const ferryNode = ferryAfter?.ref ? nodeOf(ferryAfter.ref) : null;
  ok('THE POINT: the back-fill indexed the edited fact\'s NEW content — a new node, holding the new text',
    !!ferryAfter?.ref && ferryAfter.ref !== ferryBefore?.ref && ferryNode?.content === ferryV2,
    JSON.stringify({ before: ferryBefore?.ref, after: ferryAfter?.ref, node: ferryNode }));
  ok('…WITH its subject: the annotation the failed write never got ran on the back-fill',
    (ferryNode?.subjects ?? []).includes('sailingtimes'), JSON.stringify(ferryNode?.subjects ?? null));
  const museumAfter = rowOf('museum hours');
  const museumNode = museumAfter?.ref ? nodeOf(museumAfter.ref) : null;
  ok('…and the fact edited by import is indexed with its new content too',
    !!museumAfter?.ref && museumAfter.ref !== museumBefore?.ref && museumNode?.content === museumV2,
    JSON.stringify({ before: museumBefore?.ref, after: museumAfter?.ref, node: museumNode }));
  // What the household sees: the subject names the edited fact, which only the new node carries.
  const bySailing = await bc.call('recall_facts', { query: 'sailingtimes', limit: 5 });
  ok('…so recall reaches the edited fact through its new subject, ranked by the graph',
    bySailing.result?.ranked === 'graph'
      && (bySailing.result?.facts ?? []).some((f) => f.topic === 'ferry timetable' && f.ref === ferryAfter?.ref),
    JSON.stringify({ ranked: bySailing.result?.ranked, facts: (bySailing.result?.facts ?? []).map((f) => [f.topic, f.ref]) }));
  backfill.stop();
  backfill = null;

  // --- 10. a back-fill never runs BESIDE a rebuild -------------------------------------------------
  // A backup import REBUILDS the index: it forgets the graph, clears every graph_ref up front, and re-indexes from a
  // snapshot, an annotation per fact. A memory import landing meanwhile starts a detached back-fill
  // (DetachedFactBackfill), which indexes the rows whose ref is EMPTY — which, mid-rebuild, is every row the rebuild
  // has not reached yet. So it re-remembered all of them beside the rebuild: every such fact annotated twice (a CLI
  // call each against the household's quota), and two writers racing on each row's ref. The back-fill now waits for
  // the rebuild (FactIndex's bulk lock) and then finds only what is still unindexed: the imported fact.
  //
  // Staged on one server with its own folder: seed six facts (two whose annotation the stub makes take 6 s), let their
  // back-fill finish, export, and import that backup onto the same server — its rebuild then stays in progress for
  // ~6 s, and the memory import is sent inside that window, once the rebuild has taken its snapshot.
  const raceDir = dataDirFor('p48-race');
  fs.rmSync(raceDir, { recursive: true, force: true });
  makeTestData(raceDir);
  const argsLog = path.join(raceDir, '..', '_p48-race-args.log');
  fs.rmSync(argsLog, { force: true });
  // Case 11's hang-once knob, kept QUIET by its claim file until case 11 deletes it to arm it.
  const hangOnceFile = path.join(raceDir, '..', '_p48-hang-once.claim');
  fs.writeFileSync(hangOnceFile, 'claimed');
  race = startServer({ dataDir: raceDir, port: RACE_PORT, env: {
    GATHERLIGHT_CLAUDE_CMD: claudeStubCmd, GATHERLIGHT_STUB_SLOW_ANNOTATION: SLOW, GATHERLIGHT_STUB_ARGS_LOG: argsLog,
    GATHERLIGHT_STUB_HANG_ANNOTATION: HANG_ONCE, GATHERLIGHT_STUB_HANG_ONCE_FILE: hangOnceFile } });
  const rbase = `http://127.0.0.1:${RACE_PORT}`;
  await waitHealthy(rbase);
  const raceLogDir = path.join(raceDir, 'state', 'logs');
  const raceLog = () => (fs.existsSync(raceLogDir)
    ? fs.readdirSync(raceLogDir).map((n) => fs.readFileSync(path.join(raceLogDir, n), 'utf8')).join('\n') : '');
  const backfillCounts = (text) => [...text.matchAll(/back-fill after a memory import indexed (\d+) fact/g)].map((m) => +m[1]);
  const raceFact = (topic, content) => ({ kind: 'schedule', topic, content,
    source: `https://example.test/${encodeURIComponent(topic)}`, confidence: 0.8 });
  const seedFacts = [
    raceFact('race lighthouse', `The lighthouse tour ${SLOW} runs every Saturday at dawn.`),
    raceFact('race ferry', `The island ferry ${SLOW} leaves from pier nine at noon.`),
    raceFact('race bakery', 'The corner bakery sells rye bread until two in the afternoon.'),
    raceFact('race library', 'The branch library lends board games on Wednesdays.'),
    raceFact('race pool', 'The public pool keeps one lane for lessons each evening.'),
    raceFact('race market', 'The flower market moves indoors when it rains.'),
  ];
  const importMemory = (knowledge) => fetch(`${rbase}/api/memory/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gatherlightMemory: 1, knowledge }) });

  const seeded = await importMemory(seedFacts);
  for (let i = 0; i < 120 && backfillCounts(raceLog()).length < 1; i++) await new Promise((r) => setTimeout(r, 250));
  ok('(fixture) the six seed facts were imported and back-filled before the race',
    seeded.status === 200 && backfillCounts(raceLog())[0] === 6, `${seeded.status} ${JSON.stringify(backfillCounts(raceLog()))}`);

  const raceZip = Buffer.from(await (await fetch(`${rbase}/api/backup/export`)).arrayBuffer());
  let restoreDone = false;
  const restoring = fetch(`${rbase}/api/backup/import`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: raceZip,
  }).then((r) => { restoreDone = true; return r; });
  // The rebuild logs its count right after it has cleared the refs and read its snapshot.
  for (let i = 0; i < 240 && !/fact index: rebuilding \d+ facts/.test(raceLog()); i++) await new Promise((r) => setTimeout(r, 100));
  const newFact = raceFact('race observatory', 'The observatory opens its roof on clear Friday nights.');
  const late = await importMemory([newFact]);
  ok('(fixture) the memory import landed WHILE the rebuild ran',
    late.status === 200 && /fact index: rebuilding 6 facts/.test(raceLog()) && !restoreDone,
    JSON.stringify({ status: late.status, rebuilding: /rebuilding 6 facts/.test(raceLog()), restoreDone }));
  const restored = await restoring;
  ok('(fixture) the backup import onto itself succeeded', restored.status === 200, `status ${restored.status}`);
  for (let i = 0; i < 120 && backfillCounts(raceLog()).length < 2; i++) await new Promise((r) => setTimeout(r, 250));

  ok('THE POINT: the back-fill beside a rebuild waited for it, then indexed only the fact the import added',
    backfillCounts(raceLog())[1] === 1,
    `back-fills after a memory import indexed ${JSON.stringify(backfillCounts(raceLog()))} (want [6, 1]) · ` +
    (raceLog().split('\n').filter((l) => /back-filled|rebuil/.test(l)).slice(-4).join(' | ') || '(no lines)'));
  // What that saves the household: an annotation is a CLI call against their quota. Each slow fact is annotated by the
  // seed back-fill and by the rebuild — never a third time by a back-fill running beside the rebuild.
  const annotationsOf = (marker) => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8') : '').split('\n')
    .filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'annotation' && String(e.tail).split('Fact:\n').pop().includes(marker)).length;
  const perSlowFact = [annotationsOf('lighthouse tour'), annotationsOf('island ferry')];
  ok('…so no fact was annotated twice for one restore (seed + rebuild = 2 each)',
    perSlowFact.every((n) => n === 2), JSON.stringify(perSlowFact));
  // The positive control: waiting did not lose the late fact, and every row names a node that exists.
  const raceDb = new DatabaseSync(path.join(raceDir, 'state', 'gatherlight.db'));
  let rows;
  try {
    rows = raceDb.prepare(`SELECT k.topic, COALESCE(k.graph_ref, '') AS ref, n.content AS node
      FROM knowledge k LEFT JOIN lyntai_memory_node n
        ON n.engine = 'facts/graph' AND n.id = CAST(substr(k.graph_ref, instr(k.graph_ref, '#') + 1) AS INTEGER)
      WHERE k.topic LIKE 'race %'`).all();
  } finally { raceDb.close(); }
  const late2 = rows.find((r) => r.topic === 'race observatory');
  ok('…and the imported fact is indexed, its ref naming a node that holds its content',
    !!late2?.ref && late2.node === newFact.content, JSON.stringify(late2));
  ok('…and every fact\'s ref names a node that exists',
    rows.length === 7 && rows.every((r) => r.ref && r.node), JSON.stringify(rows.map((r) => [r.topic, r.ref, !!r.node])));

  // --- 11. a SINGLE write racing a rebuild leaves no stale ref ----------------------------------------------------
  // A rebuild forgets the graph, clears every graph_ref and re-indexes from a snapshot; remember_fact takes no lock beside
  // it. Two races on graph_ref came out of that, both leaving a NON-empty ref no back-fill ever returns to:
  //   (a) a remember_fact of UNCHANGED content reads the row's ref before it indexes; when its index fails (here: its
  //       caller gives up while the annotation hangs) it restores that ref — which the rebuild meanwhile forgot;
  //   (b) an EDIT landing after the rebuild's snapshot is overwritten when the rebuild, re-remembering the OLD content,
  //       writes that node's ref.
  // Both writes are now conditional (IKnowledgeStore.SetGraphRefIfAsync / SetGraphRefIfContentAsync): the tool's only
  // while the row still holds the ref it read, the rebuild's only while the row still holds the content it indexed.
  // Staged on case 10's server: the stub hangs the annotation of ONE write (GATHERLIGHT_STUB_HANG_ONCE_FILE — the rebuild's
  // own annotation of the same fact answers), and case 10's slow marker keeps the rebuild's re-remember of the edited
  // fact 6 s long, so the edit lands inside it.
  {
    const RACE_U = raceFact('race2 harbour desk', `The harbour ${HANG_ONCE} ferry desk opens at eight on weekdays.`);
    const RACE_E = raceFact('race2 lighthouse museum', `The old lighthouse ${SLOW} museum closes at five in winter.`);
    const RACE_E_NEW = 'The old lighthouse museum now closes at six all year round.';
    const raceDbFile = path.join(raceDir, 'state', 'gatherlight.db');
    const rowNode = (topic) => {
      const db = new DatabaseSync(raceDbFile);
      try {
        return db.prepare(`SELECT k.content, COALESCE(k.graph_ref, '') AS ref, n.content AS node
          FROM knowledge k LEFT JOIN lyntai_memory_node n
            ON n.engine = 'facts/graph' AND n.id = CAST(substr(k.graph_ref, instr(k.graph_ref, '#') + 1) AS INTEGER)
          WHERE k.topic = ?`).get(topic) ?? null;
      } finally { db.close(); }
    };
    const rebuildsLogged = () => (raceLog().match(/fact index: rebuilding \d+ facts/g) ?? []).length;
    const hangAnnotations = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8') : '').split('\n')
      .filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.kind === 'annotation' && String(e.tail).split('Fact:\n').pop().includes(HANG_ONCE)).length;

    await importMemory([RACE_U, RACE_E]);
    for (let i = 0; i < 240 && !(rowNode(RACE_U.topic)?.ref && rowNode(RACE_E.topic)?.ref); i++)
      await new Promise((r) => setTimeout(r, 250));
    const refUBefore = rowNode(RACE_U.topic)?.ref;
    ok('(fixture 11) both race facts imported and indexed, their refs naming their own content',
      !!refUBefore && rowNode(RACE_U.topic).node === RACE_U.content && rowNode(RACE_E.topic)?.node === RACE_E.content,
      JSON.stringify({ u: rowNode(RACE_U.topic), e: rowNode(RACE_E.topic) }));
    const zip2 = Buffer.from(await (await fetch(`${rbase}/api/backup/export`)).arrayBuffer());

    // (a): arm the hang, and start a remember_fact of U's UNCHANGED content — its annotation now hangs.
    fs.rmSync(hangOnceFile, { force: true });
    const hangsBefore = hangAnnotations();
    const abort = new AbortController();
    const held = fetch(`${rbase}/api/tools/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
      body: JSON.stringify({ name: 'remember_fact', arguments: { kind: RACE_U.kind, topic: RACE_U.topic,
        content: RACE_U.content, source: RACE_U.source, confidence: 0.8 } }),
    }).catch(() => null);
    for (let i = 0; i < 120 && hangAnnotations() <= hangsBefore; i++) await new Promise((r) => setTimeout(r, 100));
    ok('(fixture 11a) the single write is held open in its annotation', hangAnnotations() > hangsBefore,
      `${hangAnnotations()} hanging annotation(s)`);

    // …while a backup import rebuilds the index under it.
    const rebuildsBefore = rebuildsLogged();
    let restore2Done = false;
    const restoring2 = fetch(`${rbase}/api/backup/import`, {
      method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip2,
    }).then((r) => { restore2Done = true; return r; });
    for (let i = 0; i < 300 && rebuildsLogged() <= rebuildsBefore; i++) await new Promise((r) => setTimeout(r, 100));

    // (b): the EDIT, landing after the rebuild's snapshot — while its re-remember of E's OLD content is 6 s long.
    const edited = await makeClient(rbase).call('remember_fact', { kind: RACE_E.kind, topic: RACE_E.topic,
      content: RACE_E_NEW, source: RACE_E.source, confidence: 0.8 });
    ok('(fixture 11b) the edit landed WHILE the rebuild ran, after its snapshot',
      edited.result?.ok === true && rebuildsLogged() > rebuildsBefore && !restore2Done,
      JSON.stringify({ edited: edited.result, rebuilding: rebuildsLogged() > rebuildsBefore, restore2Done }));

    // Let the rebuild re-index U, THEN give up on the held write: its index fails and it restores the ref it read.
    for (let i = 0; i < 300 && !(rowNode(RACE_U.topic)?.ref && rowNode(RACE_U.topic).ref !== refUBefore); i++)
      await new Promise((r) => setTimeout(r, 100));
    ok('(fixture 11a) the rebuild re-indexed U first — its row holds the rebuild\'s ref', !!rowNode(RACE_U.topic)?.ref
      && rowNode(RACE_U.topic).ref !== refUBefore, JSON.stringify({ before: refUBefore, now: rowNode(RACE_U.topic) }));
    abort.abort();
    await held;
    const restored2 = await restoring2;
    for (let i = 0; i < 40 && !new RegExp(`could not index schedule/${RACE_U.topic}`).test(raceLog()); i++)
      await new Promise((r) => setTimeout(r, 250));
    ok('(fixture 11a) the held write\'s index FAILED — the path that falls back to the ref it read',
      new RegExp(`could not index schedule/${RACE_U.topic}`).test(raceLog()) && restored2.status === 200,
      `restore ${restored2.status}`);
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(hangOnceFile, 'claimed');

    const u = rowNode(RACE_U.topic);
    ok('THE POINT (11a): the held write did NOT put back the ref it read — U names a node that exists, with its content',
      !!u?.ref && u.ref !== refUBefore && u.node === RACE_U.content, JSON.stringify({ before: refUBefore, u }));
    const e = rowNode(RACE_E.topic);
    ok('THE POINT (11b): the rebuild did NOT overwrite the edit — E names a node holding its NEW content',
      e?.content === RACE_E_NEW && !!e?.ref && e.node === RACE_E_NEW, JSON.stringify(e));
  }

} catch (err) {
  fail('e2e-p48 fatal: ' + (err?.stack || err?.message || String(err)));
} finally {
  try { server?.stop(); } catch {}
  try { restoreServer?.stop(); } catch {}
  try { upgraded?.stop(); } catch {}
  try { vectorMove?.stop(); } catch {}
  try { backfill?.stop(); } catch {}
  try { race?.stop(); } catch {}
}

done();
