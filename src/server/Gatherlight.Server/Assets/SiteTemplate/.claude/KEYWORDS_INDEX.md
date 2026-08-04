# Keywords Index — Top-level RAG router

> Thin router. Picks **one** sub-index for the task by keyword/scope. Sub-indices then enumerate the exact docs/files to read.
>
> Read this BEFORE you grep, glob, or read anything else. The point is to avoid loading the whole knowledge base per task.

## Sub-indices

| Sub-index | Pick when the task is about | Size |
|---|---|---|
| [keywords/planning.md](keywords/planning.md) | Any `plans/` file: trip, daily, weekly, budget, packing | ~3 KB |
| [keywords/household.md](keywords/household.md) | `household/*` updates: people, preferences, constraints, recurring | ~2 KB |
| [keywords/conventions.md](keywords/conventions.md) | Cross-cutting "how we write things" — filenames, dates, money, citations | ~2 KB |
| [keywords/automation.md](keywords/automation.md) | Browser scraping, link verification, uploaded-file extraction, scheduling background jobs | ~1 KB |

**Pick exactly one sub-index per task.** Load multiple only if the task genuinely spans scopes (e.g. "plan a trip AND update household profile with the new dietary fact").

## Quick keyword map

| Keyword in user request | Sub-index |
|---|---|
| trip, itinerary, travel, vacation, visit, flight, hotel | `planning.md` |
| day, today, tomorrow, daily, schedule | `planning.md` |
| week, weekly, this week, review | `planning.md` |
| budget, expense, cost, money, spend | `planning.md` |
| packing, bring, suitcase, gear | `planning.md` |
| visa, passport, embassy, entry requirements | `planning.md` (+ rule [verify-policy-info.md](rules/verify-policy-info.md)) |
| family, kids, partner, vegetarian, allergy, mobility, preference | `household.md` |
| date format, filename, slug, money format, currency, cite, source | `conventions.md` |
| scrape, browser, headless, dynamic page, deeplink | `automation.md` |
| verify, cross-check, audit, fabrication, fact-check, broken link | `automation.md` (verification workflows) |
| restaurant URL, directory page, hotel address verify, flight number verify | `automation.md` |
| uploaded file, PDF, image, attachment, extract | `automation.md` |
| schedule, recurring, repeat, every day/week/month, remind me, reminder, periodic report, 定期, 提醒 | `automation.md` (schedule-job) |

## Always-on (regardless of sub-index)

- [`rules/RULES_INDEX.md`](rules/RULES_INDEX.md) — scan for matching rules.
- [`AI_GUIDE.md`](AI_GUIDE.md) — navigation hub (probably already loaded).
- [`rules/verify-policy-info.md`](rules/verify-policy-info.md) — for ANY visa/flight/hours/price/policy claim, this rule's category table dictates which facts go stale + how to verify.

## Adding a new scope

When you add a new domain (e.g. shopping lists, meal planning), create `keywords/<scope>.md` and add a row to the table above. Don't grow this file — it's a router, not a memory store.
