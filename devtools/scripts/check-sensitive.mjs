#!/usr/bin/env node
// Sensitive-info guard — blocks committing dev-machine paths or private family data (names, DOBs,
// flight/booking numbers, trip specifics) into this repo. Gatherlight's history was reset on
// 2026-07-13 to remove exactly these leaks; user data now lives only in the untracked data folder
// (local/). Runs from the pre-commit hook (devtools/hooks/pre-commit); also runnable by hand.
//
//   node devtools/scripts/check-sensitive.mjs          # scan STAGED changes (what pre-commit does)
//   node devtools/scripts/check-sensitive.mjs --tree   # scan every tracked file
//
// The tracked patterns here are STRUCTURAL only (generic path shapes) — safe to publish. The real
// sensitive tokens (family names, DOBs, bookings) live in the gitignored local/sensitive-patterns.txt,
// loaded at runtime. Absent that file, the built-ins still run and a notice is printed.
// Exit 1 (blocks the commit) on any match, 0 when clean.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tree = process.argv.includes('--tree');

// Structural, non-secret patterns — a Windows home/dev-root absolute path is always a leak here
// (docs use repo-relative paths or neutral placeholders instead).
const builtins = [
  { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i, why: 'Windows user-home absolute path' },
  { re: /[A-Za-z]:\\Development\\/i, why: 'dev-machine project-root absolute path' },
];

// Private tokens (gitignored). Each non-comment line is a JS regex source.
const patterns = [...builtins];
const localFile = path.join(repo, 'local', 'sensitive-patterns.txt');
if (existsSync(localFile)) {
  for (const raw of readFileSync(localFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try { patterns.push({ re: new RegExp(line, 'i'), why: 'private ban pattern' }); }
    catch { console.error(`check-sensitive: bad regex in local/sensitive-patterns.txt: ${line}`); }
  }
} else {
  console.error('check-sensitive: local/sensitive-patterns.txt missing — running built-ins only.');
}

const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Files to scan + a getter for their content (staged blob vs on-disk).
let files, contentOf;
if (tree) {
  files = git(['ls-files']).split('\n').filter(Boolean);
  contentOf = (f) => { try { return readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
} else {
  files = git(['diff', '--cached', '--name-only', '--diff-filter=ACM']).split('\n').filter(Boolean);
  contentOf = (f) => { try { return git(['show', `:${f}`]); } catch { return ''; } };
}

const hits = [];
for (const f of files) {
  const content = contentOf(f);
  if (content.includes('\0')) continue; // binary
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { re, why } of patterns) {
      const m = lines[i].match(re);
      if (m) hits.push({ f, line: i + 1, why, snippet: m[0] });
    }
  }
}

if (hits.length === 0) {
  if (tree) console.log('check-sensitive: clean — no dev-machine paths or private family data in tracked files.');
  process.exit(0);
}

console.error('\n\x1b[31m✖ check-sensitive: blocked — private-data leak(s) detected:\x1b[0m');
for (const h of hits) console.error(`  ${h.f}:${h.line}  [${h.why}]  …${h.snippet}…`);
console.error('\nFix: use a repo-relative path / neutral placeholder, or move the value to local/.');
console.error('See .claude/rules/sensitive-info.md. (Override once with: git commit --no-verify)\n');
process.exit(1);
