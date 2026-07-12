# Rules index (dev-facing)

Core rules auto-apply to any work in this repo. Scan "Applies when" and read what matches.

| Rule | Applies when | Enforces |
|---|---|---|
| [sensitive-info.md](sensitive-info.md) | EVERY commit / tracked-file edit | No family data, dev paths, or planner content in the repo; pre-commit guard + `local/sensitive-patterns.txt` |
| [dev-conventions.md](dev-conventions.md) | Any server/client/tooling code change | Modules + async Dapper + FluentMigrator numbering, claude-CLI spawn hygiene, data-folder discipline, devtools loop |

Growing pains: when this set exceeds ~5 core rules, split into core + on-demand knowledge/
(the 2-tier sibling-project pattern) and add the index doctor to dev.mjs.
