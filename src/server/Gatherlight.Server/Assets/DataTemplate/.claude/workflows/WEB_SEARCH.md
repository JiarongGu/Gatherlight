# Web Search Workflow

When and how to use `WebSearch` / `WebFetch` while planning.

## When to search

Search when the answer is **load-bearing for a decision** and **time-sensitive**. Skip search when the user already gave you the fact or it's stable knowledge.

| Searchable | Why |
|---|---|
| Opening hours, ticket prices, closure dates | Change frequently; getting them wrong wastes a day. |
| Weather (within 7 days), seasonal climate | Drives packing and itinerary. |
| Flight options, train schedules between cities | Decision input for the day-by-day. |
| Visa requirements, vaccination requirements | Legal/health gates — must be right. |
| Local holidays / festivals on the dates | Closures, crowds, surge pricing. |
| Specific restaurant / venue confirmation | Existence and reservation policy. |

| Not worth searching | Why |
|---|---|
| "What's there to do in Paris" | Too generic; you'll get a listicle. Ask the user what *kind* of thing first. |
| Stable cultural norms ("tipping in Japan") | The model knows; verify only if cited as load-bearing. |
| User's own preferences | Ask the user. |

## How to cite

Inline, after the fact, in markdown link form:

```markdown
- Senso-ji is open 06:00-17:00, free entry [(source)](https://www.senso-ji.jp/about/)
```

If multiple facts come from one source, cite once at the end of the bullet block. If a fact is derived from a paywalled page or one that may decay (e.g. a news article), include the date you accessed it.

## When the page needs JS to render

`WebFetch` only sees static HTML. For SPA / booking-site / search-deeplink URLs, use the `scrape` MCP tool instead — see [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md) and [link-verification.md](../rules/link-verification.md).

## When the search disagrees with the user

Surface it. "You mentioned the museum opens at 9, but the official site lists 10 — want me to use 10?" Don't silently overwrite user-provided facts.

## When the search returns nothing useful

Say so explicitly: "I couldn't find an authoritative source for X — I'd mark it TBD and verify on the day, or you may have a better reference." Don't fabricate.

## Search budget

Don't run >5 searches per planning turn without surfacing what you're doing. If you need that many, batch the questions for the user first — sometimes they already know.
