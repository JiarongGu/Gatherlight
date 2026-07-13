# Keywords — Automation

Used by `/doc-loader` when the task involves browser scraping, link verification, or reading uploaded files.

## Routing table

| Task | Read |
|---|---|
| Generic page scrape (SPA / dynamic / JS-rendered) | [workflows/BROWSER_AUTOMATION.md](../workflows/BROWSER_AUTOMATION.md), [/scrape skill](../skills/scrape/SKILL.md) |
| Verify a link before citing it (flight/hotel deeplinks, restaurant directory pages) | [rules/link-verification.md](../rules/link-verification.md), [/scrape skill](../skills/scrape/SKILL.md) |
| Verify a policy fact (visa / flight number / hours / event dates) | [rules/verify-policy-info.md](../rules/verify-policy-info.md), [workflows/WEB_SEARCH.md](../workflows/WEB_SEARCH.md) |
| Build a reference library / fact list (verified, not hand-curated) | [rules/tool-first.md](../rules/tool-first.md), [workflows/BROWSER_AUTOMATION.md](../workflows/BROWSER_AUTOMATION.md) |
| User uploaded a PDF / image whose content should inform the plan | [workflows/BROWSER_AUTOMATION.md](../workflows/BROWSER_AUTOMATION.md) §extract |

## Tools (provided by the Gatherlight server over MCP)

- `scrape` — `mcp__planner-tools__scrape` `{url, selector?, waitFor?, timeout?}` — render a JS page in a real browser, return text. Wrapped by [`/scrape`](../skills/scrape/SKILL.md).
- `extract` — `mcp__planner-tools__extract` `{relPath, instruction?}` — read an uploaded file under `uploads/`, return extracted/summarised text.

New tools arrive with Gatherlight releases — record gaps via [`/remember`](../skills/remember/SKILL.md).

## Rules to scan

| Rule | Why |
|---|---|
| [no-fabrication.md](../rules/no-fabrication.md) | Scraped data still needs source citation in plan files |
| [link-verification.md](../rules/link-verification.md) | Deeplinks must be scrape-verified, not WebFetch'd |
| [verify-policy-info.md](../rules/verify-policy-info.md) | Time-sensitive policy facts need live verification |
| [tool-first.md](../rules/tool-first.md) | Reference libraries are built from live-verified data |
