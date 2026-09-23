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

let server = null;
let restoreServer = null;
let upgraded = null;
let vectorMove = null;

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

  // THE JUDGE SEES THE FACT, NOT ITS LABEL. Lyntai's LLM verifier renders `{n}. {Headline}`, and the fact
  // index writes each fact's TOPIC as its headline — so the judge used to decide "did this answer?" from
  // topics alone. JudgeSeesContentPolicy hands it `topic — content`. `listing-id 4417` exists only in the
  // content of one fact, so its presence in the notes is proof the content arrived.
  ok('the judge is shown the facts’ CONTENT, not only their topics',
    shown.some((n) => n.includes('listing-id 4417')), JSON.stringify(shown));

  ok('THE POINT: the endorsed candidate was NOT top of the pre-verdict ranking',
    shown[shown.length - 1] !== shown[0], JSON.stringify(shown));

  // The endorsed note carries the fact's content in every rendering (topic — content, or content alone),
  // so it is matched by the content of the page's top row.
  ok('...and it comes back at the top of the page',
    !!verdictPage[0]?.content && String(shown[shown.length - 1] ?? '').includes(verdictPage[0].content),
    JSON.stringify({ endorsed: shown[shown.length - 1], page: verdictPage.map((f) => f.topic) }));

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

  vectorMove = startServer({ dataDir, port: VECTOR_MOVE_PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
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

} catch (err) {
  fail('e2e-p48 fatal: ' + (err?.stack || err?.message || String(err)));
} finally {
  try { server?.stop(); } catch {}
  try { restoreServer?.stop(); } catch {}
  try { upgraded?.stop(); } catch {}
  try { vectorMove?.stop(); } catch {}
}

done();
