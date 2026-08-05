# Platform / Planner assembly split (S4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "Platform must never reference Product" from a rule a test enforces into a fact the compiler enforces, by splitting the server into `Gatherlight.Platform` and `Gatherlight.Planner` class libraries.

**Architecture:** Three projects — `Gatherlight.Platform` (references nothing of ours), `Gatherlight.Planner` (references Platform), and `Gatherlight.Server` (the web app, references both, and keeps the composition root because it wires both layers by definition). The move is staged so the build is green at every commit: Platform extracts first while Product still lives in Server, then Planner extracts.

**Tech Stack:** ASP.NET Core net10.0 class libraries + web app, `Microsoft.NET.Sdk` / `Microsoft.NET.Sdk.Web`, MSBuild `ProjectReference` and `Content`/`Link` items. Verification is `dotnet build`, the node e2e suites, and inspecting real build/publish output.

**Prior art:** S1 created the `Platform/` ÷ `Product/` folder seam and `node devtools/dev.mjs check-layering`, which has held green through S2a and S2b. All 27 modules are already classified; ~20 are Platform. This plan changes *where the code compiles*, not which side anything is on.

---

## The facts this plan is built on (read, not assumed)

| Fact | Source | Consequence |
|---|---|---|
| **Content copy is NOT transitive across a `ProjectReference`** | the comment already in `Gatherlight.Host.csproj`, which links `wwwroot` and `Assets/SiteTemplate` explicitly for exactly this reason | `cap-guard.mjs` must be explicitly linked into **both** Server and Host output, or it silently vanishes |
| A missing `cap-guard.mjs` makes `NodeCapabilityLauncher` **throw** rather than spawn unsandboxed | S2a, `CapabilityLauncher.cs` | the failure is loud at runtime but invisible at build time — check the output listing |
| `AddControllers()` discovers controllers in the **entry assembly only** | ASP.NET Core behaviour | both libraries need `AddApplicationPart`, or ~24 endpoints 404 with a green build |
| ~24 controllers: 22 under `Platform/`, 2 under `Product/Planner/PlanIndex` | `grep` for `ControllerBase` | both libraries genuinely contain controllers; neither can be skipped |
| `PackageReference` and `FrameworkReference` **are** transitive across a `ProjectReference` | NuGet/MSBuild | packages can be declared once in Platform — but verify, don't assume |
| e2e starts the server with `dotnet run --project src/server/Gatherlight.Server --no-build` | `_e2e-common.mjs` | `Gatherlight.Server` must remain the runnable web project; the suites need no change |
| `build-production.mjs` publishes `config.hostProject` and moves `stage/Platform/Capabilities/Sandbox/Assets/cap-guard.mjs` and `stage/Assets/SiteTemplate` | `devtools/scripts/build-production.mjs`, `project.config.mjs` | those staging paths depend on where linked content lands; verify against a real publish |

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `src/server/Gatherlight.Platform/Gatherlight.Platform.csproj` | Class library holding all `Platform/**`. Declares the package + framework references the whole server needs. |
| `src/server/Gatherlight.Planner/Gatherlight.Planner.csproj` | Class library holding `Product/Planner/**`. References Platform. |

**Moved**

| From | To |
|---|---|
| `src/server/Gatherlight.Server/Platform/**` | `src/server/Gatherlight.Platform/**` (drop the redundant `Platform/` folder level — the assembly name carries it) |
| `src/server/Gatherlight.Server/Product/Planner/**` | `src/server/Gatherlight.Planner/**` |

**Namespaces do not change.** `Gatherlight.Server.Platform.*` and `Gatherlight.Server.Product.Planner.*` stay exactly as they are — this is a *compilation* boundary, not a rename. Changing both at once would make the diff unreviewable and every S1/S2 doc reference stale.

**Modified:** `Gatherlight.Server.csproj`, `Gatherlight.Host.csproj`, `GatherlightApp.cs`, `Gatherlight.slnx`, `devtools/scripts/check-layering.mjs`, `devtools/scripts/build-production.mjs`, `.claude/rules/dev-conventions.md`.

---

### Task 1: Extract `Gatherlight.Platform`

**Files:** Create `src/server/Gatherlight.Platform/Gatherlight.Platform.csproj`; move `Gatherlight.Server/Platform/**`; modify `Gatherlight.Server.csproj`, `GatherlightApp.cs`.

Product code stays in `Gatherlight.Server` for this task. That is deliberate: Server referencing Platform is legal, so the build can go green *before* the second move.

- [ ] **Step 1: Read the current server csproj in full**

```bash
cd D:/Development/Games/Gatherlight
cat src/server/Gatherlight.Server/Gatherlight.Server.csproj
```
Note every `PropertyGroup` setting, every `PackageReference`, and the three `Content` items. `<CodePage>65001</CodePage>` is load-bearing — without it, csc on a CJK-locale machine reads Chinese string literals as mojibake. The new library needs it too.

- [ ] **Step 2: Create the class library**

`src/server/Gatherlight.Platform/Gatherlight.Platform.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>Gatherlight.Server.Platform</RootNamespace>
    <AssemblyName>Gatherlight.Platform</AssemblyName>
    <InvariantGlobalization>false</InvariantGlobalization>
    <!-- Sources are BOM-less UTF-8; without this, csc on a CJK-locale Windows machine reads
         them via the ANSI codepage and every Chinese string literal becomes mojibake. -->
    <CodePage>65001</CodePage>
  </PropertyGroup>

  <!-- Controllers, IHostedService, ILogger, Kestrel types. Transitive to consumers. -->
  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>

</Project>
```

Then **move every `PackageReference` from `Gatherlight.Server.csproj` into it**, keeping their comments verbatim — those comments record real incidents (the SQLitePCLRaw CVE pin, the ImageSharp licence pin, why Lyntai's metapackage is not used). They belong with the references.

`PackageReference` is transitive across a `ProjectReference`, so Server and Planner still compile against them. **Verify that rather than trusting it** — if the Server build reports a missing type from a package, say so and add the reference back explicitly.

- [ ] **Step 3: Move the code**

```bash
git mv src/server/Gatherlight.Server/Platform/Kernel        src/server/Gatherlight.Platform/Kernel
git mv src/server/Gatherlight.Server/Platform/Site          src/server/Gatherlight.Platform/Site
git mv src/server/Gatherlight.Server/Platform/Hosting       src/server/Gatherlight.Platform/Hosting
git mv src/server/Gatherlight.Server/Platform/Agent         src/server/Gatherlight.Platform/Agent
git mv src/server/Gatherlight.Server/Platform/Capabilities  src/server/Gatherlight.Platform/Capabilities
git mv src/server/Gatherlight.Server/Platform/Storage       src/server/Gatherlight.Platform/Storage
git mv src/server/Gatherlight.Server/Platform/Ops           src/server/Gatherlight.Platform/Ops
```

The `Platform/` level is dropped — the assembly name carries it. **Namespaces stay `Gatherlight.Server.Platform.*`**, which the `RootNamespace` above preserves for new files.

- [ ] **Step 4: Reference it and register its controllers**

In `Gatherlight.Server.csproj` add:

```xml
  <ItemGroup>
    <ProjectReference Include="..\Gatherlight.Platform\Gatherlight.Platform.csproj" />
  </ItemGroup>
```

In `GatherlightApp.cs`, find the `AddControllers()` call and add the application part. ASP.NET Core scans only the entry assembly, so without this every Platform controller 404s while the build stays green:

```csharp
            .AddControllers()
            // Controllers live in the Platform/Planner assemblies; AddControllers scans only the
            // entry assembly, so each must be registered explicitly or its routes 404 silently.
            .AddApplicationPart(typeof(Platform.Kernel.Services.ISiteContext).Assembly)
```

Use whichever Platform type is convenient as the assembly anchor, but pick a **stable** one and say why in a comment — an anchor that later moves takes the routes with it.

- [ ] **Step 5: Build and fix**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Server `0 Warning(s) 0 Error(s)`; Host `0 Error(s)` plus its one known MSB3277 WindowsBase/WebView2 warning.

Expected breakages and their correct fixes:
- `InternalsVisibleTo`-style access: a type that was `internal` and used across the new boundary now fails. **Make it `public`** rather than adding `InternalsVisibleTo` — the boundary is the point.
- The `Content Include="Platform\Capabilities\Sandbox\Assets\cap-guard.mjs"` item in `Gatherlight.Server.csproj` now points at a path that no longer exists. **Leave it broken for now** and fix it properly in Task 3, which handles all asset linking together — but note in your report that you saw it.

- [ ] **Step 6: Prove the routes still resolve**

A green build proves nothing about controller discovery. Start the server against a scratch data folder and hit an endpoint served by a **Platform** controller:

```bash
node devtools/scripts/make-test-data.mjs devtools/_s4-t1
```
Start it (`node devtools/dev.mjs server 5430`, `GATHERLIGHT_DATA` absolute), wait for `Startup migration complete → serving.`, then:
```bash
curl -s http://127.0.0.1:5430/api/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5430/api/tools
```
Both must succeed (`/api/health` returns JSON, `/api/tools` returns 200). A 404 here means `AddApplicationPart` is missing or anchored wrong. Stop the server; delete the folder.

- [ ] **Step 7: Commit**

```bash
git add -A src/server
git commit -m "refactor(arch): extract Gatherlight.Platform as its own assembly

Product code stays in Gatherlight.Server for now so the build is green at this
commit; Planner extracts next. Namespaces are unchanged — this is a compilation
boundary, not a rename. Controllers need AddApplicationPart because
AddControllers scans only the entry assembly, and a miss 404s silently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Extract `Gatherlight.Planner`

**Files:** Create `src/server/Gatherlight.Planner/Gatherlight.Planner.csproj`; move `Gatherlight.Server/Product/Planner/**`; modify `Gatherlight.Server.csproj`, `GatherlightApp.cs`.

- [ ] **Step 1: Create the class library**

`src/server/Gatherlight.Planner/Gatherlight.Planner.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>Gatherlight.Server.Product.Planner</RootNamespace>
    <AssemblyName>Gatherlight.Planner</AssemblyName>
    <InvariantGlobalization>false</InvariantGlobalization>
    <!-- Sources are BOM-less UTF-8; without this, csc on a CJK-locale Windows machine reads
         them via the ANSI codepage and every Chinese string literal becomes mojibake. -->
    <CodePage>65001</CodePage>
  </PropertyGroup>

  <!-- The one-way dependency, now enforced by the compiler rather than by check-layering:
       Planner may use Platform; Platform cannot name a Planner type, because it does not
       reference this assembly. -->
  <ItemGroup>
    <ProjectReference Include="..\Gatherlight.Platform\Gatherlight.Platform.csproj" />
  </ItemGroup>

</Project>
```

- [ ] **Step 2: Move the code**

```bash
git mv src/server/Gatherlight.Server/Product/Planner/PlanIndex src/server/Gatherlight.Planner/PlanIndex
git mv src/server/Gatherlight.Server/Product/Planner/Scrapers src/server/Gatherlight.Planner/Scrapers
```
Then remove the now-empty `src/server/Gatherlight.Server/Product` directory if git left it behind (git does not track empty directories).

- [ ] **Step 3: Reference it and register its controllers**

In `Gatherlight.Server.csproj`:
```xml
    <ProjectReference Include="..\Gatherlight.Planner\Gatherlight.Planner.csproj" />
```

In `GatherlightApp.cs`, add the second application part next to the first:
```csharp
            .AddApplicationPart(typeof(Product.Planner.PlanIndex.Services.IPlanIndexService).Assembly)
```
Confirm that type's real name before using it as the anchor.

- [ ] **Step 4: Build and prove the direction is now compiler-enforced**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Both green as before.

Then **prove the rule actually bites** — this is the entire point of S4, and a build that merely succeeds does not demonstrate it. Temporarily add a line to any file under `src/server/Gatherlight.Platform/` that names a Planner type, e.g.:
```csharp
// TEMPORARY — must not compile
var _ = typeof(Gatherlight.Server.Product.Planner.PlanIndex.Services.IPlanIndexService);
```
Build. **It must fail** with a "type or namespace could not be found" error. Quote that error, then revert the line and rebuild green. If it *compiles*, the split is not doing its job and you must report BLOCKED.

- [ ] **Step 5: Prove Planner's routes resolve**

Same method as Task 1 Step 6, but hit an endpoint served by a **Planner** controller (`PlanIndex` — check its route, likely `/api/plans`). Scratch folder `devtools/_s4-t2`, port 5431. Delete it afterwards.

- [ ] **Step 6: Commit**

```bash
git add -A src/server
git commit -m "refactor(arch): extract Gatherlight.Planner; the layering rule is now a compiler fact

Platform cannot name a Planner type because it does not reference the assembly
— verified by making it fail to compile, not by assuming. The composition root
stays in Gatherlight.Server, which wires both layers and belongs to neither.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Relink the assets — the silent-failure task

**Files:** Modify `Gatherlight.Server.csproj`, `Gatherlight.Host.csproj`.

**Content copy is not transitive across a `ProjectReference`.** `Gatherlight.Host.csproj` already says so in a comment, which is why it links `wwwroot` and `Assets/SiteTemplate` explicitly. `cap-guard.mjs` now lives in the Platform library and will land in **no** consumer's output unless linked the same way.

This matters more than it looks: if the preload is absent, `NodeCapabilityLauncher` throws rather than spawning unsandboxed — so every network-denied capability stops working, while the build stays perfectly green.

- [ ] **Step 1: Link it into the Server output**

Replace the now-broken `Content Include="Platform\Capabilities\Sandbox\Assets\cap-guard.mjs"` item in `Gatherlight.Server.csproj` with a link from the Platform project, preserving the path `ResourcePaths.CapGuard` probes:

```xml
    <!-- The capability sandbox preload lives in the Platform assembly. Content copy is NOT
         transitive across a ProjectReference, so link it explicitly — and preserve the relative
         path, because ResourcePaths.CapGuard probes {BaseDirectory}/Platform/Capabilities/Sandbox/Assets.
         Absent, the launcher refuses to spawn and every network-denied capability stops working. -->
    <Content Include="..\Gatherlight.Platform\Capabilities\Sandbox\Assets\cap-guard.mjs"
             Link="Platform\Capabilities\Sandbox\Assets\cap-guard.mjs"
             CopyToOutputDirectory="PreserveNewest" />
```

- [ ] **Step 2: Link it into the Host output too**

Add the same item to `Gatherlight.Host.csproj`, alongside its existing `wwwroot` and `Assets/SiteTemplate` links. The Host is what ships; missing it there breaks the released app while every test passes.

- [ ] **Step 3: Verify both outputs by listing them**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
ls src/server/Gatherlight.Server/bin/Debug/net10.0/Platform/Capabilities/Sandbox/Assets/cap-guard.mjs
ls src/server/Gatherlight.Host/bin/Debug/net10.0-windows/Platform/Capabilities/Sandbox/Assets/cap-guard.mjs
ls src/server/Gatherlight.Server/bin/Debug/net10.0/Assets/SiteTemplate/site.json
```
All three must exist. Adjust the Host path if its TFM folder differs — check what is actually there rather than assuming.

- [ ] **Step 4: Prove the sandbox still works end to end**

The listing proves the file copied. This proves the running system finds it:

```bash
node devtools/dev.mjs e2e p38
```
Expected `e2e-p38 PASS` — its battery asserts a network-denied capability cannot reach `node:net`, which is only true if the preload was found and imported. A missing preload makes the launcher throw and the suite fail loudly.

- [ ] **Step 5: Commit**

```bash
git add src/server
git commit -m "fix(build): relink cap-guard.mjs into both consumers after the split

Content copy is not transitive across a ProjectReference — the Host csproj
already noted this for wwwroot and the site template. Without the link the
sandbox preload lands in no output, the launcher refuses to spawn, and every
network-denied capability stops working while the build stays green.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Solution, publish script, and the real bundle

**Files:** Modify `Gatherlight.slnx`, `devtools/scripts/build-production.mjs`.

- [ ] **Step 1: Add both projects to the solution**

```xml
<Solution>
  <Folder Name="/server/">
    <Project Path="src/server/Gatherlight.Platform/Gatherlight.Platform.csproj" />
    <Project Path="src/server/Gatherlight.Planner/Gatherlight.Planner.csproj" />
    <Project Path="src/server/Gatherlight.Server/Gatherlight.Server.csproj" />
    <Project Path="src/server/Gatherlight.Host/Gatherlight.Host.csproj" />
  </Folder>
</Solution>
```

- [ ] **Step 2: Check the publish staging paths against a REAL publish**

`build-production.mjs` moves `stage/Assets/SiteTemplate` → `res/template` and `stage/Platform/Capabilities/Sandbox/Assets/cap-guard.mjs` → `res/cap-guard.mjs`, and its `required()` list fails the build if either is missing. Linked content preserves its `Link` path in the publish output, so both *should* still land where expected — **verify it, do not reason about it.**

```bash
node devtools/scripts/build-production.mjs win-x64 --skip-client
```
Then confirm:
```bash
ls publish/Gatherlight/res/cap-guard.mjs
ls publish/Gatherlight/res/template/CLAUDE.md
ls publish/Gatherlight/res/template/site.json
node -e "const m=require('./publish/Gatherlight/manifest.json'); console.log(m.files.filter(f=>/cap-guard|Gatherlight\.(Platform|Planner)\.dll/.test(f.path)).map(f=>f.path))"
```
`res/cap-guard.mjs` and the template files must exist, and the manifest must list **both new DLLs** — if `Gatherlight.Platform.dll` or `Gatherlight.Planner.dll` is missing from the bundle, the app cannot start on a target machine.

If a staging path moved, fix `build-production.mjs` to the real one and say what changed.

- [ ] **Step 3: Commit**

```bash
git add Gatherlight.slnx devtools/scripts/build-production.mjs
git commit -m "chore(build): add the split projects to the solution; verify the bundle

The publish output was checked against a real run rather than reasoned about —
both new assemblies are in the manifest and the sandbox preload still lands at
res/cap-guard.mjs. A missing assembly would mean the shipped app cannot start.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Teach `check-layering` the new reality

**Files:** Modify `devtools/scripts/check-layering.mjs`.

The reference direction is now compiler-enforced, so the script's namespace scan is a redundancy. Keep it — it fails in a second where a build takes twenty, and it still catches an unclassified module — but make it assert the thing that now actually guarantees the rule.

- [ ] **Step 1: Assert the project reference graph**

Add a check that reads `src/server/Gatherlight.Platform/Gatherlight.Platform.csproj` and **fails if it contains a `ProjectReference` to `Gatherlight.Planner`**. That single line is what makes the rule structural; if someone adds it, everything else silently becomes convention again.

Update the script's paths: it currently walks `src/server/Gatherlight.Server/Platform` and `.../Product`, which no longer exist. Point it at the two new project roots, and update the "unclassified module" check — `Modules/` is long gone, so if that branch is now dead, remove it and say so rather than leaving code that can never fire.

- [ ] **Step 2: Prove both halves**

```bash
node devtools/dev.mjs check-layering
```
Expected clean.

Then prove it fails when it should: temporarily add a `ProjectReference` to Planner inside `Gatherlight.Platform.csproj`, run the check, confirm it **fails with a clear message**, then revert and confirm clean again. Quote both outputs. A checker that cannot fail is not a checker.

- [ ] **Step 3: Commit**

```bash
git add devtools/scripts/check-layering.mjs
git commit -m "chore(arch): check-layering asserts the project reference graph

The namespace scan is now a fast redundancy over a compiler-enforced rule; what
it uniquely guards is the one line that would undo that — a ProjectReference
from Platform to Planner. Verified by making the check fail.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Close out

**Files:** Modify `.claude/rules/dev-conventions.md`, `CLAUDE.md`, and any doc naming the old single-project layout.

- [ ] **Step 1: Update the documented convention**

In `.claude/rules/dev-conventions.md`, revise the two-tier modules bullet: the layout is now three projects, the rule is compiler-enforced, and `check-layering` guards the reference graph. Keep it the same length — replace, don't append.

- [ ] **Step 2: Hunt stale references across every file type**

Earlier in this project a `*.cs`-only grep missed path strings in `.mjs`, `.ps1`, `.csproj` and a C++ header, including two build scripts that would have broken silently.

```bash
cd D:/Development/Games/Gatherlight
grep -rn "Gatherlight.Server/Platform\|Gatherlight.Server/Product\|Gatherlight\.Server\\\\Platform" --include=* . 2>/dev/null | grep -v node_modules | grep -v "^\./\.git/" | grep -v "^\./docs/superpowers"
```
Fix everything that names a path that no longer exists — including `.ps1` scripts, e2e suites, and `project.config.mjs`. Report each hit and its disposition. `docs/superpowers/**` is a dated record; leave it.

- [ ] **Step 3: Full verification**

```bash
node devtools/dev.mjs check-layering
node devtools/scripts/check-sensitive.mjs --tree
dotnet build src/server/Gatherlight.Platform/Gatherlight.Platform.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Planner/Gatherlight.Planner.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
All four build; the three net10.0 projects at `0 Warning(s) 0 Error(s)`; Host with only its known MSB3277.

**Do not run the full e2e suite from a subagent** — a backgrounded suite is orphaned when the agent's turn ends, which already cost one wasted run in this project. The coordinator runs `node devtools/dev.mjs e2e all`, expecting `40/40`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: S4 delivered — Platform and Planner are separate assemblies

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in scope

- **Renaming namespaces** to match assembly names. `Gatherlight.Server.Platform.*` stays; changing it would make this diff unreviewable and every S1/S2 document reference stale, for no functional gain.
- **Splitting the client.** S1's non-goals deferred it and nothing here changes that.
- **Moving `Assets/SiteTemplate` into a library.** It is content the host stages; leaving it in `Gatherlight.Server` keeps the existing publish path and the Host's existing link working.
