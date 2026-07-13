# Packing List Workflow

Used by `/packing-list`. Produces a file at `plans/packing/<slug>.md`, usually paired with a trip.

## Inputs

1. **Trip slug** or **destination + dates** — without one of these, the list will be too generic to be useful.
2. **Trip type** — city / beach / hiking / business / mixed. Affects clothing emphasis.
3. **Duration** — drives quantities (how many shirts, socks).
4. **Weather expected** — pull from web search (forecast within a week; climate averages otherwise).
5. **Special requirements** — formal event, gym, photography gear, medications, kids' gear, pet gear.

## Steps

1. **Check past packing lists** for the same destination type. Grep `plans/packing/` for the user's past trips — what they brought and (if noted) what they regretted not bringing or wished they'd left behind.
2. **Pull trip context** from `plans/trips/<slug>.md` — daily activities tell you what gear matters.
3. **Copy the template** — [`.claude/templates/packing.md`](../templates/packing.md).
4. **Group items by category** — Clothing / Toiletries / Electronics / Documents / Health / Misc. Tweak categories to fit the trip.
5. **Quantify clothing** by duration and laundry access — "5x t-shirts" not "t-shirts".
6. **Surface weather-driven items prominently** — rain jacket, sun hat, thermals.
7. **Document-checklist is non-negotiable** — passport, visa, insurance card, vaccination record, driver's licence if renting.
8. **Add a "leaving home" mini-section** — pet sitter notified, mail held, thermostat, plants watered.

## Format

Checkboxes (`- [ ]`) so it's tickable during packing. Quantities in the item name (`- [ ] 5x t-shirts`). Notes in italics after the item.

## After the trip

Encourage the user to update the list with regrets ("never wore the blazer") or gaps ("needed earplugs"). That memory is what makes the *next* packing list good.
