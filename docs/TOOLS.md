# Tools — built-in and hot-loadable

Gatherlight has one tool registry serving two surfaces: **HTTP** (`GET /api/tools`,
`POST /api/tools/call` — used by the web UI) and **MCP** (`/mcp` — called by the spawned chat
agent mid-conversation, names like `mcp__planner-tools__scrape`). A tool defined once appears on
both.

## Built-in tools (C#, compiled)

Implement `IGatherlightTool` (`Name` / `Description` / `InputSchema` via the `ToolSchema` builder /
`RunAsync`), register in `GatherlightApp.cs`. Use a built-in when the tool needs server services
(LLM runner, uploads, DB) or heavy dependencies. Current set (24):

- **AI / web**: `extract` (one-shot Claude over an uploaded file), `scrape` (Playwright headless
  chromium), `wiki_info` (Wikipedia REST + Wikidata).
- **Travel verifiers** (C#/Playwright native — `Product/Planner/Scrapers`, no Node): `flight_schedule` +
  `policy_check` (single-query, cross-source), `flight_prices` + `hotel_prices` (Kayak/Booking
  price snapshots), `hotel_info` + `restaurant_info` (DuckDuckGo search → trusted-source
  verification). All share `PlaywrightScraper` (navigate+extract on the one browser); parse is
  deterministic and fixture-tested (e2e-p11 + p12).
- **Documents / media** (`Platform/Capabilities/Documents`): `pdf_inspect` (pages + AcroForm fields + values +
  metadata), `pdf_extract_text` (PdfPig, zero-LLM), `pdf_fill` (fill any AcroForm from a field map,
  optional flatten + CJK font — pdf-lib), `pdf_merge`, `image_info`, `image_resize`,
  `image_convert` (ImageSharp). `fill_itinerary` is the visa-specific convenience over `pdf_fill`.
- **Zero-LLM planner**: `budget_scan` (honest budget figures).
- **Cross-session memory**: `remember_fact` / `recall_facts` / `expand_fact`. The `knowledge` table is
  the record of truth; a **derived graph index** (Lyntai's memory engine, `Storage/Knowledge/FactIndex`)
  ranks it. Entries decay by what has happened in the index rather than by the clock, so a scraped
  price nobody has used sinks beneath fresher material; recall reinforces what it returned; and facts
  recalled together get linked, so `expand_fact` on a hit's `ref` reaches material the query never
  matched. No embedder is involved. Recall reports which ranker answered (`ranked: graph|fts`) and
  falls back to FTS whenever the index has nothing — an empty index must never read as "you know
  nothing". Back-filled at startup (`FactIndexStep`), fully rebuilt after a backup import.
- **Knowledge library** (`Platform/Storage/Library`): `library_upsert` / `library_search` / `library_import` / `library_delete` —
  verified reference entities (attractions/venues/hotels: name, coords, official URL, image,
  confidence) in the first-class `library_item` table, browsed read-only at `GET /api/library`.
  Replaces the old hand-written `ATTRACTIONS.md` pattern: knowledge is queryable data, not a
  markdown blob for display.

Library split (each does what it's reliable at): **PdfPig** (MIT) for PDF text extraction;
**pdf-lib** (Node leaves in `tools/pdf-form`) for AcroForm inspect / fill / merge — robust on real
+ CJK PDFs where PDFsharp's appearance/import paths throw; **ImageSharp** 3.1.x (Apache-2.0) for
images. Node leaves are launched via `cmd.exe /c npx` on Windows (invoking `npx.cmd` directly
breaks its `%~dp0` self-location).

## Script tools (hot-loadable — no rebuild)

For everything else, drop a folder into the **data folder**:

```
{data}/tools/<name>/
  tool.json     # the manifest (below)
  run.mjs       # or any executable the manifest points at
```

The server watches `{data}/tools/` and reloads on any `tool.json` change, but a script tool is off
by default: it only appears on HTTP + MCP once its id is named in `site.json`'s
`capabilities.enabled` (a bare id is the most restricted grant — no network, `cache`-only writes).
Absent that entry it 403s instead of running. Scaffold one with:

```bash
node devtools/dev.mjs new-tool <name>      # into ./local by default — also enables it (bare grant)
```

Once enabled, it appears on HTTP + MCP within ~1s and the chat agent's `--allowedTools` picks it up
on its next run.

### tool.json

```json
{
  "name": "fx_rate",
  "description": "查当日汇率(shown to the agent — write it like a good tool description)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "from": { "type": "string", "description": "ISO currency, e.g. JPY" },
      "to":   { "type": "string", "description": "ISO currency, e.g. AUD" }
    },
    "required": ["from", "to"]
  },
  "command": { "exe": "node", "args": ["run.mjs"] },
  "timeoutSeconds": 60,
  "surfaces": ["http", "mcp"]
}
```

- `name` — ascii kebab/snake case, unique. **Built-ins win on collision.**
- `inputSchema` — JSON Schema; the registry enforces `required` before spawning.
- `command.exe` + `command.args` — spawned with the tool's folder as cwd, **no shell**.
- `timeoutSeconds` — 1–300 (default 60); the process tree is killed on timeout.
- `surfaces` — omit for both.

### The script contract

- **stdin**: the validated arguments as one JSON object (UTF-8, no BOM).
- **stdout**: the result — JSON for structured data, plain text otherwise.
- **stderr**: logs (surfaced in the error message on non-zero exit).
- **exit 0** = success; anything else = tool failure (stderr tail returned to the caller).

### Rules of the road

- Script tools run **sandboxed**, never with server privileges: `node --permission` scoped to the
  filesystem paths named in the tool's `capabilities.enabled` grant (`fs.read`/`fs.write` name
  manifest record directories or the literal `cache`), plus a platform `--import` preload that
  removes network access unless the grant sets `"net": true`. They are authored by you (or a Claude
  Code dev session on this repo) — or **drafted by the chat agent itself**: it writes the same
  `tool.json` + entry-script shape to `.claude/tool-drafts/<id>/` (still inside its own write scope,
  no scope-guard change needed) and ends its turn with `TOOL_DRAFT: <id>`. A draft is never loaded by
  the registry — it is inert until a human sees the approval card (built from the draft's own grant,
  never its description) and enables it, which copies it into `{data}/tools/<id>/` and appends the
  grant to `capabilities.enabled` unchanged. From there it's a script tool like any other. Absent a
  draft, when the agent hits a missing-tool gap it records it via `/remember`; you decide whether to
  create the tool and enable it.
- A broken manifest is skipped with a warning — it never takes the server or other tools down.
- Prefer a script tool first; promote to a C# built-in when it needs server internals or becomes
  hot-path (see `docs/ROADMAP.md` phase 7 for the porting pattern).
