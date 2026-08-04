# Site manifest + platform seam — design (S1)

> 2026-08-04 · sub-project **S1** of the platform track. Status: implemented — see
> `docs/superpowers/plans/2026-08-04-site-manifest-platform-seam.md`.

## Why

Gatherlight is two things wearing one coat: an **agent runtime** and a **family-planner product**.
Of the 27 server modules, `Security` `Update` `Resources` `Migration` `Tools` `Llm` `Jobs` `Trace`
`Files` are runtime; `PlanIndex` `Documents` `Library` `Knowledge` `Seed` `Scrapers` and the planner
gates inside `Chat` are product. Nothing marks the seam, so every new capability has to guess which
side it belongs on, and the guesses leak.

The target: **Gatherlight becomes a host, container and harness for one agent-driven site.** The
site is data + knowledge + granted capabilities + a declarative UI spec + an agent. The platform
supplies the container, the harness, the gates, the component library and the observability. The
planner is that site.

The forcing evidence is concrete. The PDF-form tools shipped dead in every installed copy because
the packaging contract for one class of capability existed only in a maintainer's head; and there
are currently **five** unrelated ways a tool can exist (compiled C#, Node leaf, script tool,
outbound MCP, agent draft), each with its own discovery, packaging, trust level and failure mode.
Those are symptoms of a missing model, not five separate bugs.

**This spec covers S1 only: declaring what the site is, and drawing the line between it and the
platform.** S2 (capabilities) and S3 (UI spec) both hang off that declaration.

## Scale: exactly one site

**This is not multi-site hosting.** There is one site. No registry, no `sites/<id>/` collection, no
site-scoped routing, no multi-site UX — none of it is built, and none is planned.

The reason is not merely YAGNI. **Gatherlight's value is one accumulated pool** — the household
knowledge base, the library, the memory, the entities, and the cross-references between them. A trip
plan is worth more because the library already holds a verified venue and the household profile
already holds a dietary constraint. Splitting into isolated sites would fragment exactly the asset
that makes the product useful, and every isolation boundary between sites would be a wall through
the middle of the shared brain. Single-site is therefore the *right* model, not a deferred one.

That has teeth in the other direction too: any decision below that can only be defended by "sites
must not leak into each other" is cut. Two boundaries earn this work, and both bind at one site:

- **product ↔ platform** — the seam that stops every new capability having to guess which side it's on.
- **capability ↔ everything** — what S2's threat model (a mistaken agent, a prompt-injected agent,
  untrusted capability code) actually needs contained.

## What the container is for

**Walls, not a leash.** The container's job is to bound the blast radius of a *mistake* — and inside
those walls the agent should be generously equipped and left alone to work. Three consequences that
shape every decision below:

- **Tooling is the platform's responsibility, and it should be abundant.** The agent should not have
  to invent a tool to do ordinary work; it should find one already there. Tools are written, vetted,
  versioned and shipped through the normal release and update path — which is also what makes them
  cheap to fix centrally when one is wrong.
- **Freedom inside the walls.** Behaviour is not controlled by tightening the toolset or scripting
  the agent's steps. It is controlled by the boundary, which is few, hard and well understood.
- **Trust follows provenance, not enumeration.** A tool the platform ships is trusted because *we*
  wrote and shipped it. A capability that did not come from us — an agent-drafted tool, an external
  MCP server — is the untrusted case, and that is where explicit human enablement belongs.

## Goals

1. One declared place — a manifest — saying what the site's records are, what capabilities it holds,
   how its agent is configured, and which template version it came from.
2. Platform state (access token, TLS key, database, resource store, logs) is unreachable from the
   site's jail, by layout rather than by rule.
3. The scope guard becomes **data-driven** — its write list read from the manifest instead of
   hardcoded.
4. The platform ships a versioned **site template** and seeds itself on first run.
5. Migration is near-zero risk: no file moves, no path rewrites, no database changes.

## Non-goals (deliberately deferred)

| Deferred to | What |
|---|---|
| **S2** | Capability manifests, permission grants, process sandboxing, the escalation harness, whether outbound MCP connections become a granted capability |
| **S3** | The declarative UI spec schema, the approved component library, the renderer |
| **S4** | Extracting product modules behind the boundary; the client's own separation |
| **Dropped** | Multi-site anything — registry, per-site routing, site switching, faulted-site handling |

S1 ships with the client unchanged and no route changes at all.

## Layout

Today's layout, plus a manifest. Nothing moves.

```
{data}/
  site.json                  THE MANIFEST — the new thing
  plans/  household/         record dirs — named BY the manifest, not by the platform
  .claude/                   knowledge base + the generated scope guard
  uploads/  cache/
  .git/                      the site's private repo — the diff-approval audit trail
  state/                     PLATFORM — outside the site's jail, unchanged
    gatherlight.db           one database, platform-owned, never inside the jail
    settings.json  logs/  resources/  gatherlight-tls.pfx  .update/
```

The database **stays in platform `state/`**, where it already is. An earlier draft of this design
put a database inside the site directory; that was strictly worse — a capability with file-read
inside the site would have been able to open it. Keeping it in `state/` means the agent and its
capabilities never see the database at all, which is already true today and is the property
`JudgeTools` relies on.

## The manifest

`site.json` is the load-bearing object: what the console renders, what the guard is generated from,
and — the point — **the thing a human approves changes to**. A capability grant, a knowledge-base
upgrade, a new page spec all become edits to one file readable in a single screen, instead of
behaviour spread across five mechanisms.

```json
{
  "name": "家庭规划 · Family planner",
  "template": { "id": "planner", "version": "1.0.0" },
  "agent": { "model": null, "promptPack": "planner" },
  "records": ["plans", "household"],
  "capabilities": {
    "deny": [],
    "enabled": []
  },
  "ui": { "spec": "ui/", "specVersion": 1 }
}
```

`records` names the directories the site's agent may write, its git repo tracks, and its plan index
scans. **The platform imposes no layout.** That one line turns the scope guard from hardcoded into
manifest-driven: `WRITE_DIRS` becomes `records + [".claude"]`, read from the manifest at generation
time.

`PROTECTED` stays hardcoded (`.claude/hooks`, `.claude/settings*.json`). A site must not be able to
widen its own jail by editing its own manifest — so `site.json` itself is **outside** the agent's
write scope, and changing it is a human-approved action through the console.

### Two control planes

"Capability" means **the platform's MCP tool registry** — the 33 registered `IGatherlightTool`s the
site agent calls as `mcp__planner-tools__*` (scrapers, PDF/image, library, memory, index, jobs,
notify), plus hot-loaded script tools and proxied external MCP servers. That is what the manifest
governs.

It does **not** mean the CLI's own built-ins — `Read` `Grep` `Glob` `Edit` `Write` `MultiEdit`
`Bash` `WebFetch` `WebSearch` `Skill` `TodoWrite`. Those are not granted per site; they are bounded
by the scope guard, which is the wall itself. Keeping the two planes distinct is what stops the
manifest from drifting into a second, competing permission system.

One gap the split makes visible: the guard's PreToolUse matcher is
`Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob`. **`WebFetch` is granted to the agent and
intercepted by neither plane** — the exfiltration residual the guard documents. It is therefore the
one realistic use for `deny`, which is why `deny` spans both planes rather than only capabilities.

### What the manifest records

`capabilities` is **not** an enumeration of what the agent may use. Platform-shipped tools are
available by default, because they are trusted by provenance — we wrote them, vetted them and
shipped them, and an allow-list would add a manifest edit to every release that adds a tool while
buying no safety. The manifest instead records the two things a human genuinely decides:

- `deny` — anything agent-callable that is deliberately withheld, spanning **both** planes: a shipped
  MCP tool, or a CLI built-in such as `WebFetch`. Normally empty; its motivating case is closing the
  ungoverned fetch path above.
- `enabled` — capabilities that did **not** come from the platform (an agent-drafted tool, an
  external MCP server) and are therefore off until a human turns them on. This is the list that
  matters, and in S2 each entry grows from an id into a grant object with its permissions. The
  reader accepts both shapes, so S2 is purely additive.

`agent.model: null` means "inherit the platform default".

## The seam in code

`IDataContext` splits along the line it has always straddled:

| Type | Owns |
|---|---|
| `ISiteContext` | site root, the declared record dirs, `.claude/`, `uploads/`, `cache/`, the git repo, and `ResolveSitePath` — the single guarded path resolution |
| `IPlatformContext` | `state/`, the database path, `resources/`, `logs/`, the update staging area, security material |

Every path already flows through `ResolveDataPath`, which already returns `null` on escape — it
becomes `ISiteContext.ResolveSitePath` and stays the one enforcement point, so call sites do not
change shape. A module's constructor then *declares which side it is on* by which context it takes,
which is the seam made mechanical: a product module that suddenly needs `IPlatformContext` is
visible in review.

The single database is **not** split, and no table moves. Ownership is recorded in
`dev-conventions.md` as a note — product tables (`plan_index`, `library_item`, `knowledge`,
`entity`, `job`, `chat_*`, `lyntai_*`, …) versus platform ones (`app_config` security/update/
resources keys, `notification`, `process_log`) — so a future split has a starting point. Splitting
the file buys tidiness at the cost of a migration and is reconsidered only if a second site ever
exists; there is no runtime assertion, because at one site there is nothing for it to catch.

## Project structure

The seam has to be visible in the tree, or new code keeps landing on whichever side the author
guessed. One rule decides placement:

> **A module is Platform if it survives the planner being replaced by a different site** — that is,
> if it does not know about plans, trips, budgets, household or travel.

Applying it to all 27 modules produces a lopsided result worth stating plainly: **about 20 are
already Platform.** The product is far thinner than the module count suggests — the app has been
becoming a platform for a while without being labelled one.

```
src/server/Gatherlight.Server/
  Platform/
    Kernel/        Core — contexts, ResourcePaths, app config, text
    Site/          NEW (S1) + Seed — manifest, ISiteContext, template install, guard generation
    Hosting/       Security · Update · Resources · Migration · Settings · Fluent
    Agent/         Llm · Chat — sessions, gates, SSE, environment issuance
    Capabilities/  Tools · McpClient · Documents — registry, MCP endpoint, script tools, media
    Storage/       Library · Knowledge · Memory · Files · DataRepo · Backup
    Ops/           Jobs · Trace · Scoring(framework) · Eval · Playground · Cortex
  Product/
    Planner/       PlanIndex · domain scrapers · planner scorer dimensions · fill_itinerary
```

Namespaces follow the folders (`Gatherlight.Server.Platform.Agent`,
`Gatherlight.Server.Product.Planner`). Three placements are deliberate and were decided rather than
defaulted:

- **Generic stores are Platform.** `Library`, `Knowledge` and `Memory` are domain-neutral machinery —
  entities, facts, FTS, import/export. The travel-flavoured content lives in the data, not the code,
  which is the same store-from-content split Lyntai already makes.
- **`Scrapers` splits.** Generic `scrape` is platform tooling; `flight_prices`, `hotel_prices`,
  `restaurant_info` and `policy_check` are travel domain and go to Product.
- **`Cortex` splits.** The prompt registry and model routing are platform machinery; the prompt
  *content* is planner voice and moves into the site template.

`fill_itinerary` is a visa-shaped wrapper over the generic `pdf_fill`. It is a candidate to stop
being compiled C# and become a **template-shipped script tool** — which would make it the first real
proof of the capability model rather than an exception to it. Decided in S2, not here.

### Enforcing the direction

> **Platform must never reference Product.**

Staged in two steps, because compiler enforcement and a moving design don't mix:

1. **S1** — the reshuffle lands as its own commit: mechanical, **zero behaviour change**, suite green
   either side. Alongside it, an architecture test scans namespaces and fails the build on an
   illegal reference. New code lands on the correct side from that day.
2. **S4** — the split into `Gatherlight.Platform` and `Gatherlight.Planner` assemblies, where the
   project reference direction makes the rule unbreakable rather than merely tested. Deferred to
   S4 deliberately: a project split surfaces every hidden coupling at once, and that is worth doing
   when the product surface has stopped moving.

This supersedes the flat `Modules/{Name}/` convention in `.claude/rules/dev-conventions.md`, which
is updated as part of the same commit.

## Template + first-run seeding

Today `Assets/DataTemplate` and `ZhikuSeeder` seed one knowledge base. That gains a manifest and a
version:

```
src/server/Gatherlight.Server/Assets/SiteTemplate/       ← source
  site.json      agent config, record dirs, starting capability grants
  .claude/       knowledge base (today's DataTemplate, unchanged)
  plans/  household/   record scaffold — category dirs + README stubs
  ui/            starting page specs (inert in S1; the renderer is S3)

→ ships to res/template/ , resolved by ResourcePaths across dev and bundle layouts
```

Three deliberate properties:

1. **First run seeds itself**, including the manifest, so a fresh install boots into something real.
   This is a step in the existing `StartupMigrationRunner` — versioned, ordered, behind the 503 gate
   with a console overlay, and self-healing on a half-finished run.
2. **The template carries restrictions, not grants.** Shipped tools are on by default; the template
   only records anything deliberately withheld and anything non-platform that a human enabled. A new
   release that adds a tool makes it usable immediately, with no manifest edit — which is the point
   of tooling being the platform's job.
3. **The instance diverges; upgrades merge.** Today's behaviour, unchanged: unmodified files
   auto-upgrade with the template, diverged files become merge candidates for review.
   `ZhikuMigrator` gains the template id and version.

Templates ship **in the bundle, verified at build time** — the rule `dev-conventions.md` gained
after the `res/tools/` incident applies identically here.

## Migration

One ordered step in `StartupMigrationRunner`, and it is deliberately dull:

1. If `site.json` is absent, write it — `records: ["plans","household"]` inferred from what exists,
   capabilities set to the tools the planner uses today, template stamped at the current version.
2. Regenerate the scope guard from the manifest (same logic, same write dirs — the output should be
   byte-identical to what is there now, which is the assertion).

No file moves. No path rewrites. No database changes. The step is idempotent, and a crash leaves a
missing or partial `site.json` that the next boot rewrites.

## Failure handling

A `site.json` that will not parse is **fatal and loud** rather than silently defaulted: the server
reports it through the existing 503 startup gate with the parse error, because a manifest that
cannot be read means the guard cannot be generated, and generating a guard from guessed defaults is
exactly the wrong failure mode for a security boundary.

A manifest that parses but names a record directory that does not exist creates it.

**S1 records `deny` and `enabled`; it does not enforce them.** Wiring either list to the tool
registry — and deciding what an unregistered id in them should do — is S2, alongside the grant
objects those entries grow into. Declaring the fields now is deliberate: it fixes the manifest's
shape before anything depends on it, so S2 is additive rather than a breaking edit to a file users
already have.

## Testing

Extends the existing guard suite (`p24`) and adds a small `p37`; the acceptance gate is the whole
existing suite.

| Check | Asserts |
|---|---|
| fresh boot | first run seeds the template including `site.json`; the planner serves normally |
| manifest drives the guard | changing `records` regenerates `WRITE_DIRS` to match |
| manifest cannot widen the jail | `PROTECTED` holds regardless of manifest content; `site.json` is not agent-writable |
| platform state unreachable | `ResolveSitePath` refuses `state/` — token, TLS key, database, resources |
| context split | product modules resolve `ISiteContext`; platform modules resolve `IPlatformContext` |
| migration is inert | an existing data folder gains only `site.json`; the regenerated guard is byte-identical |
| bad manifest | an unparseable `site.json` fails startup loudly with the parse error, never a default guard |
| **the planner works** | **the full existing suite green — the real acceptance test** |

## Decisions of record

- **One site, no registry — because the knowledge is shared.** Multi-site was considered and
  dropped. The product's value is one accumulated pool (knowledge base + library + memory +
  entities, and the cross-references between them); isolating sites would wall off the shared brain
  that makes a plan worth more than the sum of its parts. The boundaries that *do* earn this work
  (product↔platform, capability↔everything) all bind at N=1, so every structure justified only by
  cross-site leakage was cut.
- **The database stays in platform `state/`.** An earlier draft placed a database inside the site
  directory, which would have exposed it to any capability with file-read. Table ownership is
  documented and asserted instead of split into two files.
- **The manifest declares record directories; the platform imposes no layout.** This makes the
  guard's write list manifest-driven and makes migration a no-op instead of rewriting every planner
  path and knowledge-base cross-reference.
- **`site.json` is outside the agent's write scope.** A jail whose occupant can edit its own walls
  is not a jail.
- **Trust by provenance, not by enumeration.** Platform-shipped tools are available by default; only
  capabilities that did not come from the platform need human enablement. An allow-list of shipped
  tools would tax every release with a manifest edit and buy no safety, since the container — not
  the tool list — is what bounds a mistake. Rejected in favour of `deny` + `enabled`.
- **Runtime built alongside the working planner**, harvesting the hardened modules (`Security`,
  `Update`, `Resources`, `Migration`, `Trace`, `Jobs`) rather than rewriting them. Greenfield was
  rejected: it discards a year of hardening that took real incidents to get right.
- **Carried into S2, recorded now so it cannot be lost:** because the threat model includes a
  **prompt-injected agent**, escalations must be raised on **facts the runtime observed** — "this
  capability requested network access to host X", "this write targeted platform state" — never on
  the agent's narration of them, and any agent-written analysis must be labelled untrusted. An
  injected agent writes a reassuring explanation exactly when it matters most, so the verifier must
  be a separate context that never ingested the attacker's text.

## The track after this

| | |
|---|---|
| **S1** *(this spec)* | Site manifest + platform seam |
| **S2** | Capability model — one manifest, one lifecycle, declared and enforced permissions, the escalation harness |
| **S3** | Declarative UI spec + the platform's component library + the renderer |
| **S4** | Product extraction — the `Gatherlight.Platform` / `Gatherlight.Planner` assembly split, making the reference direction compiler-enforced |
