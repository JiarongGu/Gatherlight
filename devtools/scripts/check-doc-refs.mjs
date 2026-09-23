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

// Docs that are LIVE when they exist but are legitimately absent the rest of the time. A missing entry
// from LIVE is normally a defect worth failing on — someone deleted a doc the project depends on — but
// `next.md` is CONSUMED by a release (renamed to `<version>.md`), so it is missing on every freshly
// released tree. Failing there would make the check red for a correct repo the day after every release,
// and a check that cries wolf on the happy path is one everybody learns to skip. Checked when present,
// silent when not.
const OPTIONAL = new Set(['docs/release-notes/next.md']);

// Identifiers a live doc may name even though they are not in the tree, keyed `doc::identifier`. PER-DOC
// on purpose: `ClaudeCliRunner` is legitimate in ROADMAP.md, which records that it was DELETED, and would
// be a rotted reference anywhere that presented it as current. A bare-identifier allowlist cannot tell
// those apart, and the one that matters is the second.
//
// Each entry needs a REASON. The point is to force a decision, not to provide a silencer.
const ALLOWED = new Map([
  ['.claude/rules/dev-conventions.md::pN.mjs',
    'a filename PATTERN, not a file — the suites are p1.mjs, p2.mjs, …'],
  ['.claude/rules/dev-conventions.md::GitCliService.GitExe',
    'the rotted reference this check was built after, quoted as the example — the same sentence names the '
    + 'real member, LocateGit'],
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

// Paths a live doc may name that are not repo files. Same `doc::path` keying and the same requirement of
// a reason. Two recurring kinds: files in the DATA folder (which is user data, not the tree) and files in
// a SIBLING PROJECT the doc compares against.
const ALLOWED_PATHS = new Map([
  ['.claude/rules/dev-conventions.md::.claude/tool-spec.md', 'app-managed file in the DATA folder'],
  ['.claude/rules/dev-conventions.md::.claude/ui-spec.md', 'app-managed file in the DATA folder'],
  ['.claude/rules/dev-conventions.md::state/mcp.chat.json',
    'a file startup DELETES — named to say it must not come back'],
  ['CLAUDE.md::hooks/scope-guard.mjs', 'app-managed file in the DATA folder'],
  ['docs/DEPLOYMENT.md::state/settings.json', 'lives in the DATA folder'],
  ['docs/STORAGE_NOTES.md::Modules/Embedding/Services/SqliteVecLoader.cs',
    "VIDORA's file — this doc is a sibling-project review"],
]);

const CODE_EXT = new Set(['.cs', '.mjs', '.ts', '.tsx', '.json', '.js', '.cmd', '.ps1', '.csproj', '.cpp', '.h']);
const SKIP_DIR = new Set(['bin', 'obj', 'node_modules', '.git']);

const corpus = [];
// Every C# source, kept apart so a qualified `Type.Member` can be checked against the files that DECLARE
// `Type` — see pass 1.
const csFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      // `_`-prefixed directories are scratch/fixtures; they hold copies that would mask a real rename.
      if (SKIP_DIR.has(e.name) || e.name.startsWith('_')) continue;
      walk(path.join(dir, e.name));
    } else if (CODE_EXT.has(path.extname(e.name))) {
      corpus.push(e.name);
      try {
        const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        corpus.push(text);
        if (path.extname(e.name) === '.cs') csFiles.push(text);
      } catch { /* unreadable */ }
    }
  }
})(repo);
const code = corpus.join('\n');

// C# with its comments and string literals blanked out, leaving only what the compiler reads as code.
//
// WHY. A name that survives only in a COMMENT is exactly the rotted reference this check exists to find —
// and the whole-corpus substring match below cannot see the difference. It let a ResourceProvisioner method
// through after it was renamed to `GgufKind` (a yes/no embedder test, retired when a third GGUF kind
// arrived), because an e2e suite's comment still carried the old name: the doc and the comment kept each
// other alive. (Not spelled out here on purpose — this file is in the corpus too.)
//
// A tokenizer rather than a regex, because a regex cannot tell `//` in a URL string from a comment, and
// guessing wrong in the permissive direction is the very failure being fixed. Handled: `//` and `/* */`
// comments; "regular", @"verbatim" and """raw""" strings (with any `$` prefix); 'c'har literals. A regular
// string or char literal also ends at a newline, so a misread interpolation hole costs one line at most.
function csCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '"') {
      // Raw: three or more quotes open it, and the same run closes it.
      let q = 0;
      while (src[i + q] === '"') q++;
      if (q >= 3) {
        const close = '"'.repeat(q);
        const end = src.indexOf(close, i + q);
        i = end < 0 ? n : end + q;
        out += ' ';
        continue;
      }
      // Verbatim when an `@` sits in the prefix just before the quote (`@"`, `$@"`, `@$"`).
      const verbatim = src[i - 1] === '@' || (src[i - 1] === '$' && src[i - 2] === '@');
      i++;
      while (i < n) {
        if (verbatim) {
          if (src[i] === '"' && src[i + 1] === '"') { i += 2; continue; }
          if (src[i] === '"') { i++; break; }
        } else {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '"' || src[i] === '\n') { i++; break; }
        }
        i++;
      }
      out += ' ';
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === "'" || src[i] === '\n') { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Type name → the CODE (comments and strings removed) of every C# file that declares it. Built lazily, one
// type at a time, because only the handful of types the docs qualify are ever asked about.
const declared = new Map();
function declaringCode(type) {
  if (!declared.has(type)) {
    const decl = new RegExp(`\\b(?:class|record|struct|interface|enum)\\s+${type}\\b`);
    declared.set(type, csFiles.filter((f) => decl.test(f)).map(csCode).filter((c) => decl.test(c)));
  }
  return declared.get(type);
}

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
  if (!fs.existsSync(file)) {
    if (OPTIONAL.has(rel)) continue;
    console.log(`  ! listed but missing: ${rel}`); failures++; continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const m of text.matchAll(IDENT)) {
    const id = m[1];
    if (seen.has(id) || !looksLikeSymbol(id)) continue;
    seen.add(id);
    checked++;
    if (ALLOWED.has(`${rel}::${id}`)) continue;
    // A QUALIFIED `Type.Member` whose Type this tree declares in C# is checked against THAT type: the
    // member must appear as code — not in a comment, not in a string — in a file declaring the type.
    // Matching only the last segment anywhere in the corpus (the fallback below) passed a renamed
    // ResourceProvisioner member because a stale comment in an e2e suite still said it, and would equally pass
    // a member moved to another class.
    const parts = id.split('.');
    if (parts.length === 2 && /^[A-Z]/.test(parts[1])) {
      const [type, member] = parts;
      const decls = declaringCode(type);
      if (decls.length > 0) {
        if (!decls.some((c) => new RegExp(`\\b${member}\\b`).test(c))) {
          console.log(`  ✗ ${rel}: \`${id}\` — ${type} is declared in the tree, but has no member ${member} `
            + '(outside comments and strings)');
          failures++;
        }
        continue;
      }
    }
    // Everything else — a type this tree does not declare (Lyntai's, the BCL's), a namespace, a longer
    // path — is checked on its LAST segment: `Foo.Bar` is satisfied by a name Bar anywhere in the code,
    // because matching the whole dotted path would fail on every method the docs qualify by its class. The
    // type half is deliberately NOT required here: the app uses Lyntai types it never names
    // (`AgentSessionOptions` is reached through an options lambda), so demanding it would flag the
    // dependency's real API — the known cost is that a MISSPELLED in-tree type falls through to this path.
    const needle = id.includes('.') && !id.endsWith('.mjs') && !id.endsWith('.cs')
      ? id.split('.').pop() : id;
    if (!code.includes(needle)) {
      console.log(`  ✗ ${rel}: \`${id}\` is named but does not exist in the tree`);
      failures++;
    }
  }
}

// ---- pass 2: markdown links to local files ----------------------------------------------------------
// A link that 404s is the same defect as a renamed class: it sends the reader somewhere and wastes the
// trip. Anchors and URLs are skipped; only local paths are resolved.
for (const rel of LIVE) {
  const file = path.join(repo, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)#: ]+\.md)[^)]*\)/g)) {
    const target = m[1];
    const candidates = [path.join(repo, target), path.resolve(path.dirname(file), target)];
    if (!candidates.some((c) => fs.existsSync(c))) {
      console.log(`  ✗ ${rel}: link to ${target} goes nowhere`);
      failures++;
    }
    checked++;
  }
}

// ---- pass 3: backticked file paths ------------------------------------------------------------------
// Resolved against every base the docs legitimately write relative to — the repo root, each server
// project, and the client source root. Docs shorten paths for readability
// (`Platform/Kernel/Services/IRecordIndex.cs`), and treating that as drift would flag the whole file.
const BASES = ['', 'src/server', 'src/server/Gatherlight.Platform', 'src/server/Gatherlight.Server',
  'src/client/src', 'docs', 'devtools'];
// The docs write `Platform/<Group>/<Name>` and `Product/Planner/<Name>` — the shape the conventions
// themselves prescribe, which names the NAMESPACE segment rather than the project directory. Mapping the
// prefix here is right: rewriting the docs to say `Gatherlight.Platform/…` would make them disagree with
// the layout rule three lines above them.
const PREFIX_ALIASES = [
  [/^Platform\//, 'src/server/Gatherlight.Platform/'],
  [/^Product\/Planner\//, 'src/server/Gatherlight.Planner/PlanIndex/'],
  [/^Product\//, 'src/server/Gatherlight.Planner/'],
];
const aliased = (p) => PREFIX_ALIASES
  .filter(([rx]) => rx.test(p)).map(([rx, to]) => p.replace(rx, to));
const PATHY = /`([A-Za-z0-9_.\/-]+\/[A-Za-z0-9_.\/-]+\.(?:cs|mjs|tsx|ts|json|ini))`/g;
for (const rel of LIVE) {
  const file = path.join(repo, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const m of text.matchAll(PATHY)) {
    const p = m[1];
    if (seen.has(p) || p.includes('{') || p.includes('*')) continue;
    seen.add(p);
    checked++;
    if (ALLOWED_PATHS.has(`${rel}::${p}`)) continue;
    const tries = [...BASES.map((b) => path.join(repo, b, p)),
                   ...aliased(p).map((a) => path.join(repo, a))];
    if (!tries.some((t) => fs.existsSync(t))) {
      console.log(`  ✗ ${rel}: path \`${p}\` does not exist under any documented base`);
      failures++;
    }
  }
}

console.log(failures === 0
  ? `check-doc-refs: OK — ${checked} identifiers across ${LIVE.length} live docs all resolve`
  : `check-doc-refs: ${failures} dangling reference(s). Rename the doc to match the code, or add doc::id to `
    + 'ALLOWED with a reason if it is named deliberately.');
process.exit(failures === 0 ? 0 : 1);
