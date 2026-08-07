#!/usr/bin/env node
// e2e P45 — pages that stay true (S3c). Three things, one vocabulary: a Table or Chart can BIND to a
// named query instead of carrying a frozen copy of the data; Chart is the primitive S3a left out; and
// a page can define its own component out of primitives. Every denial sits beside a positive control,
// the discipline p38/p39/p41/p42 established.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p45');
const { ok, fail, done } = makeReporter('p45');
makeTestData(dataDir);

const PORT = 5490;
const server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post } = makeClient(base);

const uiDir = path.join(dataDir, 'ui');
const write = (name, body) => {
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, `${name}.json`), JSON.stringify(body, null, 2), 'utf8');
};
const pageOf = async (name) => (await j(`/api/ui/pages/${name}`)).body;
// Depth-first walk of a rendered tree — assertions are about what the household would SEE.
const nodes = (n) => (n ? [n, ...(n.children ?? []).flatMap(nodes)] : []);
const find = (root, type) => nodes(root).find((n) => n.type === type);

try {
  await waitHealthy(base);

  // --- the vocabulary gained Chart, and the registry knows it -------------------------------
  const registry = (await j('/api/ui/registry')).body ?? [];
  const chart = registry.find((c) => c.type === 'Chart');
  ok('Chart is registered', !!chart, registry.map((c) => c.type).join(','));
  ok('Chart declares a binding prop', chart?.props?.bind === 'Binding', JSON.stringify(chart?.props));
  ok('Table declares a binding prop', registry.find((c) => c.type === 'Table')?.props?.bind === 'Binding');

  // Positive control, then the pairing rule. A chart plots pairs; unequal lengths would silently
  // drop or invent a bar.
  write('chart-ok', { title: 'c', root: { type: 'Chart', labels: ['a', 'b'], values: [1, 2] } });
  write('chart-uneven', { title: 'c', root: { type: 'Chart', labels: ['a', 'b'], values: [1] } });
  ok('a well-formed Chart validates', (await pageOf('chart-ok'))?.status === 'ready', (await pageOf('chart-ok'))?.reason ?? '');
  const uneven = await pageOf('chart-uneven');
  ok('a Chart with mismatched labels/values is refused', uneven?.status === 'invalid');
  ok('the reason names the pairing', /same length/.test(uneven?.reason ?? ''), uneven?.reason ?? '');

  // --- FileRef.path is held to the site boundary, like openRecord ---------------------------
  // It was a bare string, so the contract promised "a path inside the site" while the validator
  // accepted anything and the boundary was only enforced downstream, when the file was opened.
  write('ref-ok', { title: 'r', root: { type: 'FileRef', path: 'plans/trips/2026-08-kyoto.md', label: '行程' } });
  write('ref-state', { title: 'r', root: { type: 'FileRef', path: 'state/gatherlight.db' } });
  write('ref-escape', { title: 'r', root: { type: 'FileRef', path: '../../etc/passwd' } });
  write('ref-url', { title: 'r', root: { type: 'FileRef', path: 'https://example.invalid/x' } });
  write('ref-future', { title: 'r', root: { type: 'FileRef', path: 'plans/trips/not-written-yet.md' } });

  ok('a record path validates', (await pageOf('ref-ok'))?.status === 'ready', (await pageOf('ref-ok'))?.reason ?? '');
  ok('a state/ path is refused', (await pageOf('ref-state'))?.status === 'invalid', (await pageOf('ref-state'))?.reason ?? '');
  ok('a path escaping the site is refused', (await pageOf('ref-escape'))?.status === 'invalid');
  ok('a URL is refused', (await pageOf('ref-url'))?.status === 'invalid', (await pageOf('ref-url'))?.reason ?? '');
  // Shape, not state — same rule runCapability follows. A page may name a record not written yet.
  ok('a path to a record that does not exist yet still validates',
    (await pageOf('ref-future'))?.status === 'ready', (await pageOf('ref-future'))?.reason ?? '');

  // --- a bound table reads live state -------------------------------------------------------
  write('live', {
    title: 'Live',
    root: {
      type: 'Stack',
      children: [
        { type: 'Heading', text: '最近的计划' },
        { type: 'Table', columns: ['标题', '更新', '路径'], bind: { query: 'records', params: { kind: 'trips' } } },
      ],
    },
  });

  const live = await pageOf('live');
  ok('a bound page validates', live?.status === 'ready', live?.reason ?? '');
  const table = find(live?.root, 'Table');
  ok('the served table carries rows', Array.isArray(table?.rows), JSON.stringify(table).slice(0, 200));
  // The client is never handed a query: it cannot re-run one, and cannot call it with parameters of
  // its own choosing. This is the load-bearing consequence of resolving server-side.
  ok('the served table carries NO binding', table?.bind === undefined, JSON.stringify(table).slice(0, 200));
  ok('it shows the fixture trip', table.rows.some((r) => r[2] === 'plans/trips/2026-08-kyoto.md'),
    JSON.stringify(table.rows));

  // THE POINT OF S3C: the page file is never rewritten, and tomorrow's record still appears.
  fs.writeFileSync(path.join(dataDir, 'plans', 'trips', '2026-09-nara.md'),
    '# 奈良 3 天(fixture-later)\n\n| Field | Value |\n|---|---|\n| Dates | 2026-09-01 → 2026-09-03 |\n', 'utf8');
  const grew = await until(async () => {
    const t = find((await pageOf('live'))?.root, 'Table');
    return t?.rows?.some((r) => r[2] === 'plans/trips/2026-09-nara.md') ? t : null;
  }, 60000);
  ok('a record created AFTER the page appears on it, with the page file untouched', !!grew,
    JSON.stringify(find((await pageOf('live'))?.root, 'Table')?.rows));

  // --- what a binding may say ---------------------------------------------------------------
  const bad = async (name, node, label, re) => {
    write(name, { title: name, root: node });
    const p = await pageOf(name);
    ok(label, p?.status === 'invalid', `${p?.status}: ${p?.reason ?? ''}`);
    if (re) ok(`  ↳ the reason says why (${name})`, re.test(p?.reason ?? ''), p?.reason ?? '');
  };

  await bad('q-unknown', { type: 'Table', columns: ['a'], bind: { query: 'select_star' } },
    'an unknown query is refused', /no such data source/);
  await bad('q-param', { type: 'Table', columns: ['a'], bind: { query: 'records', params: { sneaky: 'x' } } },
    'an undeclared param is refused', /does not take/);
  await bad('q-type', { type: 'Table', columns: ['a'], bind: { query: 'records', params: { limit: 'ten' } } },
    'a mistyped param is refused', /must be a number/);
  await bad('q-required', { type: 'Table', columns: ['a'], bind: { query: 'budget' } },
    'a missing required param is refused', /needs param/);
  await bad('q-both', { type: 'Table', columns: ['a'], rows: [['x']], bind: { query: 'records' } },
    'rows AND bind together is refused', /one or the other/);
  await bad('q-shape', { type: 'Table', columns: ['a'], bind: { query: 'records', extra: 1 } },
    'an unknown key in the binding is refused', /only 'query' and 'params'/);

  // --- a runtime failure is SHOWN, and does not take the page with it ------------------------
  // `records` column 1 is a date, so binding a Chart to it is a real mismatch between the page and
  // the query it named. The page still has to render — an empty chart would be a silent lie.
  write('runtime', {
    title: 'Runtime',
    root: {
      type: 'Stack',
      children: [
        { type: 'Heading', text: '这一段必须还在' },
        { type: 'Chart', labels: [], values: [], bind: { query: 'records', params: { kind: 'trips' } } },
      ],
    },
  });
  // labels/values + bind is refused, so the fixture above is itself invalid — assert that, then use
  // the correct form for the runtime case.
  ok('labels/values AND bind together is refused', (await pageOf('runtime'))?.status === 'invalid',
    (await pageOf('runtime'))?.reason ?? '');

  write('runtime', {
    title: 'Runtime',
    root: {
      type: 'Stack',
      children: [
        { type: 'Heading', text: '这一段必须还在' },
        { type: 'Chart', bind: { query: 'records', params: { kind: 'trips' } } },
      ],
    },
  });
  const rt = await pageOf('runtime');
  ok('a page whose source cannot satisfy it still renders', rt?.status === 'ready', rt?.reason ?? '');
  ok('the rest of the page survives', !!find(rt?.root, 'Heading'));
  const warn = nodes(rt?.root).find((n) => n.type === 'Text' && /data unavailable/.test(String(n.text ?? '')));
  ok('the failure is SHOWN where the data would have been', !!warn, JSON.stringify(nodes(rt?.root).map((n) => n.type)));
  ok('the warning names the query', /records/.test(String(warn?.text ?? '')), String(warn?.text ?? ''));
  ok('the warning is toned as a warning', warn?.tone === 'warning', String(warn?.tone));

  // A chart bound to a source whose second column IS numeric works — the positive control that makes
  // the failure above mean something.
  write('chart-bound', {
    title: 'Bound chart',
    root: { type: 'Chart', kind: 'bar', unit: 'JPY', bind: { query: 'budget', params: { path: 'plans/budgets/2026-08-kyoto.md' } } },
  });
  const cb = await pageOf('chart-bound');
  const cbNode = find(cb?.root, 'Chart');
  ok('a chart bound to a numeric column renders', cb?.status === 'ready' && Array.isArray(cbNode?.values),
    JSON.stringify(cb).slice(0, 220));
  ok('its values are numbers', (cbNode?.values ?? []).every((v) => typeof v === 'number'), JSON.stringify(cbNode?.values));
  ok('its labels pair with them', (cbNode?.labels ?? []).length === (cbNode?.values ?? []).length);

  // --- truncation is announced, never silent ------------------------------------------------
  write('capped', {
    title: 'Capped',
    root: { type: 'Table', columns: ['标题', '更新', '路径'], bind: { query: 'records', params: { limit: 1 } } },
  });
  const capped = find((await pageOf('capped'))?.root, 'Table');
  ok('a limited result returns just that many', capped?.rows?.length === 1, JSON.stringify(capped?.rows));
  ok('and SAYS there was more', /there is more/.test(String(capped?.caption ?? '')), String(capped?.caption ?? ''));

  // --- bindings are a page feature ----------------------------------------------------------
  const inChat = await post('/api/ui/validate', { type: 'Table', columns: ['a'], bind: { query: 'records' } });
  ok('a binding through the validate endpoint is fine (it is a page-side path)',
    inChat.body?.status === 'ready', JSON.stringify(inChat.body).slice(0, 160));

  // --- composites ---------------------------------------------------------------------------
  write('_daycard', {
    define: 'DayCard',
    params: { day: 'string', note: 'string' },
    body: { type: 'Card', title: '{{day}}', children: [{ type: 'Text', text: '{{note}}' }] },
  });
  write('uses-daycard', {
    title: 'Itinerary',
    root: { type: 'Stack', children: [{ type: 'DayCard', day: 'Day 1', note: '美术馆' }] },
  });

  const used = await pageOf('uses-daycard');
  ok('a page using a definition validates', used?.status === 'ready', used?.reason ?? '');
  const card = find(used?.root, 'Card');
  ok('the definition expanded into primitives', !!card, JSON.stringify(used?.root).slice(0, 200));
  ok('a parameter substituted into the title', card?.title === 'Day 1', String(card?.title));
  ok('a parameter substituted into a child', find(used?.root, 'Text')?.text === '美术馆',
    JSON.stringify(find(used?.root, 'Text')));
  ok('no DayCard node survives to the client', !find(used?.root, 'DayCard'));

  // A definition is not a page.
  const pages = (await j('/api/ui/pages')).body ?? [];
  ok('a definition does not appear in the menu', !pages.some((p) => p.name === '_daycard'),
    pages.map((p) => p.name).join(','));

  await bad('bad-param', { type: 'DayCard', day: 'Day 1', note: 'x', extra: 'y' },
    'an undeclared parameter is refused', /no parameter/);
  await bad('bad-missing', { type: 'DayCard', day: 'Day 1' },
    'a missing parameter is refused', /needs parameter/);
  await bad('bad-children', { type: 'DayCard', day: 'd', note: 'n', children: [{ type: 'Text', text: 'x' }] },
    'children on a definition are refused', /does not take children/);

  // Whole-value substitution only: no expression language, and no braces leaking to the household.
  write('_mixed', { define: 'Mixed', params: { day: 'string' }, body: { type: 'Text', text: 'Day {{day}}' } });
  await bad('uses-mixed', { type: 'Mixed', day: '1' },
    'text mixed with a placeholder is refused', /whole value/);

  // Recursion cannot exist rather than being detected: one level, enforced at expansion.
  write('_outer', { define: 'Outer', params: {}, body: { type: 'DayCard', day: 'd', note: 'n' } });
  await bad('uses-outer', { type: 'Outer' },
    'a definition using another definition is refused', /only use built-in/);

  // A definition may not take a built-in's name — otherwise it would silently never render.
  write('_shadow', { define: 'Table', params: {}, body: { type: 'Text', text: 'nope' } });
  write('still-a-table', { title: 't', root: { type: 'Table', columns: ['a'], rows: [['1']] } });
  ok('a shadowing definition does not break the built-in',
    (await pageOf('still-a-table'))?.status === 'ready', (await pageOf('still-a-table'))?.reason ?? '');
  ok('and it is not silently usable', !(await j('/api/ui/pages')).body?.some((p) => p.name === '_shadow'));

  // The limits apply to the EXPANDED tree, so a definition cannot be a bomb.
  write('_big', {
    define: 'Big', params: {},
    body: { type: 'Stack', children: Array.from({ length: 60 }, (_, i) => ({ type: 'Text', text: `n${i}` })) },
  });
  write('too-big', {
    title: 'big',
    root: { type: 'Stack', children: Array.from({ length: 10 }, () => ({ type: 'Big' })) },
  });
  const big = await pageOf('too-big');
  ok('a definition used past the node limit is refused', big?.status === 'invalid', big?.status ?? '');
  ok('the reason names the limit', /larger than/.test(big?.reason ?? ''), big?.reason ?? '');

  // --- the agent is told all of this --------------------------------------------------------
  // S3a's lesson, re-learned in S3b: a capability the agent is never told about is unreachable
  // while every check stays green.
  const spec = fs.readFileSync(path.join(dataDir, '.claude', 'ui-spec.md'), 'utf8');
  ok('the contract version bumped', /UI_CONTRACT_VERSION:\s*3/.test(spec), spec.split('\n')[0]);
  ok('it explains binding', /"bind"/.test(spec) && /bind.*INSTEAD of.*rows|INSTEAD of `rows`/i.test(spec));
  ok('it lists the real query ids', ['records', 'library', 'budget'].every((q) => spec.includes(`\`${q}\``)));
  ok('the query table is generated from the sources, not hand-written',
    /\| `budget` \|.*`path` \(required\)/.test(spec), spec.split('\n').find((l) => l.includes('| `budget`')) ?? '(missing)');
  ok('it names Chart', /`Chart`/.test(spec));
  ok('it explains defining a component', /"define"/.test(spec) && /DayCard/.test(spec));
} catch (err) {
  fail('e2e-p45 fatal: ' + err.message);
  console.error(server.log().slice(-3000));
} finally {
  server.stop();
}
done();
