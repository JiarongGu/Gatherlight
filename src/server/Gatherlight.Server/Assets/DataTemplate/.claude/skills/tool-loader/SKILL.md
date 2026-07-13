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

Tools are provided by the server — there is nothing to install, and no code to write in this workspace. New tools arrive with Gatherlight releases.

## Routing Table

| Trigger | Tool (wrapper skill) |
|---|---|
| scrape, fetch dynamic page, extract from SPA, JS-rendered, verify deeplink, verify restaurant/hotel/flight URL | [`/scrape`](../scrape/SKILL.md) → `mcp__planner-tools__scrape` |
| user uploaded a PDF / image / document and wants its content used | `mcp__planner-tools__extract` (no wrapper skill — call directly with the upload's `relPath`) |

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

Do NOT write scripts or code to fill the gap — this workspace has no code.

## Coupling

- [`/doc-loader`](../doc-loader/SKILL.md) → docs to read
- [`/skill-loader`](../skill-loader/SKILL.md) → planning skills to invoke
- **`/tool-loader`** → MCP tools to invoke (this skill)
- [`/pattern-finder`](../pattern-finder/SKILL.md) → past-plan greps to run
- [`/caveman`](../caveman/SKILL.md) → compressed mode

All five run in parallel during the gate. None overlap.
