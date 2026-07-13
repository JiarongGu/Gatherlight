# Filename Conventions

**Plan filenames follow strict patterns so related files are discoverable by name alone. No `-v2`, `-final`, `-new` suffixes.**

## Why

Skills find related files by name. A budget file `2026-08-kyoto.md` is paired with the trip `2026-08-kyoto.md` purely because the slugs match. If filenames drift (`2026-08-kyoto-final.md`, `2026-08-kyoto-v2.md`), the pairing breaks and the user manually re-links every time.

History belongs in git (managed by the Gatherlight server), not in filenames.

## How to Apply

| File | Pattern | Example |
|---|---|---|
| Trip | `plans/trips/YYYY-MM-<slug>.md` | `plans/trips/2026-08-kyoto.md` |
| Daily | `plans/daily/YYYY-MM-DD.md` | `plans/daily/2026-05-18.md` |
| Weekly | `plans/weekly/YYYY-Www.md` (ISO week) | `plans/weekly/2026-W21.md` |
| Budget (trip) | `plans/budgets/<trip-slug>.md` (same slug) | `plans/budgets/2026-08-kyoto.md` |
| Budget (other) | `plans/budgets/<scope>.md` | `plans/budgets/2026-05-monthly.md` |
| Packing | `plans/packing/<trip-slug>.md` (same slug) | `plans/packing/2026-08-kyoto.md` |

- **Slug = kebab-case**, lowercase, no diacritics, no spaces.
- **Trip date prefix = `YYYY-MM` of departure.** Spans months → use start month.
- **Two trips in the same month** → disambiguate by destination, not by number: `2026-08-kyoto.md` and `2026-08-iceland.md`.
- **Same destination, different date plans (variants)** → use a different month prefix to distinguish: `2026-08-kyoto.md` (late-summer option) + `2026-10-kyoto.md` (autumn option) are both valid as parallel options. Each is its own canonical plan, NOT v1/v2 of the same trip. **Required**: cross-link them via a `## 🗺️ Variants` section at the top of each file with a small table (dates / theme / budget).
- **Re-planning an existing trip (same dates, different content)**: ask the user — clean rewrite (edit in place, server checkpoints the old version) or preserve history explicitly (still edit in place; git keeps the old version either way).

## Examples

✓ `plans/trips/2026-08-kyoto.md` + `plans/trips/2026-10-kyoto.md` (same destination, different-month variants coexisting)
✓ `plans/budgets/2026-08-kyoto.md` (paired with same-slug trip)
✗ `plans/trips/2026-08-kyoto-final.md` (`-final` suffix — history lives in git)
✗ `plans/trips/Kyoto Trip Aug 2026.md` (not kebab-case + has spaces)
✗ `plans/trips/2026-08-kyoto-v2.md` (`-v2` suffix — same dates, new content = edit in place)
✗ `plans/trips/2026-08-kyoto-autumn.md` (theme suffix — use a date prefix to distinguish variants instead)

## Related

- [edit-in-place.md](edit-in-place.md) — never create parallel versions.
- [absolute-dates.md](absolute-dates.md) — date components in filenames are absolute too.
