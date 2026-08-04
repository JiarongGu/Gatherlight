# Site manifest + platform seam (S1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Gatherlight's server into an explicit `Platform/` and `Product/`, and give the site one declared manifest (`site.json`) that names its record directories, its non-platform capabilities, and its agent config — with the scope guard generated from it.

**Architecture:** Two phases that each stand alone. **Phase A** is a mechanical reshuffle with zero behaviour change, guarded by a new `check-layering` script that fails the build if `Platform/` ever references `Product/`. **Phase B** introduces `site.json`, splits `IDataContext` into `ISiteContext` + `IPlatformContext`, and makes the guard's `WRITE_DIRS` manifest-driven. The database stays in platform `state/` and nothing on disk moves.

**Tech Stack:** ASP.NET Core net10.0, C# 13, Dapper/SQLite, Node 24 for devtools + e2e. No .NET test project exists — verification is `dotnet build`, the node e2e suites (`devtools/scripts/e2e/pN.mjs`), and node checker scripts in the `check-sensitive.mjs` family.

**Spec:** `docs/superpowers/specs/2026-08-04-site-model-container-design.md`

---

## File structure

**Phase A — new files**

| File | Responsibility |
|---|---|
| `devtools/scripts/check-layering.mjs` | Reads every `.cs` file, derives its layer from its path, and fails on a `Platform/` file that references a `Product/` namespace or an unclassified module. |
| `devtools/scripts/_move-module.mjs` | One-shot helper: git-mv a module folder and rewrite its namespace + every reference across the tree. Deleted at the end of Phase A. |

**Phase A — moved (namespace = folder path, `Gatherlight.Server.<Layer>.<Group>.<Module>.<Layer2>`)**

```
Platform/
  Kernel/          ← Modules/Core                     Gatherlight.Server.Platform.Kernel.*
  Site/            ← Modules/Seed  (+ new files, Phase B)
  Hosting/         ← Security · Update · Resources · Migration · Settings · Fluent
  Agent/           ← Llm · Chat
  Capabilities/    ← Tools · McpClient · Documents
  Storage/         ← Library · Knowledge · Memory · Files · DataRepo · Backup
  Ops/             ← Jobs · Trace · Scoring · Eval · Playground · Cortex
Product/
  Planner/         ← PlanIndex · Scrapers(domain) · planner scorers · fill_itinerary
```

**Phase B — new files**

| File | Responsibility |
|---|---|
| `Platform/Site/Models/SiteManifest.cs` | The `site.json` shape + its defaults. |
| `Platform/Site/Services/SiteManifestStore.cs` | Load / validate / write the manifest. Throws on unparseable. |
| `Platform/Site/Services/SiteContext.cs` | `ISiteContext` — site root, record dirs, `.claude/`, uploads, cache, `ResolveSitePath`. |
| `Platform/Site/Services/PlatformContext.cs` | `IPlatformContext` — `state/`, database, resources, logs, update staging. |
| `Platform/Hosting/Migration/Steps/SiteManifestStep.cs` | Startup step: write the manifest if absent, regenerate the guard from it. |
| `devtools/scripts/e2e/p37.mjs` | Manifest + seam e2e suite. |

**Phase B — modified**

| File | Change |
|---|---|
| `Platform/Kernel/Services/DataContext.cs` | Split into the two contexts; `IDataContext` deleted. |
| `Platform/Agent/Chat/Services/ChatEnvironmentService.cs` | `WRITE_DIRS` becomes a placeholder filled from the manifest; `GUARD_VERSION` 4 → 5. |
| `Assets/SiteTemplate/site.json` | New file in the shipped template (folder renamed from `Assets/DataTemplate`). |
| `.claude/rules/dev-conventions.md` | Modules rule replaced by the two-tier rule. |

---

# PHASE A — the seam in the tree

### Task 1: The layering checker

**Files:**
- Create: `devtools/scripts/check-layering.mjs`
- Modify: `devtools/dev.mjs` (add the `check-layering` case)

- [ ] **Step 1: Write the checker**

Create `devtools/scripts/check-layering.mjs`:

```js
#!/usr/bin/env node
// check-layering.mjs — enforces the one architectural rule of the platform track:
//
//     Platform/ must never reference Product/.
//
// A module is Platform if it survives the planner being replaced by a different site — i.e. it
// knows nothing about plans, trips, budgets, household or travel. The map below is the record of
// that judgement; a module missing from it is an error, because "unclassified" is exactly the
// state this check exists to prevent. See docs/superpowers/specs/2026-08-04-site-model-container-design.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverSrc = path.join(repo, 'src', 'server', 'Gatherlight.Server');

// group → modules. Every module must appear exactly once.
export const LAYERS = {
  'Platform/Kernel': [''],
  'Platform/Site': ['Seed'],
  'Platform/Hosting': ['Security', 'Update', 'Resources', 'Migration', 'Settings', 'Fluent'],
  'Platform/Agent': ['Llm', 'Chat'],
  'Platform/Capabilities': ['Tools', 'McpClient', 'Documents'],
  'Platform/Storage': ['Library', 'Knowledge', 'Memory', 'Files', 'DataRepo', 'Backup'],
  'Platform/Ops': ['Jobs', 'Trace', 'Scoring', 'Eval', 'Playground', 'Cortex'],
  'Product/Planner': ['PlanIndex', 'Scrapers'],
};

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'obj' && e.name !== 'bin') walk(abs, out); }
    else if (e.name.endsWith('.cs')) out.push(abs);
  }
  return out;
};

const errors = [];
const files = walk(path.join(serverSrc, 'Platform')).concat(walk(path.join(serverSrc, 'Product')));

if (files.length === 0) {
  errors.push('no files under Platform/ or Product/ — the reshuffle has not run yet');
}

for (const abs of files) {
  const rel = path.relative(serverSrc, abs).split(path.sep).join('/');
  const body = fs.readFileSync(abs, 'utf8');
  if (!rel.startsWith('Platform/')) continue;
  // A Platform file may not name a Product namespace, in a using or fully qualified.
  const hit = body.match(/\bGatherlight\.Server\.Product\.[A-Za-z.]+/);
  if (hit) errors.push(`${rel} references ${hit[0]} — Platform must never reference Product`);
}

// Every remaining Modules/ folder is unclassified.
const legacy = path.join(serverSrc, 'Modules');
if (fs.existsSync(legacy)) {
  for (const e of fs.readdirSync(legacy, { withFileTypes: true }))
    if (e.isDirectory()) errors.push(`Modules/${e.name} is unclassified — place it under Platform/ or Product/`);
}

if (errors.length) {
  console.error('\x1b[31m✖ layering violations\x1b[0m');
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`check-layering: clean — ${files.length} files, Platform never references Product.`);
```

- [ ] **Step 2: Wire it into dev.mjs**

In `devtools/dev.mjs`, immediately after the existing `case 'check-sensitive':` block (around line 124), add:

```js
  case 'check-layering':
    run('node', [path.join(repo, 'devtools', 'scripts', 'check-layering.mjs'), ...args]);
    break;
```

And add a line to the usage comment at the top of the file, after the `check-sensitive` line:

```js
//   node devtools/dev.mjs check-layering    - assert Platform/ never references Product/
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node devtools/dev.mjs check-layering`
Expected: FAIL, listing every `Modules/<Name>` as unclassified plus "the reshuffle has not run yet".

- [ ] **Step 4: Commit**

```bash
git add devtools/scripts/check-layering.mjs devtools/dev.mjs
git commit -m "chore(arch): add check-layering — Platform must never reference Product"
```

---

### Task 2: The move helper

**Files:**
- Create: `devtools/scripts/_move-module.mjs`

- [ ] **Step 1: Write the helper**

Create `devtools/scripts/_move-module.mjs`:

```js
#!/usr/bin/env node
// _move-module.mjs — one-shot Phase A helper. git-mv a module folder and rewrite its namespace
// plus every reference to it across the server sources. Deleted when Phase A completes.
//
//   node devtools/scripts/_move-module.mjs Core Platform/Kernel
//   node devtools/scripts/_move-module.mjs Security Platform/Hosting/Security
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = path.join(repo, 'src', 'server', 'Gatherlight.Server');
const [module, dest] = process.argv.slice(2);
if (!module || !dest) { console.error('usage: _move-module.mjs <ModuleName> <Dest/Path>'); process.exit(1); }

const from = path.join(src, 'Modules', module);
const to = path.join(src, ...dest.split('/'));
if (!fs.existsSync(from)) { console.error(`no such module: Modules/${module}`); process.exit(1); }

fs.mkdirSync(path.dirname(to), { recursive: true });
execFileSync('git', ['mv', from, to], { cwd: repo, stdio: 'inherit' });

const oldNs = `Gatherlight.Server.Modules.${module}`;
const newNs = `Gatherlight.Server.${dest.split('/').join('.')}`;

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'obj' && e.name !== 'bin') walk(abs, out); }
    else if (e.name.endsWith('.cs')) out.push(abs);
  }
  return out;
};

let touched = 0;
for (const abs of walk(src)) {
  const body = fs.readFileSync(abs, 'utf8');
  // Longest-match first so `Modules.Core.Services` rewrites before a bare `Modules.Core`.
  const next = body.split(oldNs).join(newNs);
  if (next !== body) { fs.writeFileSync(abs, next); touched++; }
}
console.log(`moved Modules/${module} → ${dest}  (${oldNs} → ${newNs}, ${touched} files touched)`);
```

- [ ] **Step 2: Commit**

```bash
git add devtools/scripts/_move-module.mjs
git commit -m "chore(arch): add one-shot module move helper for the Platform/Product reshuffle"
```

---

### Task 3: Move Kernel + Hosting

**Files:**
- Move: `Modules/Core` → `Platform/Kernel`; `Modules/{Security,Update,Resources,Migration,Settings,Fluent}` → `Platform/Hosting/*`

- [ ] **Step 1: Move the modules**

```bash
cd D:/Development/Games/Gatherlight
node devtools/scripts/_move-module.mjs Core Platform/Kernel
node devtools/scripts/_move-module.mjs Security Platform/Hosting/Security
node devtools/scripts/_move-module.mjs Update Platform/Hosting/Update
node devtools/scripts/_move-module.mjs Resources Platform/Hosting/Resources
node devtools/scripts/_move-module.mjs Migration Platform/Hosting/Migration
node devtools/scripts/_move-module.mjs Settings Platform/Hosting/Settings
node devtools/scripts/_move-module.mjs Fluent Platform/Hosting/Fluent
```

- [ ] **Step 2: Build**

Run BOTH — `Gatherlight.Host` is a separate project that also references these namespaces, so building
only the server hides a broken Host:

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Expected: `Build succeeded. 0 Error(s)` for both. The Host emits a pre-existing `MSB3277` warning
(WebView2 vs `WindowsBase` version unification) that is unrelated to this work; any *error*, or any
other new warning, is a real failure.

Then confirm no stale reference to a moved module survives anywhere:
```bash
grep -rn "Modules\.\(Core\|Security\|Update\|Resources\|Migration\|Settings\|Fluent\|Llm\|Chat\|Tools\|McpClient\|Documents\|Library\|Knowledge\|Memory\|Files\|DataRepo\|Backup\|Jobs\|Trace\|Scoring\|Eval\|Playground\|Cortex\|Seed\|PlanIndex\|Scrapers\)" --include=*.cs src/
```
Expected: no output for modules moved so far.

If a namespace was missed, the error names the exact file and symbol — fix it and rebuild before moving on.

- [ ] **Step 3: Commit**

```bash
git add -A src/server/Gatherlight.Server
git commit -m "refactor(arch): move Core + hosting modules under Platform/"
```

---

### Task 4: Move Agent + Capabilities

**Files:**
- Move: `Modules/{Llm,Chat}` → `Platform/Agent/*`; `Modules/{Tools,McpClient,Documents}` → `Platform/Capabilities/*`

- [ ] **Step 1: Move the modules**

```bash
node devtools/scripts/_move-module.mjs Llm Platform/Agent/Llm
node devtools/scripts/_move-module.mjs Chat Platform/Agent/Chat
node devtools/scripts/_move-module.mjs Tools Platform/Capabilities/Tools
node devtools/scripts/_move-module.mjs McpClient Platform/Capabilities/McpClient
node devtools/scripts/_move-module.mjs Documents Platform/Capabilities/Documents
```

- [ ] **Step 2: Build**

Run BOTH — `Gatherlight.Host` is a separate project that also references these namespaces, so building
only the server hides a broken Host:

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Expected: `Build succeeded. 0 Error(s)` for both. The Host emits a pre-existing `MSB3277` warning
(WebView2 vs `WindowsBase` version unification) that is unrelated to this work; any *error*, or any
other new warning, is a real failure.

Then confirm no stale reference to a moved module survives anywhere:
```bash
grep -rn "Modules\.\(Core\|Security\|Update\|Resources\|Migration\|Settings\|Fluent\|Llm\|Chat\|Tools\|McpClient\|Documents\|Library\|Knowledge\|Memory\|Files\|DataRepo\|Backup\|Jobs\|Trace\|Scoring\|Eval\|Playground\|Cortex\|Seed\|PlanIndex\|Scrapers\)" --include=*.cs src/
```
Expected: no output for modules moved so far.

- [ ] **Step 3: Commit**

```bash
git add -A src/server/Gatherlight.Server
git commit -m "refactor(arch): move agent + capability modules under Platform/"
```

---

### Task 5: Move Storage + Ops + Site

**Files:**
- Move: `Modules/{Library,Knowledge,Memory,Files,DataRepo,Backup}` → `Platform/Storage/*`; `Modules/{Jobs,Trace,Scoring,Eval,Playground,Cortex}` → `Platform/Ops/*`; `Modules/Seed` → `Platform/Site/Seed`

- [ ] **Step 1: Move the modules**

```bash
node devtools/scripts/_move-module.mjs Library Platform/Storage/Library
node devtools/scripts/_move-module.mjs Knowledge Platform/Storage/Knowledge
node devtools/scripts/_move-module.mjs Memory Platform/Storage/Memory
node devtools/scripts/_move-module.mjs Files Platform/Storage/Files
node devtools/scripts/_move-module.mjs DataRepo Platform/Storage/DataRepo
node devtools/scripts/_move-module.mjs Backup Platform/Storage/Backup
node devtools/scripts/_move-module.mjs Jobs Platform/Ops/Jobs
node devtools/scripts/_move-module.mjs Trace Platform/Ops/Trace
node devtools/scripts/_move-module.mjs Scoring Platform/Ops/Scoring
node devtools/scripts/_move-module.mjs Eval Platform/Ops/Eval
node devtools/scripts/_move-module.mjs Playground Platform/Ops/Playground
node devtools/scripts/_move-module.mjs Cortex Platform/Ops/Cortex
node devtools/scripts/_move-module.mjs Seed Platform/Site/Seed
```

- [ ] **Step 2: Build**

Run BOTH — `Gatherlight.Host` is a separate project that also references these namespaces, so building
only the server hides a broken Host:

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Expected: `Build succeeded. 0 Error(s)` for both. The Host emits a pre-existing `MSB3277` warning
(WebView2 vs `WindowsBase` version unification) that is unrelated to this work; any *error*, or any
other new warning, is a real failure.

Then confirm no stale reference to a moved module survives anywhere:
```bash
grep -rn "Modules\.\(Core\|Security\|Update\|Resources\|Migration\|Settings\|Fluent\|Llm\|Chat\|Tools\|McpClient\|Documents\|Library\|Knowledge\|Memory\|Files\|DataRepo\|Backup\|Jobs\|Trace\|Scoring\|Eval\|Playground\|Cortex\|Seed\|PlanIndex\|Scrapers\)" --include=*.cs src/
```
Expected: no output for modules moved so far.

- [ ] **Step 3: Commit**

```bash
git add -A src/server/Gatherlight.Server
git commit -m "refactor(arch): move storage, ops + seed modules under Platform/"
```

---

### Task 6: Move Product

**Files:**
- Move: `Modules/{PlanIndex,Scrapers}` → `Product/Planner/*`

- [ ] **Step 1: Move the modules**

```bash
node devtools/scripts/_move-module.mjs PlanIndex Product/Planner/PlanIndex
node devtools/scripts/_move-module.mjs Scrapers Product/Planner/Scrapers
```

- [ ] **Step 2: Build**

Run BOTH — `Gatherlight.Host` is a separate project that also references these namespaces, so building
only the server hides a broken Host:

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Expected: `Build succeeded. 0 Error(s)` for both. The Host emits a pre-existing `MSB3277` warning
(WebView2 vs `WindowsBase` version unification) that is unrelated to this work; any *error*, or any
other new warning, is a real failure.

Then confirm no stale reference to a moved module survives anywhere:
```bash
grep -rn "Modules\.\(Core\|Security\|Update\|Resources\|Migration\|Settings\|Fluent\|Llm\|Chat\|Tools\|McpClient\|Documents\|Library\|Knowledge\|Memory\|Files\|DataRepo\|Backup\|Jobs\|Trace\|Scoring\|Eval\|Playground\|Cortex\|Seed\|PlanIndex\|Scrapers\)" --include=*.cs src/
```
Expected: no output for modules moved so far.

**This build is the one that matters.** It will likely FAIL, because `GatherlightApp.cs` (the composition root) references both sides — that is legal, since the composition root is neither layer. What must NOT appear is a `Platform/` file referencing `Product`. Any such error is a real coupling to fix, not a rename to patch: move the shared type down into `Platform/Kernel` or invert the dependency behind an interface. Record each one in the commit message.

- [ ] **Step 3: Run the layering check**

Run: `node devtools/dev.mjs check-layering`
Expected: `check-layering: clean — <N> files, Platform never references Product.`

- [ ] **Step 4: Commit**

```bash
git add -A src/server/Gatherlight.Server
git commit -m "refactor(arch): move planner modules under Product/ — layering check now green"
```

---

### Task 7: Exempt the composition root, then prove the reshuffle changed nothing

**Files:**
- Modify: `devtools/scripts/check-layering.mjs`
- Delete: `devtools/scripts/_move-module.mjs`

- [ ] **Step 1: Allow the composition root to see both sides**

`GatherlightApp.cs` sits at the project root, not under `Platform/` or `Product/`, so the walker never reaches it — confirm that is true by running the check. If any root-level file *is* flagged, add this guard immediately after `const rel = ...` in the file loop:

```js
  // The composition root wires both layers together by definition; it belongs to neither.
  if (rel === 'GatherlightApp.cs' || rel === 'Program.cs') continue;
```

- [ ] **Step 2: Delete the one-shot helper**

```bash
git rm devtools/scripts/_move-module.mjs
```

- [ ] **Step 3: Run the full e2e suite**

Run: `node devtools/dev.mjs e2e all`
Expected: `e2e: 36/36 suites passed`

A reshuffle that changes behaviour has a bug in it. If a suite fails, the namespace rewrite hit a string literal — search the diff for changed strings, not changed types.

Note: `p21` intermittently times out on Windows from a claude-stub teardown race unrelated to this work. Re-run it alone (`node devtools/dev.mjs e2e p21`) before treating it as a failure.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(arch): drop the one-shot move helper; full suite green after the reshuffle"
```

---

### Task 8: Update the documented convention

**Files:**
- Modify: `.claude/rules/dev-conventions.md`

- [ ] **Step 1: Replace the modules rule**

In `.claude/rules/dev-conventions.md`, replace the bullet beginning "**Modules pattern**" with:

```markdown
- **Two-tier modules**: `Platform/<Group>/<Name>/` or `Product/Planner/<Name>/`, each with
  `{Name}Controller.cs` (thin) → `Services/`. **A module is Platform if it survives the planner
  being replaced by a different site** — i.e. it knows nothing about plans, trips, budgets,
  household or travel. Groups: `Kernel` (contexts, paths, config), `Site` (manifest, template,
  guard generation), `Hosting`, `Agent`, `Capabilities`, `Storage`, `Ops`. **Platform must never
  reference Product** — enforced by `node devtools/dev.mjs check-layering`, which also fails on an
  unclassified module. The composition root (`GatherlightApp.Build()`) is exempt: it wires both
  layers by definition. Variation points are interfaces resolved via DI collections
  (e.g. `IGatherlightTool`), never if/else chains.
```

- [ ] **Step 2: Record database table ownership**

Add to the same file, under the SQLite bullet:

```markdown
  **Table ownership** (one database, deliberately not split — see the S1 spec): product tables are
  `plan_index` `plan_asset` `library_item` `knowledge` `entity` `job` `job_run` `data_commit`
  `chat_*` `upload` `tool_cache` `zhiku_state` `lyntai_*`; platform tables are `app_config`
  (security/update/resources keys), `notification`, `process_log`. This is a note for a future
  split, not an enforced boundary — at one site there is nothing for enforcement to catch.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/dev-conventions.md
git commit -m "docs(rules): document the Platform/Product two-tier convention + table ownership"
```

---

# PHASE B — the manifest

### Task 9: The manifest model + store

**Files:**
- Create: `src/server/Gatherlight.Server/Platform/Site/Models/SiteManifest.cs`
- Create: `src/server/Gatherlight.Server/Platform/Site/Services/SiteManifestStore.cs`

- [ ] **Step 1: Write the model**

Create `Platform/Site/Models/SiteManifest.cs`:

```csharp
using System.Text.Json.Serialization;

namespace Gatherlight.Server.Platform.Site.Models;

/// <summary>
/// The site's declared shape — <c>{data}/site.json</c>. One reviewable file naming what the agent
/// may write, which non-platform capabilities are enabled, and how its agent is configured. It is
/// read by the platform and is NOT agent-writable: a jail whose occupant can edit its own walls is
/// not a jail. See docs/superpowers/specs/2026-08-04-site-model-container-design.md
/// </summary>
public sealed class SiteManifest
{
    public string Name { get; init; } = "Gatherlight";
    public SiteTemplateRef Template { get; init; } = new();
    public SiteAgentConfig Agent { get; init; } = new();

    /// <summary>Directories the agent may write, the git repo tracks and the index scans.
    /// The platform imposes no layout — this is the declaration the scope guard is built from.</summary>
    public IReadOnlyList<string> Records { get; init; } = ["plans", "household"];

    public SiteCapabilities Capabilities { get; init; } = new();
    public SiteUiRef Ui { get; init; } = new();
}

public sealed class SiteTemplateRef
{
    public string Id { get; init; } = "planner";
    public string Version { get; init; } = "0.0.0";
}

public sealed class SiteAgentConfig
{
    /// <summary>Null = inherit the platform default model.</summary>
    public string? Model { get; init; }
    public string PromptPack { get; init; } = "planner";
}

/// <summary>
/// NOT an enumeration of what the agent may use. Platform-shipped tools are available by default —
/// they are trusted by provenance, and an allow-list would tax every release with a manifest edit
/// while buying no safety, because the container is what bounds a mistake.
/// </summary>
public sealed class SiteCapabilities
{
    /// <summary>Anything agent-callable deliberately withheld — a shipped MCP tool OR a CLI
    /// built-in such as <c>WebFetch</c>, which the scope guard's hook matcher does not intercept.</summary>
    public IReadOnlyList<string> Deny { get; init; } = [];

    /// <summary>Capabilities that did NOT come from the platform (an agent-drafted script tool, an
    /// external MCP server) and are therefore off until a human enables them. S2 grows each entry
    /// from an id into a grant object; readers must tolerate both shapes.</summary>
    public IReadOnlyList<string> Enabled { get; init; } = [];
}

public sealed class SiteUiRef
{
    public string Spec { get; init; } = "ui/";
    public int SpecVersion { get; init; } = 1;
}
```

- [ ] **Step 2: Write the store**

Create `Platform/Site/Services/SiteManifestStore.cs`:

```csharp
using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Site.Models;

namespace Gatherlight.Server.Platform.Site.Services;

public interface ISiteManifestStore
{
    /// <summary>The manifest, loaded once at startup. Throws if the file exists but will not parse.</summary>
    SiteManifest Current { get; }
    string ManifestPath { get; }
    bool Exists { get; }
    SiteManifest Load();
    void Write(SiteManifest manifest);
}

/// <summary>
/// Reads and writes <c>{data}/site.json</c>. An unparseable manifest is FATAL and loud rather than
/// silently defaulted: the manifest is what the scope guard is generated from, and building a
/// security boundary out of guessed defaults is precisely the failure mode to avoid.
/// </summary>
public sealed class SiteManifestStore : ISiteManifestStore
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private readonly string _root;
    private SiteManifest? _cached;

    public SiteManifestStore(GatherlightServerOptions options) => _root = Path.GetFullPath(options.DataPath);

    public string ManifestPath => Path.Combine(_root, "site.json");
    public bool Exists => File.Exists(ManifestPath);
    public SiteManifest Current => _cached ??= Load();

    public SiteManifest Load()
    {
        if (!Exists) return _cached = new SiteManifest();
        var body = File.ReadAllText(ManifestPath);
        try
        {
            return _cached = JsonSerializer.Deserialize<SiteManifest>(body, Json)
                ?? throw new JsonException("site.json is empty");
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                $"site.json 无法解析,拒绝以默认值启动(scope guard 由它生成):{ManifestPath} — {ex.Message}", ex);
        }
    }

    public void Write(SiteManifest manifest)
    {
        File.WriteAllText(ManifestPath, JsonSerializer.Serialize(manifest, Json) + "\n", Utf8NoBom);
        _cached = manifest;
    }
}
```

- [ ] **Step 3: Build**

Run BOTH — `Gatherlight.Host` is a separate project that also references these namespaces, so building
only the server hides a broken Host:

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Expected: `Build succeeded. 0 Error(s)` for both. The Host emits a pre-existing `MSB3277` warning
(WebView2 vs `WindowsBase` version unification) that is unrelated to this work; any *error*, or any
other new warning, is a real failure.

Then confirm no stale reference to a moved module survives anywhere:
```bash
grep -rn "Modules\.\(Core\|Security\|Update\|Resources\|Migration\|Settings\|Fluent\|Llm\|Chat\|Tools\|McpClient\|Documents\|Library\|Knowledge\|Memory\|Files\|DataRepo\|Backup\|Jobs\|Trace\|Scoring\|Eval\|Playground\|Cortex\|Seed\|PlanIndex\|Scrapers\)" --include=*.cs src/
```
Expected: no output for modules moved so far.

- [ ] **Step 4: Commit**

```bash
git add src/server/Gatherlight.Server/Platform/Site
git commit -m "feat(site): add the site manifest model + store"
```

---

### Task 10: Split IDataContext into ISiteContext + IPlatformContext

**Files:**
- Modify: `src/server/Gatherlight.Server/Platform/Kernel/Services/DataContext.cs`
- Modify: every file referencing `IDataContext` (the compiler lists them)

- [ ] **Step 1: Replace the context file**

Replace the whole contents of `Platform/Kernel/Services/DataContext.cs`:

```csharp
namespace Gatherlight.Server.Platform.Kernel.Services;

/// <summary>
/// The SITE — the agent's world. Its record directories (declared by the manifest), its knowledge
/// base, uploads and cache, all under the folder's own private git repo. Artifact paths stored in
/// the DB are site-root-relative with forward slashes; <see cref="ResolveSitePath"/> is the one
/// place that joins them back, and the one place that refuses an escape.
/// </summary>
public interface ISiteContext
{
    string RootPath { get; }
    string UploadsPath { get; }
    string CachePath { get; }
    /// <summary>The planner knowledge base ({data}/.claude) the spawned agent runs on.</summary>
    string ZhikuPath { get; }
    /// <summary>Absolute paths of the manifest-declared record directories.</summary>
    IReadOnlyList<string> RecordPaths { get; }

    /// <summary>Join a site-root-relative path to the root. Null if it escapes the root — including
    /// into platform state/. Existence is NOT checked; callers decide (read targets vs write targets).</summary>
    string? ResolveSitePath(string relativePath);

    /// <summary>Site-root-relative form (forward slashes) of an absolute path under the root;
    /// null if outside.</summary>
    string? ToRelativePath(string absolutePath);
}

/// <summary>
/// The PLATFORM — everything the site must never reach: the database, the access token, the TLS
/// key, provisioned resources, logs and update staging. It lives under <c>{data}/state</c>, outside
/// the site's jail, which is the property the judge tools already depend on.
/// </summary>
public interface IPlatformContext
{
    string StatePath { get; }
    string DatabasePath { get; }
    /// <summary>Large downloadable resources (chromium, git, node) provisioned at setup rather than
    /// bundled. Lives in the data folder so it survives app updates and is downloaded once.</summary>
    string ResourcesPath { get; }
    /// <summary>Daily-rolling plain-text app logs (<c>{yyyy-MM-dd}.log</c>).</summary>
    string LogsPath { get; }
}

public sealed class SiteContext : ISiteContext
{
    private readonly Gatherlight.Server.Platform.Site.Services.ISiteManifestStore _manifest;

    public SiteContext(GatherlightServerOptions options,
        Gatherlight.Server.Platform.Site.Services.ISiteManifestStore manifest)
    {
        _manifest = manifest;
        RootPath = Path.GetFullPath(options.DataPath);
        Directory.CreateDirectory(RootPath);
        Directory.CreateDirectory(UploadsPath);
        Directory.CreateDirectory(CachePath);
    }

    public string RootPath { get; }
    public string UploadsPath => Path.Combine(RootPath, "uploads");
    public string CachePath => Path.Combine(RootPath, "cache");
    public string ZhikuPath => Path.Combine(RootPath, ".claude");

    // Read the manifest LAZILY, never cached at construction: SiteManifestStep writes site.json
    // during startup migration, which is after DI builds this singleton. Caching here would pin the
    // defaults and silently disagree with the manifest for the rest of the process lifetime.
    public IReadOnlyList<string> RecordPaths
    {
        get
        {
            var dirs = _manifest.Current.Records.Select(r => Path.Combine(RootPath, r)).ToList();
            foreach (var d in dirs) Directory.CreateDirectory(d);
            return dirs;
        }
    }

    public string? ResolveSitePath(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath)) return null;
        var full = Path.GetFullPath(Path.Combine(RootPath, relativePath));
        // Prefix match must be on a directory boundary, or a sibling like `…\local2` slips past
        // the guard for root `…\local`. Compare against root + separator (and allow the root itself).
        var rootWithSep = RootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var withinRoot = full.Equals(RootPath, StringComparison.OrdinalIgnoreCase)
            || full.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase);
        if (!withinRoot) return null;
        // state/ is the platform's, not the site's — refuse it even though it is under the root.
        var state = Path.Combine(RootPath, "state") + Path.DirectorySeparatorChar;
        if (full.StartsWith(state, StringComparison.OrdinalIgnoreCase)) return null;
        return full;
    }

    public string? ToRelativePath(string absolutePath)
    {
        var full = Path.GetFullPath(absolutePath);
        var rootWithSep = RootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!full.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase)) return null;
        return full[rootWithSep.Length..].Replace('\\', '/');
    }
}

public sealed class PlatformContext : IPlatformContext
{
    public PlatformContext(GatherlightServerOptions options)
    {
        StatePath = Path.Combine(Path.GetFullPath(options.DataPath), "state");
        Directory.CreateDirectory(StatePath);
    }

    public string StatePath { get; }
    public string DatabasePath => Path.Combine(StatePath, "gatherlight.db");
    public string ResourcesPath => Path.Combine(StatePath, "resources");
    public string LogsPath => Path.Combine(StatePath, "logs");
}
```

- [ ] **Step 2: Register both in the composition root**

In `GatherlightApp.cs`, replace the `IDataContext` registration with:

```csharp
            .AddSingleton<Platform.Site.Services.ISiteManifestStore, Platform.Site.Services.SiteManifestStore>()
            .AddSingleton<Platform.Kernel.Services.ISiteContext, Platform.Kernel.Services.SiteContext>()
            .AddSingleton<Platform.Kernel.Services.IPlatformContext, Platform.Kernel.Services.PlatformContext>()
```

- [ ] **Step 3: Build and fix every call site**

Run: `dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo`
Expected: many errors, each naming a file that took `IDataContext`.

Fix each by the member it used:
- `RootPath`, `UploadsPath`, `CachePath`, `ZhikuPath`, `ResolveDataPath`, `ToRelativePath` → `ISiteContext` (`ResolveDataPath` → `ResolveSitePath`)
- `StatePath`, `DatabasePath`, `ResourcesPath`, `LogsPath` → `IPlatformContext`
- `PlansPath` / `HouseholdPath` → these were planner-specific. In `Product/Planner/**`, replace with `site.ResolveSitePath("plans")!` / `site.ResolveSitePath("household")!`.

A class needing both takes both. **A `Platform/` class that finds itself needing `PlansPath` is telling you it is misclassified** — note it and raise it rather than papering over it.

Repeat build-and-fix until: `Build succeeded. 0 Warning(s) 0 Error(s)`

- [ ] **Step 4: Run the full suite**

Run: `node devtools/dev.mjs e2e all`
Expected: `e2e: 36/36 suites passed`

- [ ] **Step 5: Commit**

```bash
git add -A src/server/Gatherlight.Server
git commit -m "refactor(kernel): split IDataContext into ISiteContext + IPlatformContext"
```

---

### Task 11: Generate the scope guard from the manifest

**Files:**
- Modify: `src/server/Gatherlight.Server/Platform/Agent/Chat/Services/ChatEnvironmentService.cs`

- [ ] **Step 1: Templatize the guard's write list**

In `ChatEnvironmentService.cs`, inside the `ScopeGuardMjs` raw string literal, change the version and the write-dirs line:

```js
        // GUARD_VERSION: 5
```

```js
        const WRITE_DIRS = __WRITE_DIRS__;
```

Leave `PROTECTED` exactly as it is — it is the platform's, and a manifest must not be able to widen its own jail.

- [ ] **Step 2: Fill the placeholder when issuing the guard**

Add the manifest store to the constructor:

```csharp
    private readonly ISiteContext _site;
    private readonly GatherlightServerOptions _options;
    private readonly Gatherlight.Server.Platform.Site.Services.ISiteManifestStore _manifest;

    public ChatEnvironmentService(ISiteContext site, IPlatformContext platform,
        GatherlightServerOptions options,
        Gatherlight.Server.Platform.Site.Services.ISiteManifestStore manifest)
    {
        _site = site;
        _platform = platform;
        _options = options;
        _manifest = manifest;
    }
```

(Task 10 will already have replaced `IDataContext _data` with `ISiteContext _site` + `IPlatformContext _platform` here — `SettingsPath` / `McpConfigPath` use `_platform.StatePath`, `ScopeGuardPath` uses `_site.ZhikuPath`.)

Then replace the guard write inside `EnsureFiles()`:

```csharp
        string? created = null;
        if (ShouldReissueGuard(ScopeGuardPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScopeGuardPath)!);
            File.WriteAllText(ScopeGuardPath, RenderScopeGuard());
            created = ".claude/hooks/scope-guard.mjs";
        }
        return created;
```

And add:

```csharp
    /// <summary>The guard is generated, not shipped verbatim: its WRITE_DIRS come from the site
    /// manifest's declared record directories (plus .claude), so a site that keeps its artifacts
    /// somewhere else is jailed correctly without editing the guard. PROTECTED stays hardcoded.</summary>
    private string RenderScopeGuard()
    {
        var dirs = _manifest.Current.Records.Concat([".claude"]).Distinct();
        var literal = "[" + string.Join(", ", dirs.Select(d => $"'{d.Replace("'", "\\'")}'")) + "]";
        return ScopeGuardMjs.Replace("__WRITE_DIRS__", literal);
    }
```

Also update `ShippedGuardVersion` to read from the template rather than the rendered output — `ReadGuardVersion(ScopeGuardMjs)` still works because the version comment is outside the placeholder.

- [ ] **Step 3: Build**

Run BOTH — `Gatherlight.Host` is a separate project that also references these namespaces, so building
only the server hides a broken Host:

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Expected: `Build succeeded. 0 Error(s)` for both. The Host emits a pre-existing `MSB3277` warning
(WebView2 vs `WindowsBase` version unification) that is unrelated to this work; any *error*, or any
other new warning, is a real failure.

Then confirm no stale reference to a moved module survives anywhere:
```bash
grep -rn "Modules\.\(Core\|Security\|Update\|Resources\|Migration\|Settings\|Fluent\|Llm\|Chat\|Tools\|McpClient\|Documents\|Library\|Knowledge\|Memory\|Files\|DataRepo\|Backup\|Jobs\|Trace\|Scoring\|Eval\|Playground\|Cortex\|Seed\|PlanIndex\|Scrapers\)" --include=*.cs src/
```
Expected: no output for modules moved so far.

- [ ] **Step 4: Verify the rendered guard is byte-identical to today's, apart from the version line**

Run:
```bash
node devtools/dev.mjs server
```
Wait for `Startup migration complete → serving.`, stop it, then:
```bash
git -C local diff --stat .claude/hooks/scope-guard.mjs
```
Expected: only the `GUARD_VERSION: 4` → `5` line differs. `WRITE_DIRS` must render as `['plans', 'household', '.claude']` — identical to the hardcoded list.

**If any other line differs, stop.** The guard is a security boundary; an unexplained diff in it is the one thing this task must not ship.

- [ ] **Step 5: Run the guard suite**

Run: `node devtools/dev.mjs e2e p24`
Expected: `e2e-p24 PASS`

- [ ] **Step 6: Commit**

```bash
git add src/server/Gatherlight.Server/Platform/Agent/Chat/Services/ChatEnvironmentService.cs
git commit -m "feat(site): generate the scope guard's WRITE_DIRS from the site manifest"
```

---

### Task 12: The startup migration step

**Files:**
- Create: `src/server/Gatherlight.Server/Platform/Hosting/Migration/Steps/SiteManifestStep.cs`
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`

- [ ] **Step 1: Write the step**

Create `Platform/Hosting/Migration/Steps/SiteManifestStep.cs`:

```csharp
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Site.Models;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Writes <c>site.json</c> into a data folder that predates it, inferring the record directories
/// from what is already on disk. Deliberately dull: no file moves, no path rewrites, no database
/// changes — the manifest DECLARES the layout rather than imposing one, so an existing planner
/// folder needs nothing but this file. Idempotent; a crash leaves a missing manifest the next boot
/// rewrites.
/// </summary>
public sealed class SiteManifestStep : IMigrationStep
{
    private static readonly string[] KnownRecordDirs = ["plans", "household"];

    private readonly ISiteManifestStore _manifest;
    private readonly Kernel.Services.ISiteContext _site;
    private readonly ILogger<SiteManifestStep> _log;

    public SiteManifestStep(ISiteManifestStore manifest, Kernel.Services.ISiteContext site, ILogger<SiteManifestStep> log)
    {
        _manifest = manifest;
        _site = site;
        _log = log;
    }

    public string Id => "site-manifest";
    public string Title => "站点清单 · Site manifest";
    public bool Essential => true;

    public Task RunAsync(CancellationToken ct)
    {

        if (!_manifest.Exists)
        {
            var records = KnownRecordDirs
                .Where(d => Directory.Exists(Path.Combine(_site.RootPath, d)))
                .ToArray();
            if (records.Length == 0) records = KnownRecordDirs;

            _manifest.Write(new SiteManifest { Records = records });
            _log.LogInformation("site.json written (records: {Records})", string.Join(", ", records));
        }

        // Touch RecordPaths so the declared directories exist. The old DataContext created
        // plans/ + household/ eagerly in its constructor; that guarantee moved here when the
        // set became manifest-driven, and nothing else calls RecordPaths — without this line
        // the directories only appear as a side effect of whichever subsystem happens to write
        // into them first, which for plans/ is an index write inside a swallowing try/catch.
        _ = _site.RecordPaths;
        return Task.CompletedTask;
    }
}
```

- [ ] **Step 2: Register it first in the migration order**

In `GatherlightApp.cs`, add it **before** `DbMigrateStep` — everything downstream reads the manifest:

```csharp
            .AddSingleton<Platform.Hosting.Migration.Services.IMigrationStep, Platform.Hosting.Migration.Steps.SiteManifestStep>()
```

- [ ] **Step 3: Build**

Run BOTH — `Gatherlight.Host` is a separate project that also references these namespaces, so building
only the server hides a broken Host:

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Expected: `Build succeeded. 0 Error(s)` for both. The Host emits a pre-existing `MSB3277` warning
(WebView2 vs `WindowsBase` version unification) that is unrelated to this work; any *error*, or any
other new warning, is a real failure.

Then confirm no stale reference to a moved module survives anywhere:
```bash
grep -rn "Modules\.\(Core\|Security\|Update\|Resources\|Migration\|Settings\|Fluent\|Llm\|Chat\|Tools\|McpClient\|Documents\|Library\|Knowledge\|Memory\|Files\|DataRepo\|Backup\|Jobs\|Trace\|Scoring\|Eval\|Playground\|Cortex\|Seed\|PlanIndex\|Scrapers\)" --include=*.cs src/
```
Expected: no output for modules moved so far.

- [ ] **Step 4: Verify on a scratch data folder**

```bash
node devtools/scripts/make-test-data.mjs devtools/_s1-check
GATHERLIGHT_DATA=$(pwd)/devtools/_s1-check GATHERLIGHT_PORT=5412 node devtools/dev.mjs server
```
Wait for `Startup migration complete → serving.`, stop it, then:
```bash
cat devtools/_s1-check/site.json
```
Expected: `"records": ["plans", "household"]` and a `capabilities` object with empty `deny` / `enabled`.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server
git commit -m "feat(site): write site.json on startup for data folders that predate it"
```

---

### Task 13: Ship the manifest in the site template

**Files:**
- Rename: `src/server/Gatherlight.Server/Assets/DataTemplate` → `Assets/SiteTemplate`
- Create: `src/server/Gatherlight.Server/Assets/SiteTemplate/site.json`
- Modify: `Platform/Kernel/Services/ResourcePaths.cs`, `Gatherlight.Server.csproj`, `devtools/scripts/build-production.mjs`

- [ ] **Step 1: Rename the template folder**

```bash
git mv src/server/Gatherlight.Server/Assets/DataTemplate src/server/Gatherlight.Server/Assets/SiteTemplate
```

- [ ] **Step 2: Add the manifest to the template**

Create `src/server/Gatherlight.Server/Assets/SiteTemplate/site.json`:

```json
{
  "name": "Gatherlight",
  "template": { "id": "planner", "version": "1.0.0" },
  "agent": { "model": null, "promptPack": "planner" },
  "records": ["plans", "household"],
  "capabilities": { "deny": [], "enabled": [] },
  "ui": { "spec": "ui/", "specVersion": 1 }
}
```

- [ ] **Step 3: Point the resolver at the new name**

In `Platform/Kernel/Services/ResourcePaths.cs`, update `DataTemplate`:

```csharp
    /// <summary>The shipped site template (contains CLAUDE.md + site.json).</summary>
    public static string DataTemplate => First("CLAUDE.md",
        Path.Combine(Base, "Assets", "SiteTemplate"),
        Path.Combine(Base, "res", "template"),
        Path.Combine(Base, "..", "res", "template"));
```

In `Gatherlight.Server.csproj`, update the Content include:

```xml
    <!-- Shipped site template — the seeder copies it into new data folders. -->
    <Content Include="Assets\SiteTemplate\**" CopyToOutputDirectory="PreserveNewest" />
```

In `devtools/scripts/build-production.mjs`, update the move:

```js
move(path.join(stage, 'Assets', 'SiteTemplate'), path.join(res, 'template'));
```

- [ ] **Step 4: Build and confirm the template still seeds**

Run BOTH — `Gatherlight.Host` is a separate project that also references these namespaces, so building
only the server hides a broken Host:

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Expected: `Build succeeded. 0 Error(s)` for both. The Host emits a pre-existing `MSB3277` warning
(WebView2 vs `WindowsBase` version unification) that is unrelated to this work; any *error*, or any
other new warning, is a real failure.

Then confirm no stale reference to a moved module survives anywhere:
```bash
grep -rn "Modules\.\(Core\|Security\|Update\|Resources\|Migration\|Settings\|Fluent\|Llm\|Chat\|Tools\|McpClient\|Documents\|Library\|Knowledge\|Memory\|Files\|DataRepo\|Backup\|Jobs\|Trace\|Scoring\|Eval\|Playground\|Cortex\|Seed\|PlanIndex\|Scrapers\)" --include=*.cs src/
```
Expected: no output for modules moved so far.

```bash
rm -rf devtools/_s1-seed
GATHERLIGHT_DATA=$(pwd)/devtools/_s1-seed GATHERLIGHT_PORT=5413 node devtools/dev.mjs server
```
Wait for `Startup migration complete → serving.`, stop it, then:
```bash
ls devtools/_s1-seed/site.json devtools/_s1-seed/.claude/CLAUDE.md
```
Expected: both exist.

- [ ] **Step 5: Commit**

```bash
git add -A src/server/Gatherlight.Server devtools/scripts/build-production.mjs
git commit -m "feat(site): ship site.json in the site template (Assets/DataTemplate → Assets/SiteTemplate)"
```

---

### Task 14: The e2e suite

**Files:**
- Create: `devtools/scripts/e2e/p37.mjs`

- [ ] **Step 1: Write the suite**

Create `devtools/scripts/e2e/p37.mjs`:

```js
#!/usr/bin/env node
// e2e P37 — the site manifest + the platform seam. Asserts the manifest is written for a folder
// that predates it, that the scope guard's WRITE_DIRS are generated FROM it, that the manifest
// cannot widen its own jail, and that the site cannot resolve a path into platform state/.
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient } from './_e2e-common.mjs';

const dataDir = dataDirFor('p37');
const { ok, fail, done } = makeReporter('p37');
makeTestData(dataDir);

// A data folder that predates the manifest: remove it if the fixture wrote one.
const manifestPath = path.join(dataDir, 'site.json');
fs.rmSync(manifestPath, { force: true });

let srv = startServer({ dataDir, port: 5462 });
const { call } = makeClient(srv.base);

try {
  await waitHealthy(srv.base);

  // --- the migration step wrote it ---
  ok('site.json written for a pre-manifest folder', fs.existsSync(manifestPath));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  ok('records inferred from disk', JSON.stringify(manifest.records) === JSON.stringify(['plans', 'household']),
    JSON.stringify(manifest.records));
  ok('capabilities default to empty deny + enabled',
    Array.isArray(manifest.capabilities?.deny) && manifest.capabilities.deny.length === 0
    && Array.isArray(manifest.capabilities?.enabled) && manifest.capabilities.enabled.length === 0,
    JSON.stringify(manifest.capabilities));

  // --- the guard was generated from it ---
  const guard = fs.readFileSync(path.join(dataDir, '.claude', 'hooks', 'scope-guard.mjs'), 'utf8');
  ok('guard WRITE_DIRS come from the manifest',
    /const WRITE_DIRS = \['plans', 'household', '\.claude'\];/.test(guard),
    guard.split('\n').find((l) => l.includes('WRITE_DIRS')));
  ok('guard PROTECTED is still hardcoded',
    /const PROTECTED = \['\.claude\/hooks'/.test(guard));
  ok('no placeholder survived rendering', !guard.includes('__WRITE_DIRS__'));

  // --- platform state is not resolvable from the site ---
  const leak = await call('pdf_inspect', { path: 'state/gatherlight.db' });
  ok('site cannot resolve into platform state/', leak.status >= 400, String(leak.status));

  srv.stop();
  await new Promise((r) => setTimeout(r, 1200));

  // --- a different records declaration regenerates the guard ---
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, records: ['notes'] }, null, 2));
  fs.rmSync(path.join(dataDir, '.claude', 'hooks', 'scope-guard.mjs'), { force: true });
  srv = startServer({ dataDir, port: 5463 });
  await waitHealthy(srv.base);
  const guard2 = fs.readFileSync(path.join(dataDir, '.claude', 'hooks', 'scope-guard.mjs'), 'utf8');
  ok('changing records changes WRITE_DIRS', /const WRITE_DIRS = \['notes', '\.claude'\];/.test(guard2),
    guard2.split('\n').find((l) => l.includes('WRITE_DIRS')));
  ok('PROTECTED unchanged by the manifest', /const PROTECTED = \['\.claude\/hooks'/.test(guard2));
  ok('record dir created from the declaration', fs.existsSync(path.join(dataDir, 'notes')));
} catch (err) {
  fail('e2e-p37 fatal: ' + err.message);
  console.error(srv?.log().slice(-3000) ?? '');
} finally {
  srv?.stop();
}
done();
```

- [ ] **Step 2: Run it**

Run: `node devtools/dev.mjs e2e p37`
Expected: `e2e-p37 PASS`

- [ ] **Step 3: Run the full suite**

Run: `node devtools/dev.mjs e2e all`
Expected: `e2e: 37/37 suites passed`

- [ ] **Step 4: Commit**

```bash
git add devtools/scripts/e2e/p37.mjs
git commit -m "test(e2e): p37 — site manifest, generated guard + platform seam"
```

---

### Task 15: Close out

**Files:**
- Modify: `docs/superpowers/specs/2026-08-04-site-model-container-design.md` (status line)
- Modify: `README.md` if it names `Assets/DataTemplate` or the flat `Modules/` layout

- [ ] **Step 1: Check for stale references to the old layout**

Run:
```bash
node devtools/scripts/check-layering.mjs
grep -rn "Modules/" --include=*.md --include=*.mjs . | grep -v node_modules | grep -v "^./docs/superpowers"
grep -rn "DataTemplate" --include=*.md --include=*.mjs --include=*.cs . | grep -v node_modules
```
Fix every hit in a tracked file. `docs/superpowers/` history is left alone — those are dated records.

- [ ] **Step 2: Mark the spec delivered**

Change the spec's status line to:

```markdown
> 2026-08-04 · sub-project **S1** of the platform track. Status: implemented — see
> `docs/superpowers/plans/2026-08-04-site-manifest-platform-seam.md`.
```

- [ ] **Step 3: Final verification**

```bash
node devtools/dev.mjs check-layering
node devtools/dev.mjs check-sensitive --tree
node devtools/dev.mjs e2e all
```
Expected: layering clean, sensitive clean, `e2e: 37/37 suites passed`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: mark S1 (site manifest + platform seam) delivered"
```

---

## Deferred to S2 — do not build here

- Capability manifests, permission grants, process sandboxing.
- The escalation harness. Its governing rule is already fixed in the spec: escalations are raised on
  **facts the runtime observed**, never on the agent's narration, because an injected agent writes a
  reassuring explanation exactly when it matters most.
- Closing the `WebFetch` hole — it is granted to the agent and the guard's hook matcher
  (`Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob`) does not intercept it. `deny` exists in
  the manifest for it; wiring `deny` to anything is S2.
- Turning `fill_itinerary` into a template-shipped script tool.
- Provisioning a pinned `node` in the resources bundle.
