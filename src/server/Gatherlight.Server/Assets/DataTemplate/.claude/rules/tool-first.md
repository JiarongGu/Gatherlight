# Tool First (Don't Hand-Curate Reference Data)

**When building reference content — attractions libraries, comparison tables, fact lists, anything that aggregates external info — verify each entry against live sources (via the `scrape` MCP tool and web search) rather than recalling from training data.**

## Why

Model recall is patchy on:
- Opening hours / prices / costs (drift)
- Closures / renames (recent changes are invisible to training data)
- Image URLs (often fabricated or stale)
- Address details + transit access (drift)
- Spelling of foreign names

Hand-curating a "facts library" from memory inherits all this drift. The cost is paid every time someone uses the library and acts on a wrong fact. **A library claiming verified-ness is worse than no library** — it shortcuts the user's own research.

This is the same principle as [no-fabrication.md](no-fabrication.md), extended: **when the WHOLE FILE is a fact library, the bar is "every entry has a live-verified source", not "I'll cite Wikipedia and you trust me"**.

## How to Apply

### Triggers — when this rule kicks in

- Generating a list of N attractions / venues / products with facts about each
- Comparison tables (flight options, hotel options, restaurant rankings)
- Library files like `.claude/workflows/<DESTINATION>_ATTRACTIONS.md` / `<CATEGORY>_INDEX.md`
- Any markdown file where ≥ 5 facts are factual claims about external entities

### The Tool-First Check

Before hand-curating, ask:

1. **Does an MCP tool cover this?** (Check the [`/tool-loader`](../skills/tool-loader/SKILL.md) catalog.)
   - `scrape` (`mcp__planner-tools__scrape`) — official sites, Wikipedia pages, JS-rendered pages, directory pages
   - `extract` (`mcp__planner-tools__extract`) — data locked inside user-uploaded PDFs / images
2. **If yes** → verify entry-by-entry with the tool + WebSearch, and generate the markdown from the verified data. Cite each entry with source URL + the date verified.
3. **If no tool covers it** (e.g. batch price comparison across many dates) → do the best per-entry verification you can with `scrape` + WebSearch, and **record the tool gap via [`/remember`](../skills/remember/SKILL.md)** so a future Gatherlight release can add a dedicated registry tool. Do NOT write code — this workspace has none.
4. **Only after the verification paths are exhausted** is hand-curation OK — and even then mark the output **v1 hand-curated, requires verification**.

### Marking hand-curated content

Files where hand-curation was used must include at the top:

```markdown
> ⚠️ **Hand-curated v1 — VERIFY BEFORE ACTING.** Facts in this file were recalled from model training data, not verified against live sources. Opening hours, prices, addresses, image URLs, and current status are likely stale or wrong. Verify entries (scrape tool + web search) before any decision relies on them.
```

This is not a fix — it's a warning. The fix is "verify against live sources and drop the warning".

### When hand-curation is OK

- Single-fact, single-citation (one Wikipedia URL, manually 1-shot verified)
- Subjective content the model owns ("this pace suits a family with young kids" — judgment, not fact)
- Quick scaffolding that will be tool-verified within the same session

## Examples

✗ Generating a 40-entry attractions library from memory with claims like "founded 1839", "USD 6/person", "fully step-free" — these are fact claims, not judgment.

✓ Same library, but each entry verified: `scrape` the attraction's Wikipedia article / official site, record summary + official URL, cite the verification date in the file header.

✓ Hand-curated v1 file with the **prominent warning** at the top + a TODO to verify before the user acts on it.

## Related

- [no-fabrication.md](no-fabrication.md) — single-fact analog. This rule generalizes it to file-level libraries.
- [link-verification.md](link-verification.md) — URLs in plan files must be verified.
- [/tool-loader](../skills/tool-loader/SKILL.md) — the catalog of available MCP tools.
