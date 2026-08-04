---
name: tool-loader
description: Route a task to the right Gatherlight MCP tools. Core discovery skill — invoke as part of the 5-skill gate at every task start. Returns INVOKE/SKIP lists for the server-provided tool registry.
---

# Tool Loader

**Format**: `/tool-loader "task description"`

Parallels `/skill-loader` but for the **MCP tools** the Gatherlight server exposes to the agent (server name `planner-tools`, tools callable as `mcp__planner-tools__<tool>`). Keeps Claude aware of what's available without guessing.

## Tool catalog

| Tool | Call as | Input | Does |
|---|---|---|---|
| `scrape` | `mcp__planner-tools__scrape` | `{url (required), selector?, waitFor?, timeout?}` | Renders a page in a real headless browser and returns its text. The only reliable way to verify JS-rendered / SPA / search-deeplink URLs. |
| `extract` | `mcp__planner-tools__extract` | `{relPath (required), instruction?}` | Reads a user-uploaded file (PDF / image) under `uploads/` and returns extracted or summarised text. Read-only. |
| `pdf_inspect` | `mcp__planner-tools__pdf_inspect` | `{path (required)}` | Page count + size + every AcroForm field (name/type/current value). **Always the first call** before filling a form — field names come from here, never from guesswork. |
| `pdf_extract_text` | `mcp__planner-tools__pdf_extract_text` | `{path (required), maxPages?}` | Plain text out of a text-layer PDF. Zero tokens, no model call. (Scanned/image PDFs → `extract`.) |
| `pdf_fill` | `mcp__planner-tools__pdf_fill` | `{templatePath, values (name→value map), outPath, flatten?, fontPath?}` | Fills any AcroForm PDF. `flatten: true` bakes the values in (printable, no longer editable); `fontPath` embeds a font so CJK text renders. |
| `pdf_merge` | `mcp__planner-tools__pdf_merge` | `{paths (2+, ordered), outPath}` | Concatenates PDFs in order. |
| `fill_itinerary` | `mcp__planner-tools__fill_itinerary` | `{templatePath, dataPath, outPath}` | The visa-style **day-by-day table** convenience wrapper over `pdf_fill`: a JSON of `{applicationDate, rows[]}` (date / activity / contact / accommodation) → a flattened, printable schedule-of-stay PDF. |
| `image_info` / `image_resize` / `image_convert` | `mcp__planner-tools__image_info` / `…_resize` / `…_convert` | `{path}` / `{path, outPath, maxWidth?, maxHeight?}` / `{path, outPath, format}` | Dimensions + format; resize to fit a box; convert between png/jpeg/webp. |

All paths above are **workspace-relative** (e.g. `plans/visa/<trip-slug>/template.pdf`, `uploads/scan.pdf`).

Tools are provided by the server — there is nothing to install, and no code to write in this workspace. New tools arrive with Gatherlight releases.

**If a tool you expect is not in your `mcp__planner-tools__*` list, it does not exist in this install** — do not go looking for a `tools/` directory, a script, or an `npx` command to run instead. A `tools/` folder in the workspace is either server-managed or a leftover from an older layout; it is never something to invoke by hand. Report the gap to the user (see the last section).

## Routing Table

| Trigger | Tool (wrapper skill) |
|---|---|
| scrape, fetch dynamic page, extract from SPA, JS-rendered, verify deeplink, verify restaurant/hotel/flight URL | [`/scrape`](../scrape/SKILL.md) → `mcp__planner-tools__scrape` |
| user uploaded a PDF / image / document and wants its content used | `mcp__planner-tools__extract` (no wrapper skill — call directly with the upload's `relPath`) |
| fill in a form PDF, visa application, schedule of stay, "what fields does this PDF have" | `pdf_inspect` first → then `pdf_fill` (or `fill_itinerary` for a day-by-day table) |
| read a text PDF, combine PDFs, resize/convert an image | `pdf_extract_text` · `pdf_merge` · `image_resize` / `image_convert` |

## Output Format

```
### Tools to INVOKE:
- scrape — page is JS-rendered, WebFetch would return the empty shell

### Tools to SKIP:
- extract — no uploaded file involved in this task
```

If **no tool applies**:

```
### Tools to INVOKE: (none)
### Tools to SKIP:
- scrape — pure planning task, no web data needed
- extract — no uploaded file
```

Still print, so the gate's atomicity is visible.

## When the task needs a tool that doesn't exist

There is no dedicated flight-price / hotel-price / restaurant-batch tool yet. For those tasks:

1. Fall back to `WebSearch` + per-URL `scrape` verification (see [link-verification.md](../../rules/link-verification.md)).
2. Date-stamp every scraped price/fact in the plan file.
3. Record the gap via [`/remember`](../remember/SKILL.md) so it can inform a future Gatherlight release.

Do NOT write scripts or code to fill the gap — this workspace has no code, and a script you write here would not become a tool.

**Say what's missing, then offer the next step.** A missing capability is a normal answer, not a dead end — but don't stall on it either. Tell the user plainly which tool is absent, what you *can* do without it (the fallback above), and that a new tool can be added for them if it's worth it. Adding one is a **privileged** action — a tool runs outside the planner's sandbox, with the server's own permissions — so it is the user's decision and their approval, never something to arrange yourself or route around.

## Coupling

- [`/doc-loader`](../doc-loader/SKILL.md) → docs to read
- [`/skill-loader`](../skill-loader/SKILL.md) → planning skills to invoke
- **`/tool-loader`** → MCP tools to invoke (this skill)
- [`/pattern-finder`](../pattern-finder/SKILL.md) → past-plan greps to run
- [`/caveman`](../caveman/SKILL.md) → compressed mode

All five run in parallel during the gate. None overlap.
