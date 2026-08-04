# Browser Automation Workflow

How to fetch dynamic / JS-rendered web content, and how to read uploaded documents. All deterministic capability comes from the MCP tools the Gatherlight server exposes (server name `planner-tools`).

## Decision tree

```
Need external content?
├─ Static HTML, public, no JS needed → WebFetch (built-in)
├─ Just need search results → WebSearch (built-in)
├─ SPA / JS-rendered / dynamic page / search deeplink → scrape (mcp__planner-tools__scrape)
└─ Content inside a user-uploaded PDF / image → extract (mcp__planner-tools__extract)
```

## `scrape` — render a page in a real browser

```
mcp__planner-tools__scrape {
  "url": "<full URL>",        // required
  "selector": "<css>",        // optional — extract only matching content
  "waitFor": "<css>",         // optional — wait for this selector first (default "body")
  "timeout": 30000            // optional — navigation timeout in ms
}
```

Returns the rendered page text. Wrapped by the [`/scrape`](../skills/scrape/SKILL.md) skill, which documents when to prefer it over WebFetch.

**Primary use — link verification** (rule [link-verification.md](../rules/link-verification.md)): search deeplinks (flight/hotel results pages) depend on client-side JS. WebFetch sees the empty shell and false-positively "succeeds". Scrape the URL and check the returned text actually contains the results before citing it in a plan.

### Limitations

- Each invocation = fresh anonymous browser. No cookies, no login, no multi-step interaction.
- Anti-bot risk: several rapid queries against the same aggregator may trigger a CAPTCHA. Space them out; reuse earlier results.
- Timeouts / SSL errors on a venue's own site often mean "closed or moved" — search for a replacement rather than citing the dead link.

## `extract` — read an uploaded file

```
mcp__planner-tools__extract {
  "relPath": "<upload reference>",   // required — the uploaded file's reference under uploads/
  "instruction": "<what to pull>"    // optional — defaults to a structured key-info summary
}
```

Read-only. Use when the user uploads a PDF / image (a booking confirmation, a form, a screenshot) and its content should inform the plan. Never read `uploads/` files directly — always go through `extract`.

## Output handling

- Prefer using tool output **inline** and discarding it.
- If a large result must persist (e.g. a scraped price table cited from a plan file), save it under `cache/` with a descriptive filename (`cache/flights-aaa-bbb-aug.json`). Never write to OS temp paths. `/cleanup` prunes `cache/` later.
- Anything scraped that ends up in a plan file still needs its source URL cited inline, with a date-stamp for prices (rule [no-fabrication.md](../rules/no-fabrication.md)).

## When a capability is missing

There is no multi-step browser session (login → click → screenshot), and no dedicated batch price-comparison tool yet. When a task needs one:

1. Fall back to `WebSearch` + per-URL `scrape`.
2. Tell the user which step they need to do themselves (e.g. log in and paste the content).
3. Record the gap via [`/remember`](../skills/remember/SKILL.md) — new tools arrive with Gatherlight releases.

Do not write scripts to work around it — this workspace has no code.

## Rules to scan

- [no-fabrication.md](../rules/no-fabrication.md) — anything scraped still needs an inline source citation in the plan file.
- [link-verification.md](../rules/link-verification.md) — deeplinks must be scrape-verified, not WebFetch'd.
- [tool-first.md](../rules/tool-first.md) — reference libraries are built from live-verified data, not model recall.
