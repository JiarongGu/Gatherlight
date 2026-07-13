# No Fabrication

**Any decision-driving fact must be cited or marked TBD. Don't make up hours, prices, requirements, or addresses to fill the page.**

## Why

A plan that confidently says "opens at 9am" and is wrong wastes a morning. The cost of `TBD — confirm on senso-ji.jp` is far smaller than the cost of an authoritative-looking fabrication.

The model's training data is stale and patchy on time-sensitive facts (opening hours, visa rules, restaurant existence). Confidence is not knowledge.

## How to Apply

Fact types that **require** a citation or TBD when written to a plan:
- Opening hours, ticket prices, reservation requirements
- Visa, vaccination, entry requirements
- Specific flight/train times and prices
- Restaurant/venue existence and current status
- Weather forecasts (and the source/date of the forecast)
- Holiday/festival/closure dates

Fact types that **don't** need citation:
- Cultural norms that are stable ("Japanese trains tend to be quiet")
- The user's own stated preferences
- Generic advice ("bring a power adapter")

Format for a cited fact:
```markdown
- Senso-ji: 06:00–17:00, free entry [(source)](https://www.senso-ji.jp/about/)
```

Format for an uncertain fact:
```markdown
- Tsukiji Outer Market: hours TBD — confirm closer to date, varies by stall
```

When the model's prior conflicts with a search result, surface it: "The site says 10:00 but I thought it was 09:00 — using 10:00." Don't silently average.

## Examples

✗ "Day 3: Senso-ji opens at 8am, ¥500 entry" (made up — actually free + 6am)
✓ "Day 3: Senso-ji 06:00–17:00, free [(source)](https://www.senso-ji.jp/about/)"
✓ "Day 3: Tsukiji breakfast — exact stall TBD, plan to wander 07:00–09:00"

## Related

- [.claude/workflows/WEB_SEARCH.md](../workflows/WEB_SEARCH.md) — when to search vs ask vs use prior knowledge.
- [link-verification.md](link-verification.md) — citing a URL that loads as blank in the user's browser is a form of fabrication. Verify deeplinks with the `scrape` tool, not WebFetch.
