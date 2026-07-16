# `default-site/` — pristine default frontend (update cherry-pick baseline)

This holds the **default frontend as shipped by the current app version** — the "theirs" side of an
AI-assisted merge. It is app/version-managed: the startup migration / auto-update overlays the new
default here on each release. The planning agent **never writes** here (it is under the protected
`guard/` folder), but **freely reads** it.

## How it's used

1. On install, `src/client` starts equal to this default.
2. The local AI (系统模式) may customize `src/client` for the family.
3. A new version changes the default page → the new default lands here.
4. The local AI diffs this baseline against the customized `src/client` and **cherry-picks the
   upstream changes in**, reconciling version updates with local customizations instead of the
   update clobbering the user's page.

## Content

The default UI *source* the AI can meaningfully merge (pages / screens / config), **excluding**
build artifacts (`dist/`) and dependencies (`node_modules/`). Population of this folder with the
per-version default — and the cherry-pick flow that consumes it — is owned by the startup migration
subsystem (a separate sub-project; out of scope for the scope-guard change that introduced this
folder — see `docs/superpowers/specs/2026-07-16-system-guard-write-scope-design.md`).
