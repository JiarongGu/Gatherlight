# Dev conventions — server, data, tooling

The load-bearing patterns for working on Gatherlight's code. These mirror the sibling projects
(same family patterns); deviations need a reason.

## Backend (src/server)

- **Three projects, compiler-enforced**: `Gatherlight.Platform` (classlib, references none of
  ours) → `Gatherlight.Planner` (classlib, references Platform) → `Gatherlight.Server` (web app,
  references both — the composition root, exempt by definition) → `Gatherlight.Host` (WinForms,
  references Server). Namespaces are unchanged from the old single-project layout —
  `Gatherlight.Server.Platform.<Group>.<Name>` / `Gatherlight.Server.Product.Planner.<Name>` — this
  was a compilation boundary, not a rename. Each module: `{Name}Controller.cs` (thin) →
  `Services/` (business logic + repository). **A module is Platform if it survives the planner
  being replaced by a different site** — i.e. it knows nothing about plans, trips, budgets,
  household or travel. Groups: `Kernel` (contexts, paths, config), `Site` (template seeding, and
  the site manifest), `Hosting` (security, update, resources, migration, settings, migrations
  runner), `Agent` (LLM + chat sessions/gates/SSE), `Capabilities` (tool registry, MCP endpoint +
  client, document/media tooling), `Storage` (library, knowledge, memory, uploads, data repo,
  backup), `Ops` (jobs, traces, scoring, eval, playground, cortex). **Platform must never
  reference Planner** — the compiler enforces it (`Gatherlight.Platform.csproj` carries no
  `ProjectReference` to Planner); `node devtools/dev.mjs check-layering` is a fast redundancy that
  also asserts that `ProjectReference` never reappears. Where Platform needs something the Product
  owns, invert it behind a Platform-owned port resolved as a DI collection — see
  `Platform/Kernel/Services/IRecordIndex.cs`, which lets startup migration and backup restore
  trigger a rebuild without knowing the planner keeps an index. Variation points are interfaces
  resolved via DI collections (e.g. `IGatherlightTool`), never if/else chains.
- **Type naming — never `Dto`/`DTO` in a name.** "DTO" is a pattern label, not a domain word; it
  says nothing about what the type carries. Name the *role*, using the suffixes already in the
  codebase: `…View` for a client-safe projection of an entity (`McpServerView`, `PromptView`,
  `MigrationStepView`), `…Request`/`…Response` for a controller's wire shape, `…Summary` for a
  reduced/aggregate shape (`BudgetSummary`), `…Info` for a descriptor (`McpToolInfo`), `…Config`
  /`…Options` for settings, `…Snapshot` for a point-in-time state. Same for members, locals and
  prose — say "the view projection", not "the DTO". (Also avoid the other empty suffixes: `Data`,
  `Object`, `Manager` where a verb-noun service name fits.)
- **SQLite via Dapper**: hand-written SQL, `snake_case` columns ↔ PascalCase properties
  (`MatchNamesWithUnderscores`). **Repository methods are async** (`QueryAsync`/`ExecuteAsync`).
  Trap: SQLite integer affinity — wrap double columns in `CAST(x AS REAL)` in SELECTs.
  **Table ownership** (one database, deliberately not split): product tables are `plan_index`
  `plan_asset` `library_item` `knowledge` `entity` `job` `job_run` `data_commit` `chat_*` `upload`
  `tool_cache` `zhiku_state` `lyntai_*`; platform tables are `app_config` (security/update/resources
  keys), `notification`, `process_log`. A note for a future split, not an enforced boundary — at one
  site there is nothing for enforcement to catch.
- **Migrations**: FluentMigrator in `Platform/Hosting/Fluent/Migrations/`, numbered `YYYYMMDDNNNN` —
  never reuse a number (unapplied duplicates are skipped silently). Composite PKs must be
  inline at CreateTable (SQLite has no ALTER ADD CONSTRAINT). The 0.x ledger was squashed into a
  single `202607280001_Baseline` (one-time, at the Lyntai-1.0 fresh-start reset — durable data
  travels via the whole-install backup); the ledger is append-only again from there. Lyntai owns its
  own `lyntai_*` tables + `lyntai_version_info` (migrated eagerly by `UseSqliteStorage`).
- **Full-text search = FTS5 `trigram`**: search indexes are external-content FTS5 virtual tables
  with the **`trigram`** tokenizer (indexed CJK *substring* recall — `unicode61` treats a whole
  Chinese phrase as one token), kept in sync by AFTER INSERT/DELETE/UPDATE triggers and backfilled
  in the same migration. Build the MATCH string via `Platform/Kernel/Services/FtsQuery` (drops
  `<3`-char tokens, quotes the rest), fall back to LIKE when it returns null, rank with `bm25()`.
  Reference: the FTS virtual tables + sync triggers in `202607280001_Baseline` +
  `LibraryStore`/`Knowledge/Stores`.
- **Sources are BOM-less UTF-8 + `<CodePage>65001</CodePage>`** — without it, csc on a
  CJK-locale machine reads Chinese string literals as ANSI mojibake (bit us once).
- **Scorers / evals** are the DI-collection pattern in practice: each eval dimension is an `IScorer`
  registered `AddSingleton<IScorer, …>` (`Platform/Ops/Scoring`) — deterministic ones compute in
  code, LLM-judge ones extend `LlmScorerBase` (one-shot claude from a neutral cwd, `{score,reason}`
  verdict). Add a dimension = add a class + one registration, never a switch. The eval playground
  (`Platform/Ops/Playground`, `dev.mjs eval`) reuses them against dry plans (no persistence).
- **Judge tools** (`Platform/Ops/Scoring/Services/JudgeTools.cs`): the LLM judges can open the
  REAL artifact instead of grading the truncated excerpt in the `ScoreContext`. They reach it
  through Lyntai's `AddMcpToolHost(new ClaudeCliMcpDialect())`, which registers an
  `ICliToolProvisioner` — read ONLY by `ClaudeCliProvider`, i.e. the one-shot `ILlmClient` path,
  so this affects the judges and nothing else (the agent path, `ClaudeAgentSession`, takes no
  provisioner — it reaches the app's tools through the loopback channel in the next bullet, a
  different endpoint with a different lifetime). Per call Lyntai starts a bearer-gated loopback
  Kestrel and tears it down after. **It executes app code, so the jail is the load-bearing part**:
  read-only, text extensions only, size-capped, and a POSITIVE allow-list of `plans/ household/
  .claude/` — never `state/` (access token, TLS pfx, DB), with symlink targets re-checked and every
  listing hit re-resolved. That's the same set the planner agent may already read, so the judges gain
  no reach the scope guard doesn't already grant. Registering zero `ITool`s makes the host a no-op.
  Proof lives in `e2e-p36` (the claude stub drives the MCP server for real and asserts the denials).
- **The agent's own tools come from a loopback-only channel**, not the public listener: a second
  Kestrel endpoint on `127.0.0.1:0`, plain HTTP, serving `/mcp` only, behind a per-start bearer token
  held in memory. `AgentSessionOptions.McpServers` (Lyntai) points each run at it. This exists because
  the public listener carries TLS and authentication meant for REMOTE HUMANS — with TLS on the agent's
  `http://` connection failed, and with `trustLoopback:false` it got a 401, and in both cases the CLI
  surfaced nothing: the server contributed no tools and the agent reported them **missing**. Exposure
  settings describe how remote humans reach the app; they have nothing to say about a child process on
  the same machine. Shape: `Platform/Hosting/Security/Services/InternalMcpEndpoint` (port + token,
  never persisted), `AccessGateMiddleware` telling the two ports apart by `Connection.LocalPort`
  **ahead of** its own `Enabled` check (a token-less install turns that gate off entirely, and an
  unrestricted internal port would then serve `/api`), and `Agent/Llm/Services/AgentMcpWiring` building
  the per-run server list for all three run sites (chat, jobs, the eval playground). The server NAME
  comes from `IToolRegistry.McpServerName`, not a literal: `AllowedTools` are `mcp__<name>__*`, so a
  drifted name would leave every tool un-approved — silently, which is the failure this channel exists
  to end. Naming a server does **not** pre-approve its tools; `AllowedTools` still does that. There is
  no generated `state/mcp.chat.json` any more, and startup deletes one an older build left behind — a
  file that configures nothing is worse than no file, because the next person debugging this reads it
  and believes it. Proof lives in `e2e-p44`, which asserts the TOOL LIST (never merely a 200) in each
  configuration, and the server name the spawned CLI was actually handed.
- **Agent-authored UI is a validated node tree, never markup.** The vocabulary is a DI collection of
  `IUiNodeSchema` (`Platform/Agent/Ui`): one class + one registration per component, never a switch.
  The server validates before the client is told a block exists — unknown type, unknown prop, wrong
  type, children on a leaf, or past the depth/node limits all fail, and a failure is SHOWN to the
  user, never dropped. Two mounts share it: a ```ui fence inside a streamed chat turn (the scanner
  splits a turn into ordered segments so raw JSON never lands in the transcript) and a page spec in
  `{data}/ui/`. `rehype-raw` and the sanitize allow-list are gone — legacy `trip-map`/`city-map`
  divs survive through a remark shim, so agent text has no path to markup at all. A `Button`'s
  action is a container verb (`send`, `openRecord`, `runCapability`), and `send` only composes the
  user's next message: a button cannot approve anything. `runCapability` names code a human ALREADY
  approved — the page supplies an id, never code — and the click confirms first, from
  `PermissionSentence` over the enforced grant (`GET /api/ui/capability/{id}`), never from the page,
  whose label the agent wrote. The verb validates by SHAPE, not by state: enablement is enforced at
  invocation by `ToolRegistry`, so a page naming a capability enabled later is still committable. A
  capability's OUTPUT is data, not a view — it reaches the renderer only via `POST /api/ui/validate`.
  The schema is C# and the renderer is TypeScript, so
  `node devtools/dev.mjs check-ui-registry` guards the two lists against drift. The vocabulary the
  agent reads (`.claude/ui-spec.md`) is app-managed and version-gated like the scope guard — it is a
  protocol contract, not knowledge-base content the seeder must preserve, and it has to keep saying
  exactly what `UiTreeValidator` enforces. Proof lives in `e2e-p41`.
  The agent authors pages too: `ui/` is in the scope guard's write set, restricted to flat `.json`
  by `WRITE_EXTS` so a path it may write there is exactly a page (the store lists the top level only
  — without the flat rule it could write a permanently invisible file). A page change is reviewed by
  RENDERING it at the diff gate from the working tree, with a change summary computed from the two
  trees rather than written by the agent, and an invalid page **cannot be committed**. Both the
  contract (`UI_CONTRACT_VERSION`) and the shared prompt preamble name pages — S3a's lesson is that
  a capability the agent is never told about is unreachable while every check stays green, so
  `e2e-p42` asserts the prompt pointer itself, not just the file. Proof lives in `e2e-p42`.
- **A page reads live data by NAMING a query, and the resolution happens server-side.** `bind` on a
  `Table`/`Chart` replaces the literal prop (`BindFills`; carrying both fails, because two sources of
  truth for the same cells is a page that can disagree with itself). The query is an `IUiDataSource`
  id with a CLOSED parameter set — one class + one registration per query, `Platform/Agent/Ui/Data`,
  implementations free to live in Planner. This is `runCapability`'s rule applied to reading: an
  agent-authored filter expression is an agent-authored program evaluated against the household's
  database, so the agent picks a name and fills declared slots and never writes the query.
  `UiBindingResolver` fills the tree wherever it is already being validated, and the node that goes
  over the wire has `bind` GONE — so the renderer never learns what a binding is (`check-ui-registry`
  keeps its meaning), the browser can never call a query with parameters of its own, and the S3b diff
  gate reviews a bound page against live data, which is what the reviewer actually needs to see.
  Two failure classes, deliberately different: a **shape** error (unknown query/param, both props)
  fails validation and therefore blocks the commit; a **runtime** error renders a visible warning
  where the data would have been and leaves the rest of the page standing. Neither ever yields an
  empty table — an empty table is indistinguishable from "you have nothing", which is a lie told on
  the household's own data. Same reason `Truncated` exists: a capped result SAYS there was more.
  Bindings are refused in a ```ui chat block (`allowBindings:false`) because that seam is synchronous
  and streaming — and in chat the agent already holds the data.
- **A composite is one level of whole-value substitution, and nothing more.** A file in `ui/` with
  `define` is a component definition; one with `root` is a page — same directory, same guard, same
  gate. Expansion happens BEFORE validation so the depth/node limits apply to what actually renders.
  Three constructions rather than three checks: a definition may not use another definition (so
  recursion cannot exist), a placeholder must be the whole value (so a parameter injects a value into
  a slot the definition chose, never structure), and a definition may not take a primitive's name
  (whose violation is *carried* as `UiComposite.Problem` and shown at the gate — a definition that
  silently never renders is the worst outcome). Editing a definition changes pages whose own files
  did not change, so `PagesToReview` expands a changed definition into those pages and the gate
  renders them. Proof lives in `e2e-p45`.
- **`remarkLegacyMaps` stays.** Its deletion was tied to dropping `rehype-raw`, which S3a already did
  by another route; the shim never enables raw-HTML parsing, nothing creates that shape any more, and
  the only thing left to migrate is the household's own existing documents. Recorded so it is not
  re-proposed as leftover cruft.
- **Capabilities carry provenance.** `Platform` (compiled, shipped by us) is available by default and
  runs in-process; `Script` and `Mcp` are off until `site.json` lists them in `capabilities.enabled`;
  `Draft` is never loaded. Non-platform capabilities run under `node --permission` with filesystem
  scope from their grant plus `cap-guard.mjs`, the platform preload that removes the network. That
  network denial holds ONLY because `--permission` already denies `child_process` spawn,
  `worker_threads` and `process.binding` — relaxing any of those silently breaks it. Two traps found
  the hard way: the sandbox must be granted read on the preload's own directory or it cannot import
  it, and a denied CLI built-in must appear in the PreToolUse `matcher` or the guard is never invoked
  for it. The launcher **fails closed**: no runtime supporting `--permission` + `module.registerHooks`,
  or a missing preload, means a Script capability refuses to run rather than running unsandboxed.
  Proof lives in `e2e-p38`, whose denials are real attempts paired with positive controls.
- **Split a growing class into SERVICES, not `partial`s.** `ChatSessionService` reached 1615 lines;
  a `partial` split made the files smaller and changed nothing that mattered, because the class could
  still absorb anything and nobody ever felt the cost. It is now four types — `ChatSessionService`
  (sessions + the two-gate pipeline), `ChatGateService` (the five between-turns gates), `GateMarkers`
  (final text → marker, pure) and `GateCards` (runtime facts → card, pure). The boundary is
  structural: `ChatGateService`'s constructor takes the provision/login/draft/capability/manifest
  services the session pipeline does not need, so a sixth gate lands where those dependencies already
  are. The cycle you would expect is avoided by passing the host per CALL rather than injecting it —
  `ChatSessionService` implements `IChatGateHost` explicitly (seven members), so the seam does not
  widen its public API and anything a gate wants beyond those seven is a design question. `GateCards`
  gains a real guarantee from the move: unable to reach session state or a service, a card cannot
  describe anything other than what is enforced.
- **Chat gates are between-turns markers, not suspensions.** There is no mid-run suspend: the agent
  ends a turn with a marker in its final text (`NEEDS_INPUT` · `MCP_ADD` · `LOGIN_REQUIRED` ·
  `TOOL_DRAFT` · `CAPABILITY_BLOCKED`), the server parks in a `ChatPhase` and emits the card on a
  `phase` event's `Data`, a POST through `FireAndAck` supplies the decision, and a FRESH run carries
  `ResumeToken`. A marker naming something that does not exist must NOT park — a gate with nothing to
  decide wedges the session and holds the app-wide agent lease.
- **A gate parked on a human decision survives a restart; a mid-run session still fails.** Those are
  opposite cases and `SelfHealStateStep` used to treat them alike. A running session's child process
  is gone — `error` is honest. A parked one has nothing in flight and its state is already durable, so
  `ReconcileInterruptedAsync` returns the newest parked thread (ONE — the agent lease admits one
  holder) and `RestoreParkedAsync` rebuilds it, **re-taking the lease**: restoring the gate without it
  would silently remove the single-writer guarantee the gate exists to provide. What gets persisted is
  the state a gate needs to ACT (`GateState` in the session's own metadata — the parsed MCP request,
  the draft, the denial + its grant, the tracked paths), which is deliberately not what it needs to
  DISPLAY (already durable: every phase event's `Data` is the card, stored verbatim). The diff gate is
  **rebuilt, never remembered** — `PresentDiffAsync` re-reads the working tree, because approving a
  remembered file list could commit something other than what the reviewer was shown. This matters
  more since auto-update restarts the server. Proof lives in `e2e-p46`.
- **Chat history is the stored event stream, replayed.** Every agent event is persisted as its SSE
  payload verbatim (`AppendEventAsync` → `lyntai_message`), so `GET /api/chat/history{,/id}` returns
  the wire shape and the client feeds it to the SAME reducer the live stream feeds — one renderer, no
  history view to drift. Two traps found by building it: the **user's** message is not an agent event
  (it lives in the turn metadata), so `TranscriptAsync` synthesizes a `kind:"user"` event per turn or
  a replay shows only the agent's half; and a **thread is one turn** — the conversation the user sees
  is the run of turns sharing a `ConversationId` in the thread's app-owned metadata, a new one
  beginning exactly when `PrepareThreadContextAsync` decides on a fresh slate (idle · turn cap ·
  post-commit). Assigning that id is not enough to resume one: `chat_turn` was cleared, so the
  context is rebuilt from the conversation's stored turns (`ConversationContextAsync`) or the agent
  starts blank while every other check stays green. A replayed gate renders its card **without
  actions** — the in-memory session that could act on it is gone, and an Approve button that silently
  does nothing is worse than a finished decision.
- **Cards are platform chrome; the agent's words are labelled as its claim.** Permission clauses are
  rendered server-side from the enforced grant (`PermissionSentence`), never from agent text, and a
  clause with no enforcement behind it is a defect — the household is trusting the sentence, not the
  code. The agent's own description rides in a separate field and is styled unmistakably differently,
  because an injected agent writes a reassuring one exactly when it matters. Agent markdown is
  allow-listed so it cannot forge a card.

## LLM / process spawning

- **claude CLI only, never API keys.** Resolve the executable via `where.exe` once, preferring
  `.cmd`/`.exe` (the first `where` hit can be an extensionless bash shim Windows can't run).
  `ArgumentList` only — never a shell (newlines + metacharacters in prompts). Prompts over
  stdin. BOM-less UTF-8 both directions. `Kill(entireProcessTree: true)` on abort.
- Cheap utility calls (extract, validation) run with a **neutral cwd** so the data folder's
  CLAUDE.md/knowledge base isn't loaded per call; the interactive chat runs cwd = data root
  **by design** (the planner gate is the product).
- Tests stub the CLI via `GATHERLIGHT_CLAUDE_CMD` (see devtools/scripts/claude-stub.mjs).

## Security / remote access (`Platform/Hosting/Security`)

- **Loopback is trusted; remote needs a token.** `AccessGateMiddleware` gates `/api` + `/mcp` (token
  via `Authorization: Bearer` / `X-Gatherlight-Token` / httpOnly `gl_auth` cookie; loopback bypasses
  it unless `security.trustLoopback:false`, e.g. behind a same-host proxy). `SecurityHeadersMiddleware`
  puts CSP + nosniff/frame/referrer/permissions on every response — the CSP is calibrated to the
  built client, verify with a real render before tightening. `ILoginThrottle` = per-IP brute-force
  lockout. Binding beyond loopback **without** a token **fails closed** (refuses to start) — unless
  the explicit **`security.allowLanWithoutToken`** opt-in (`GATHERLIGHT_ALLOW_LAN=1`) is set, for a
  trusted private LAN (logs a loud startup warning; the gate is then a no-op). The `/manage` Settings
  tab surfaces this as a 3-way **Local / LAN / WAN** access mode (WAN = `0.0.0.0` + token required).
- **Every remote image goes through `/api/img`, so `img-src` is `'self' data: blob:`.** Map tiles,
  library covers, an `Image` node's https src and a picture in plan markdown all route through the
  one same-origin door (`ImageProxyController` over `ImageCache` — SSRF guard, image content-type,
  size cap, disk cache). With `img-src https:` any URL that reached a rendered page made the
  household's BROWSER call that host, leaking their IP and that they were reading it, on render,
  unrecorded — and an image URL can come from agent text. Proxying does not make an arbitrary URL
  safe to FETCH; it moves the fetch to the server, where it is guarded and visible. The tile route
  takes three bounded integers and pins the upstream host, so nothing agent-written reaches an
  outbound URL. **Adding `https:` back re-opens the residual** — `e2e-p17` asserts its absence, not
  the directive's presence, and the CSP stays calibrated against a real render.
- **Every fail-closed rule needs its opt-in asserted too.** `p17` case C proved an unauthenticated
  LAN bind is refused — which passes whether the refusal is conditional or unconditional. It was
  unconditional in the headless entry point for months: `Gatherlight.Server/Program.cs` built its
  options from config for port/bind/token/trustLoopback/TLS and never read `AllowLanWithoutToken`,
  so a household that chose LAN mode and took the documented opt-in got a refusal quoting the setting
  they had already set — while `Gatherlight.Host` honoured it. A denial without its positive control
  is half a test.
- **TLS is Kestrel-native** (`TlsCertificate.Resolve`): a self-signed cert generated + reused from
  `state/gatherlight-tls.pfx`, or a configured PFX. Config lives in `security.*` (settings.json) +
  `GATHERLIGHT_BIND`·`_ACCESS_TOKEN`·`_TRUST_LOOPBACK`·`_TLS[_CERT]` env overrides.

## Capabilities, the sandbox & app-managed files

- **The agent authors capabilities as SANDBOXED SCRIPT TOOLS, never as MCP servers.** It drafts
  `.claude/tool-drafts/<id>/` (tool.json + entry script), raises `TOOL_DRAFT`, a human promotes it,
  and it runs under `node --permission` + `cap-guard.mjs` with a grant. Authoring an *MCP server*
  instead would take the same agent-written code and run it via plain `Process.Start` with the
  household's full privileges and no jail — strictly worse, for an identical capability. The contract
  it writes against is `.claude/tool-spec.md`: app-managed and version-gated like `ui-spec.md`, with
  the grant vocabulary rendered from THIS site's record dirs and — the load-bearing part — **the
  blocked-module list parsed out of the shipped `cap-guard.mjs` at render time**, not restated. A
  contract that merely describes the sandbox drifts the first time the sandbox changes, and the agent
  only finds out when an approved capability throws at run time, after a human said yes to a card
  promising it could not reach the internet. Proof lives in `e2e-p39`, which asserts the contract's
  contents, that the prompt points at it, and — the row that was missing for months — that a promoted
  draft **actually runs**, not merely that it appears in `/api/tools`. "Listed" is not "usable"; the
  same gap existed for platform tools and for proxied MCP tools (`e2e-p47`).
- **An external MCP server is the one capability we do NOT contain, and its card says so.**
  `StdioMcpConnection.Start` is a plain `Process.Start` — no `--permission`, no `cap-guard.mjs`, no
  path jail — so the process runs with the host account's full privileges. The add-gate therefore
  carries `sandboxed:false` plus `PermissionSentence.ExternalMcp()`, and deliberately has **no
  `cannot` list**: every clause in `Cannot` is a promise the sandbox keeps, there is no sandbox here,
  and inventing a reassuring one is precisely the unenforced-plain-language failure the card model
  exists to prevent. The client renders it through `UnsandboxedNotice`, never `GrantClauses`, whose
  empty 系统禁止 column would read as a missing value rather than a warning. Proof lives in `e2e-p32`.
- **Anything that replaces a record subtree must RE-ISSUE the app-managed files** — one seam,
  `IAppManagedFiles.ReissueAsync` (template seed + `ChatEnvironmentService.EnsureFiles`), called by
  startup AND by backup import. `.claude/` holds files the APP owns, not the household: the scope
  guard, the UI contract, the shipped form maps. They are derived from the app version — the same
  class as the plan index, which import already rebuilt — so restoring an older archive rolled them
  BACK. Measured on a real 2026-07-28 backup: the guard went from v7 to **v4** (losing S2's `DENIED`
  plane and S3b's `WRITE_EXTS`), the UI contract and form maps vanished, and because `EnsureFiles`
  only ran at startup the downgrade lasted the whole session. It surfaced as a visa PDF failing to
  generate — the loud symptom of a silent security regression. Two traps in the fix itself:
  `DataWriteLock` is a **non-reentrant** `SemaphoreSlim(1,1)` and the seeder takes it, so the re-issue
  must sit OUTSIDE import's lock scope (holding it deadlocks the import outright); and the re-issue
  must run BEFORE the restore commit so its files land in the same commit. Proof lives in `e2e-p47`.
- **A zip cannot carry an empty directory, and a PACKED git repo has them.** `git gc` moves every ref
  into `packed-refs` and deletes the loose `refs/heads/<branch>`, leaving `refs/` empty. The export
  enumerates FILES, so `refs/` simply is not in the archive, and git then refuses to recognise the
  restored folder at all — `fatal: not in a git directory`. It surfaces as the FIRST thing startup does
  to a data folder (`初始化数据仓库: git config … failed (128)`) with no hint that the history is intact
  in `packed-refs` three inches away. Worse, the diagnosis is easy to get wrong: run `git` anywhere
  inside another repo and it walks UP, finds that parent, and reports success — which is why the first
  repro looked fine and the first e2e assertion passed while proving nothing. **Adding auto-packing is
  what made this reachable**, so the two changes belong together: `RepairGitSkeleton()` re-creates
  `refs/heads`, `refs/tags`, `objects/info`, `objects/pack` on IMPORT (which also rescues archives
  already in circulation, as fixing only the exporter cannot), and the exporter additionally writes
  directory ENTRIES so a hand-unzipped archive is valid too. `e2e-p47` packs the source repo before
  exporting — without that the fixture's refs stay loose and the whole case evaporates.
- **The backup MUST carry every directory the household writes to.** `Folders` was a hard-coded list
  that had drifted from the site: `ui/` (agent-authored pages, approved at the diff gate, tracked in
  the data repo) and `site.json` (the manifest holding `capabilities.enabled` — every capability a
  human promoted — and `records`, which the scope guard renders its write-scope FROM) were both absent.
  Neither loss was visible: the seeder immediately re-creates the template's `welcome.json`, so `ui/`
  came back looking intact with the household's own pages gone, and `SiteManifestStep` writes a fresh
  default, so the app came up working and merely forgot what it was allowed to do. When a new record
  directory is added to the site, add it here — and assert it in `p47` by NAME, never by the
  template-seeded file that would come back anyway.
- **The backup carries `.git`, so LOOSE OBJECTS are a backup-size problem.** Git writes every new
  object loose — one zlib file each — and only packs when told; a loose object is already-compressed
  data a zip cannot squeeze. A restore writes a whole tree that way, so the objects ride into the NEXT
  export. Measured on a real data folder: 223 loose at 1.93 MiB against 158 packed at 790 KiB, and the
  export had grown 3.42 MB → 4.86 MB with **nothing of the household's added** (`plans/`, `household/`
  and `memory.json` were byte-identical; the knowledge base had actually shrunk). `git gc` took `.git`
  from 3.1 MB to 1.1 MB and the export to 2.79 MB — smaller than the archive taken before any of it.
  So `IDataRepoMaintenance` packs: threshold-gated at startup, and **forced after an import**, because
  import is a known bulk-object event and a small household would otherwise sit under any threshold
  forever while every export carried the pile. It expires reflogs first (per-clone breadcrumbs that pin
  unreachable objects and travel in the backup for nobody), takes `DataWriteLock` (gc rewrites the
  object store; a commit landing mid-pack is corruption found much later, in a backup nobody can
  restore) and is therefore called OUTSIDE any lock scope, the lock being non-reentrant. It is
  **lossless on purpose** — it never drops a commit. Bounding how far back history goes is a separate,
  destructive decision: the data repo is the audit trail the diff gate rests on, and "what did the
  agent change last Tuesday" is answerable only while that history exists. Proof lives in `e2e-p47`,
  which asserts `packs >= 1` and not merely a low loose count — the fixture's ~119 objects already sit
  under any sane threshold, so a count-only check passed while maintenance had never run.
- **The fact index is DERIVED, and rebuilding it is destructive.** `knowledge` is the record of truth —
  it is what the backup carries and what the index rebuilds FROM; Lyntai's graph memory engine
  (`Storage/Knowledge/FactIndex`, engine `facts`, scope = the fact's `kind`) only ranks it, adding
  decay-by-what-has-happened, reinforcement on recall, and model-free linking of facts recalled
  together. Deliberately the **associative** tier: Lyntai can hold authoritative material that never
  decays, and that is the curated markdown the CLI loads directly, so grading facts authoritative here
  would exempt them from the only thing indexing them buys. Three traps: it is **not** an
  `IRecordIndex`, because that collection is rebuilt at every startup and the discard would erase the
  decay positions and links the index spends weeks accumulating — startup gets `SyncAsync` (back-fill
  only, via `FactIndexStep`) and a backup import gets the destructive `RebuildAsync`, because there the
  facts themselves were replaced. The graph dedups on **content hash**, so editing a fact orphans its
  previous node; recall over-asks and filters to resolvable refs so an orphan never shrinks the page.
  And every operation degrades to FTS rather than throwing — an index that fails closed is worse than
  one that ranks by relevance alone, and an empty result reads to the agent as "the household knows
  nothing", which is a lie told on their own data. `recall_facts` therefore reports `ranked:
  graph|fts`, because a graph answer and a fallback answer are otherwise indistinguishable. Proof lives
  in `e2e-p48`, whose restore assertion was confirmed to FAIL with the rebuild removed.
- **Data where it churns, code where it doesn't** — `fill_itinerary`'s form map. A form's *shape*
  (field names, `{n}` row templates, `maxRows`, font sizes, flatten) lives in `.claude/forms/*.json`,
  seeded by the template and editable by the agent through the normal diff gate; the PDF machinery
  (pdf-lib, fontkit, CJK embedding) stays compiled and shipped. So a revised visa form is a file
  edit, not a release — without the cost of the S1 proposal to make the whole tool a Script
  capability, which would have vendored pdf-lib + fontkit into every household's data folder (a
  grant's fs vocabulary is site-relative; the leaf lives in the install's `res/`). The map path is
  agent-nameable, so it resolves through the SAME `ResolveSitePath` guard as the PDF it describes,
  and a field the PDF lacks is reported BY NAME — a blank form otherwise looks like a filled one.
  Proof lives in `e2e-p10`, whose fixture fields are deliberately nothing like the visa form's.
- **The sandbox's node is a provisioned resource, not an assumption.** The capability sandbox needs
  `--permission` + `module.registerHooks` (Node 22.15+); the node inside the Playwright driver is
  older, so this used to depend on whatever the machine had, and a clean install had every Script
  capability refusing to run with nothing offering a fix. A pinned Node LTS is now a catalog entry
  (sha256-pinned, since nodejs.org serves a mutable path — bump version and checksum together), and
  `CapabilityRuntime` still PROBES whatever it picks, so a wrong pin fails closed rather than
  pretending.

## Packaging & auto-update

- `dev.mjs publish` (→ `devtools/scripts/build-production.mjs`) builds the **framework-dependent** host
  (~20 MB; the .NET 10 runtime is NOT bundled — the launcher installs it once at first run via the
  official MS installers, `src/launcher/dotnet_runtime.cpp`, so updates are ~20 MB not ~110 MB) **plus
  the native C++ launcher** (`src/launcher/`, MSVC — CI selects the v143 toolset via `CI=true`; falls
  back to `Gatherlight.cmd` where MSVC is absent) into `publish/Gatherlight/` (`libs/`·`res/`·`data/` +
  sha256 `manifest.json` + zip). The launcher carries the app icon (`src/assets/gatherlight.ico`,
  regen via `make-icon.ps1`).
- **Anything a tool needs at runtime must be IN the bundle** — the release ships `libs/`·`res/`·`data/`
  and nothing else; a path that resolves only by walking up to a repo root works in dev and is dead on
  every install. Node leaf tools (`tools/<name>`) therefore ship **esbuild-bundled** into
  `res/tools/<name>/<entry>.cjs` (self-contained, run by plain `node` — no npm install/npx/tsx/node_modules
  on the target), resolved by `ResourcePaths.NodeLeaf` (bundle layout first, then the dev walk-up so
  `src/*.ts` edits stay live). Adding a leaf = add it to `build-production.mjs` step 3.8 **and** its
  `required()` list. This is a rule because it already shipped broken: nothing under `tools/` was packed,
  so `pdf_inspect`/`pdf_fill`/`pdf_merge`/`fill_itinerary` threw `工具目录不存在:` in every installed copy
  and only worked from the source repo. Coverage: `e2e-p10` runs the tools in BOTH shapes.
- **Large resources are download-at-setup, not bundled** (default lean bundle ~200 MB vs ~350 MB):
  chromium + git are provisioned by `Platform/Hosting/Resources` (`ResourceProvisioner` →
  `/api/manage/resources`, the 资源 · Resources console panel) into `{data}/state/resources/…`
  (in the data folder → survives updates, fetched once). Runtime resolvers prefer that copy
  (`PlaywrightHost` browsers path, `GitCliService.GitExe` data-aware). `build-production.mjs
  --offline` bundles them for air-gapped installs. The Playwright **driver** (`libs/.playwright`,
  the chromium-install bootstrap) is still bundled.
- **A resource the app cannot BOOT without is provisioned automatically, never reported.** git is that
  one — the data repo is the audit trail the diff gate rests on — and being download-at-setup like
  chromium, a fresh install on a machine with no git spawned the PATH `git` that wasn't there and died
  in `DataRepoInitStep` with a raw Win32 `系统找不到指定的文件`. That step is essential, so the gate stayed
  closed; and the remedy the product documented — the 资源 panel — is `/api`, which the same gate 503s
  (settings too, so even the first-run wizard never appeared). **The failure sealed the door to its own
  fix**: 重试 re-ran a step that could not succeed, on an install with no way to reach the thing it
  needed. Before adding an essential step, ask what its failure leaves the household able to DO. Now
  `GitRuntimeStep` runs immediately before `data-repo` and downloads MinGit (sha256-pinned; the same
  constants `build-production.mjs` reads for `--offline`, so the bundled and downloaded gits cannot
  drift) into `{data}/state/resources/git`. Three traps: `GitCliService` resolved its exe **once in the
  constructor**, which DI builds before any step runs — so the download three steps earlier was
  invisible and a retry still spawned the missing PATH `git` (it re-resolves per call until it finds a
  real file); *installed* is not *usable*, so the step probes what it will actually run and says so when
  that fails; and a fixture that puts git in place before the boot passes against all of it, which is
  why `e2e-p49`'s case C makes git appear **mid-life** (confirmed to hang the gate against the pre-fix
  binary). A household that already has git downloads nothing — `p49` asserts that too, because a
  surprise 37 MB is its own defect.
- **Auto-update is two-phase**: the server (`Platform/Hosting/Update`) checks the configured
  GitHub release + downloads/sha256-verifies into `{install}/.update/staged`; the C++ launcher
  overlays it on the next restart (a running exe can't replace itself) and is itself excluded
  from the overlay. That split is the whole reason the launcher exists. Release: a single
  **manual-trigger** `.github/workflows/release.yml` (`workflow_dispatch`; version bump → e2e
  gate → bundle → optional tag → GitHub Release) — no auto CI on push/PR (D3dx-style). The release
  BODY comes from `docs/release-notes/next.md` when present (generated commit log underneath,
  collapsed), and the workflow archives it to `<version>.md` in the bump commit — a `next.md` left
  behind is republished verbatim on the next release.
- **The launcher's failure paths must not block, because nothing is watching them.** The overlay's
  "could not apply the update" branch raised a modal `MessageBoxW`, which waits forever; on the
  unattended `--apply-and-exit` seam that turned the file's own "never fatal — the current version
  still starts" promise into a launcher that never returns, and a harness could only ever report a
  timeout, never the failure the seam exists to catch. `ApplyPendingUpdate` now takes `unattended`.
  Testing it needed care worth keeping: robocopy answers a file/directory collision with **4** and a
  read-only destination with **0**, both `< 8` and therefore SUCCESS here, so the obvious fixtures
  make a **vacuous** test. A staged path that is not a directory gives 16 — and is a real corruption
  case, since the "marker without staged files" guard uses `PathFileExistsW`, which tests existence,
  not type. `p19` pairs it with an anti-vacuity control (removals are skipped only if the overlay
  really failed) and was confirmed to FAIL against the pre-fix binary.
- **A >260-char install root is not a supported scenario, and not a bug we can fix.** Windows cannot
  create a process from an image path past MAX_PATH: measured at 347 chars, a stock `system32` binary
  copied there fails identically to ours, by `CreateProcess` **and** by `ShellExecute` (a
  double-click), against a positive control of the same binary at 62 chars. So `longPathAware` in a
  manifest would buy nothing — it governs what a RUNNING process does with paths, not whether the
  loader will start one. Don't re-open it. The launcher's 32768-wide buffers are still load-bearing
  for the real case: a root under the limit holding individual FILES past it.

## Data folder discipline

- ALL user data in the untracked data folder (`local/` default, `GATHERLIGHT_DATA` override);
  it has its own private git repo. The server never edits `state/`-external data outside the
  reviewed flows (chat gates, fs ops, seeder) — and those all serialize on `DataWriteLock`
  (one writer, or git index.lock collisions + corrupted review diffs).
- The spawned agent is **jailed** by the PreToolUse scope-guard hook
  (`ChatEnvironmentService.ScopeGuardMjs` planner / `guard/system-scope-guard.mjs`
  系统模式 — identical logic, different write-scope; `e2e-p24` runs both): **reads**
  (Read/Grep/Glob) confined to the jail, **writes** (Edit/Write/…) to `plans/ household/ .claude/`
  (planner) or the **whole code repo except the PROTECTED set** — `guard/`, `src/server`,
  `.claude/settings*.json`, `.git` — (系统模式). Each guard combines an allow-list (`WRITE_DIRS`)
  with a `PROTECTED` deny-list that overrides it (the planner protects `.claude/hooks` + settings so
  the agent can't neuter its own guard). **Bash** denied git-history / network-egress / inline-eval
  (`node -e`, `python -c`) / fs-crawl / path-escape. Anything genuinely **out-of-boundary must
  route through a server MCP tool** — mediated + auditable — never raw Bash. Enforcement, not
  trust. The guard carries a `GUARD_VERSION`; the server re-issues it into existing data folders
  when it bumps (it's a security boundary, not editable KB content). The `guard/` folder is
  app-managed (shipped + overlaid by updates), read-only to the agent. Residuals the hook can't
  close (code run *inside* an agent-authored script; exfil via a fetched URL) need an OS sandbox —
  **declined**, and the reasoning is on the record in `docs/ROADMAP.md`: the `claude` CLI authenticates
  per-user, so a low-privilege service account breaks the mechanism the whole product rests on.
- **Egress is audited, not closed — and both planes are audited the same.** The agent reaches the
  network two ways: the CLI's built-in `WebFetch` and the registry's `scrape`. Neither can be shut for
  a planner whose job is reading arbitrary travel sites, and denying `WebFetch` alone only moves the
  channel — `scrape` takes the same arbitrary URL (`SsrfGuard` blocks *internal* targets, which is a
  different threat). So `capabilities.deny` is a **lever, not a default**: the shipped manifest denies
  nothing, and a household that wants the built-in closed gets a mechanism that removes it from the
  generated allow-list AND the guard together (`e2e-p24`). What is always on is the record — every
  outbound URL lands in the durable event stream via `AgentRunner.ToolDetail`, which is why it has an
  `mcp__*` case: without it the MEDIATED path was the less auditable of the two, which is backwards.
  Proof lives in `e2e-p21`, which drives one turn through both planes and asserts each URL in the trace.
- The shipped knowledge base lives in `Assets/SiteTemplate/` and is seeded/upgraded by
  `ZhikuSeeder` (hash-guarded: user-modified files are never overwritten).

## Dev loop

- `node devtools/dev.mjs <server|host|vite|build|publish|resources-pack|e2e|smoke|memory|eval|test-data|install-hooks|check-sensitive|check-layering|check-ui-registry>`
  — kept in step with the tool's own usage line (`dev.mjs`, bottom of the switch).
- e2e suites live in `devtools/scripts/e2e/` as `pN.mjs` (discovered by `^p\d+\.mjs$`); they self-host
  the server against isolated `devtools/_e2e-*` data folders with the claude stub; every phase of work
  lands with its suite green. Shared harness: `devtools/scripts/e2e/_e2e-common.mjs` (leading `_` → not
  discovered as a suite).
- `dev.mjs eval [scenarios.json]` = the prompt/agent playground (dry-plan + auto-score, a quality
  benchmark); `dev.mjs memory <export|import>` transfers DB memory; `host`/`publish` run/build the
  desktop bundle.
- Scratch files: `devtools/_*` (gitignored). Never OS temp.
