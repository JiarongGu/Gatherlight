# Edit in Place

**When the user asks to update a plan, edit the existing file. Never create `-v2`, `-final`, or `-new` siblings.**

## Why

Git tracks history — the Gatherlight server commits every change the user approves, so old versions are always recoverable. Filename suffixes don't track history; they fragment the planner into orphan files that future sessions can't tell apart. The user ends up with `kyoto.md`, `kyoto-final.md`, `kyoto-final-actually.md` and no idea which is canonical.

## How to Apply

- User says "update the trip", "revise this", "let's change Tuesday" → use the Edit tool on the existing file.
- User explicitly says "start over" or "throw it out and re-plan" → still edit in place (overwrite). The server's approved checkpoints keep the old version.
- The ONE exception: if the user wants to *fork* a plan (e.g. "draft a version where we go to Tokyo first vs. Kyoto first"), it's fine to create a temporary `alt/` file — but then collapse back to one canonical file after they pick.
- Never auto-create a backup copy "just in case". That's git's job — and git is the server's job.

## Examples

✗ User: "let's redo day 3 with hiking instead" → assistant creates `2026-08-kyoto-v2.md`.
✓ User: "let's redo day 3 with hiking instead" → assistant Edits `2026-08-kyoto.md` in place.

## Related

- [filename-conventions.md](filename-conventions.md) — no suffix variants.
