#!/usr/bin/env node
// Synthetic fixture data folder for e2e suites — clearly fictional content, no real family data.
// Usage: node devtools/scripts/make-test-data.mjs [target]   (default devtools/_e2e-data)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = path.resolve(repo, process.argv[2] ?? 'devtools/_e2e-data');

fs.rmSync(target, { recursive: true, force: true });

const write = (rel, content) => {
  const abs = path.join(target, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
};

write('plans/trips/2026-08-kyoto.md', `# 京都 5 天(fixture)

| Field | Value |
|---|---|
| Dates | 2026-08-10 → 2026-08-14 |
| Travelers | 2 |
| Budget | JPY 200000 |

## Day 1 — 2026-08-10 (Mon) — 抵达
- 14:00 抵达 KIX
- Hotel Fixture Kyoto check-in
`);

write('plans/budgets/2026-08-kyoto.md', `# 京都 5 天预算(fixture)

| Category | Cap |
|---|---|
| Lodging | JPY 80000 |
| Food | JPY 50000 |
`);

write('household/people.md', `# 家庭成员(fixture)

### Member A
- Dietary: vegetarian (fixture)
`);

write('.claude/templates/trip.md', `# Trip Template (fixture)

| Field | Value |
|---|---|
| Dates | TBD |
`);

write('plans/visa/2026-08-kyoto/applicant-data.json',
  JSON.stringify({ applicationDate: { year: '2026', month: '08', day: '01' }, rows: [] }, null, 2));

console.log(`fixture data folder written: ${target}`);
