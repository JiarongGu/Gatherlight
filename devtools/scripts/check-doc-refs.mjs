#!/usr/bin/env node
// check-doc-refs.mjs — every code identifier a LIVE doc names must exist in the tree.
//
// WHY THIS EXISTS. Docs drift silently: a class is renamed, the prose that points at it is not, and the
// next session follows the reference, finds nothing, and re-derives what was already written down. That is
// worse than no doc — an absent explanation costs a search, a WRONG one costs a search plus the time spent
// trusting it. Found by hand on 2026-08-23: `GitCliService.GitExe` (the member is `LocateGit`), and three
// Ollama APIs still named in a rule after the backend was removed.
//
// SCOPE IS THE WHOLE DESIGN. Only LIVE docs are checked — the ones a session is expected to act on.
// `docs/superpowers/plans|specs` are point-in-time implementation records; a plan from July describing a
// class that has since been renamed is not wrong, it is HISTORY, and rewriting it would destroy the record
// of what was actually decided. Same for dated measurement write-ups. Checking them would produce noise
// that trains everyone to ignore this check, which is how a green check becomes decorative.
//
// Usage: node devtools/dev.mjs check-doc-refs
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(process.argv[2] ?? process.cwd());

// The docs a session is expected to ACT on. Everything else is archive.
const LIVE = [
  'CLAUDE.md', 'README.md', 'TASKS.md',
  '.claude/rules/dev-conventions.md', '.claude/rules/sensitive-info.md', '.claude/rules/RULES_INDEX.md',
  'docs/ROADMAP.md', 'docs/STORAGE_NOTES.md', 'docs/TOOLS.md', 'docs/UI_ARCHITECTURE.md',
  'docs/DEPLOYMENT.md', 'docs/release-notes/next.md',
];

// Identifiers a live doc may name even though they are not in the tree, keyed `doc::identifier`. PER-DOC
// on purpose: `ClaudeCliRunner` is legitimate in ROADMAP.md, which records that it was DELETED, and would
// be a rotted reference anywhere that presented it as current. A bare-identifier allowlist cannot tell
// those apart, and the one that matters is the second.
//
// Each entry needs a REASON. The point is to force a decision, not to provide a silencer.
const ALLOWED = new Map([
  ['.claude/rules/dev-conventions.md::pN.mjs',
    'a filename PATTERN, not a file — the suites are p1.mjs, p2.mjs, …'],
  ['docs/DEPLOYMENT.md::IncludeNativeLibrariesForSelfExtract',
    'an MSBuild property quoted while explaining why the shipped host is framework-dependent and does '
    + 'NOT use it'],
  ['docs/ROADMAP.md::ClaudeCliRunner',
    'the roadmap records that this phase DELETED it; a history that cannot name what it removed is not a '
    + 'history'],
  ['docs/ROADMAP.md::IDataContext',
    'same — S1 records it splitting into ISiteContext / IPlatformContext'],
  ['docs/STORAGE_NOTES.md::AssistantMemoryService',
    'belongs to VIDORA, a sibling project this note compares against — not a symbol in this tree'],
]);

const CODE_EXT = new Set(['.cs', '.mjs', '.ts', '.tsx', '.json', '.js', '.cmd', '.ps1', '.csproj', '.cpp', '.h']);
const SKIP_DIR = new Set(['bin', 'obj', 'node_modules', '.git']);

const corpus = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      // `_`-prefixed directories are scratch/fixtures; they hold copies that would mask a real rename.
      if (SKIP_DIR.has(e.name) || e.name.startsWith('_')) continue;
      walk(path.join(dir, e.name));
    } else if (CODE_EXT.has(path.extname(e.name))) {
      corpus.push(e.name);
      try { corpus.push(fs.readFileSync(path.join(dir, e.name), 'utf8')); } catch { /* unreadable */ }
    }
  }
})(repo);
const code = corpus.join('\n');

// Backticked, PascalCase-ish or a source filename. Deliberately narrow: prose words in backticks
// (`plans/`, `--limit=3`, `aka`) are not claims that a symbol exists, and flagging them would bury the
// ones that are.
const IDENT = /`([A-Za-z][A-Za-z0-9_.]{4,60})`/g;
const looksLikeSymbol = (s) =>
  /^[A-Z][A-Za-z0-9]+(\.[A-Za-z0-9_]+)*$/.test(s) || s.endsWith('.mjs') || s.endsWith('.cs');

let failures = 0;
let checked = 0;
for (const rel of LIVE) {
  const file = path.join(repo, rel);
  if (!fs.existsSync(file)) { console.log(`  ! listed but missing: ${rel}`); failures++; continue; }
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const m of text.matchAll(IDENT)) {
    const id = m[1];
    if (seen.has(id) || !looksLikeSymbol(id)) continue;
    seen.add(id);
    checked++;
    if (ALLOWED.has(`${rel}::${id}`)) continue;
    // A dotted name is checked on its LAST segment: `Foo.Bar` is satisfied by a member named Bar, because
    // matching the whole dotted path would fail on every method the docs qualify by its class.
    const needle = id.includes('.') && !id.endsWith('.mjs') && !id.endsWith('.cs')
      ? id.split('.').pop() : id;
    if (!code.includes(needle)) {
      console.log(`  ✗ ${rel}: \`${id}\` is named but does not exist in the tree`);
      failures++;
    }
  }
}

console.log(failures === 0
  ? `check-doc-refs: OK — ${checked} identifiers across ${LIVE.length} live docs all resolve`
  : `check-doc-refs: ${failures} dangling reference(s). Rename the doc to match the code, or add doc::id to `
    + 'ALLOWED with a reason if it is named deliberately.');
process.exit(failures === 0 ? 0 : 1);
