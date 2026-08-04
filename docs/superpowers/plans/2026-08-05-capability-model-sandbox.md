# Capability model + enforcement + sandbox (S2a) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn S1's declared `capabilities.deny` / `capabilities.enabled` into enforced reality, behind one registry that knows each capability's provenance, with non-platform capabilities contained by a sandbox whose promises are verified by real escape attempts.

**Architecture:** Trust follows provenance — the 33 compiled tools stay in-process and unsandboxed; `Script` and `Mcp` capabilities are off until the manifest enables them, and `Script` ones run under `node --permission` plus a platform-owned preload that removes the network. The launcher probes its runtime and **fails closed** if it cannot enforce, because the approval card in S2b will print those permissions as promises.

**Tech Stack:** ASP.NET Core net10.0, C# 13, Node ≥ 22.15 for the sandbox (`--permission` + `module.registerHooks`). No .NET test project — verification is `dotnet build`, node e2e suites, and the `check-*` script family.

**Spec:** `docs/superpowers/specs/2026-08-05-capability-model-design.md`

**Before writing any C#, confirm these namespaces**, which moved during S1's Platform/Product
reshuffle and are referenced throughout this plan: `IGatherlightTool`, `ToolException`,
`IScriptToolProvider` and `ToolRegistry` now live under `Gatherlight.Server.Platform.Capabilities.Tools.*`.
Grep for each and use what is actually there — this plan's snippets assume the shape but were not
compiled against it. `node devtools/dev.mjs check-layering` must stay green throughout: every file
this plan creates belongs to `Platform/` and must never reference `Product/`.

**Scope:** S2a only — the model and the boundary. Enablement is by hand-editing `site.json`; the approval cards, drafts and escalation harness are S2b, and depend on the guarantees this plan establishes.

---

## Verified facts this plan is built on

These were measured on Node v24.13.1, not taken from documentation. Re-verify if the runtime changes.

| Behaviour | Result |
|---|---|
| `--allow-fs-read` / `--allow-fs-write` scoping | enforced; outside reads/writes throw `ERR_ACCESS_DENIED` |
| `child_process` **import** | **ALLOWED** — only `spawnSync`/`execSync` etc. throw `ERR_ACCESS_DENIED` |
| `worker_threads` `new Worker()` | `ERR_ACCESS_DENIED` |
| `process.binding('tcp_wrap')` | `ERR_ACCESS_DENIED` |
| `fetch` / `net.connect` under `--permission` | **ALLOWED** — the permission model has no network dimension |
| `module.registerHooks` resolve hook | blocks `node:net`, bare `net`, and `createRequire(...)('node:net')` |
| `delete globalThis.fetch` | effective; no public API restores it once the network modules are blocked |
| `--import` on Windows | **must be a `file://` URL** — a bare drive-letter path throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` |

The network denial holds **only because** spawn, workers and `process.binding` are already denied — otherwise a capability could reach the network by escaping the process. Any future change that relaxes one of those three silently invalidates the "cannot reach the internet" promise.

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `Platform/Capabilities/Sandbox/Assets/cap-guard.mjs` | The platform preload: blocks network modules, removes `fetch`. Shipped, never authored by a capability. |
| `Platform/Capabilities/Sandbox/Services/CapabilityRuntime.cs` | Probes a node executable for `--permission` + `registerHooks`; caches the verdict. Fails closed. |
| `Platform/Capabilities/Sandbox/Services/CapabilityLauncher.cs` | `ICapabilityLauncher` + the Node implementation: turns a grant into argv. |
| `Platform/Capabilities/Models/CapabilityGrant.cs` | The grant object + its tolerant JSON converter (string OR object). |
| `Platform/Capabilities/Models/CapabilityInfo.cs` | `{ Id, Origin, Title, Description, InputSchema, State }`. |
| `Platform/Capabilities/Services/CapabilityRegistry.cs` | `ICapabilityRegistry` — one projection over all origins, applying deny/enabled. |
| `devtools/scripts/e2e/p38.mjs` | The enforcement + sandbox-escape battery. |
| `devtools/scripts/e2e/fixtures/cap-escape/` | A fixture capability that genuinely attempts to escape. |

**Modified**

| File | Change |
|---|---|
| `Platform/Site/Models/SiteManifest.cs` | `SiteCapabilities.Enabled` becomes `IReadOnlyList<CapabilityGrant>`. |
| `Platform/Capabilities/Tools/Services/ScriptToolProvider.cs` | Gate on `enabled`; run through `ICapabilityLauncher`. |
| `Platform/Capabilities/Tools/Services/ToolRegistry.cs` | Project through `ICapabilityRegistry`. |
| `Platform/Agent/Chat/Services/ChatEnvironmentService.cs` | Omit denied CLI built-ins from the generated allow-list; add them to the guard's deny list. |
| `GatherlightApp.cs` | Register the new services. |

**No database change in S2a.** The registry is derived from the manifest plus disk. S2b may need tables for escalation records; that is its plan's decision.

---

### Task 1: The grant model with a tolerant reader

**Files:**
- Create: `src/server/Gatherlight.Server/Platform/Capabilities/Models/CapabilityGrant.cs`
- Modify: `src/server/Gatherlight.Server/Platform/Site/Models/SiteManifest.cs`

- [ ] **Step 1: Write the grant model**

Create `Platform/Capabilities/Models/CapabilityGrant.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Gatherlight.Server.Platform.Capabilities.Models;

/// <summary>
/// What a non-platform capability is permitted to do. Every field is DENY-BY-DEFAULT, so the
/// least-specified form is the most restricted — which matters because a bare id string is both
/// the shape S1 shipped and the shape a hand-edit is likeliest to take.
/// </summary>
public sealed class CapabilityGrant
{
    public string Id { get; init; } = "";
    public CapabilityFs Fs { get; init; } = new();
    /// <summary>Outbound network. False = the platform preload removes it entirely.</summary>
    public bool Net { get; init; }
}

/// <summary>Filesystem reach, named in manifest vocabulary: a declared record directory, or the
/// literal <c>cache</c>. Never an absolute path, never <c>state</c>, never outside the site.</summary>
public sealed class CapabilityFs
{
    public IReadOnlyList<string> Read { get; init; } = [];
    /// <summary>Absent means the scratch area only.</summary>
    public IReadOnlyList<string> Write { get; init; } = ["cache"];
}

/// <summary>
/// Reads an <c>enabled</c> entry that may be either a bare id string or a full grant object.
/// S1 shipped the string form and promised S2 would be additive; this converter is that promise.
/// </summary>
public sealed class CapabilityGrantConverter : JsonConverter<CapabilityGrant>
{
    public override CapabilityGrant Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
            return new CapabilityGrant { Id = reader.GetString() ?? "" };

        using var doc = JsonDocument.ParseValue(ref reader);
        var root = doc.RootElement;
        var fs = root.TryGetProperty("fs", out var fsEl)
            ? fsEl.Deserialize<CapabilityFs>(options) ?? new CapabilityFs()
            : new CapabilityFs();
        return new CapabilityGrant
        {
            Id = root.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "",
            Fs = fs,
            Net = root.TryGetProperty("net", out var netEl) && netEl.ValueKind == JsonValueKind.True,
        };
    }

    public override void Write(Utf8JsonWriter writer, CapabilityGrant value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("id", value.Id);
        writer.WritePropertyName("fs");
        JsonSerializer.Serialize(writer, value.Fs, options);
        writer.WriteBoolean("net", value.Net);
        writer.WriteEndObject();
    }
}
```

- [ ] **Step 2: Point the manifest at it**

In `Platform/Site/Models/SiteManifest.cs`, change `SiteCapabilities`:

```csharp
public sealed class SiteCapabilities
{
    /// <summary>Anything agent-callable deliberately withheld — a shipped MCP tool OR a CLI
    /// built-in such as <c>WebFetch</c>, which the scope guard's hook matcher does not intercept.</summary>
    public IReadOnlyList<string> Deny { get; init; } = [];

    /// <summary>Capabilities that did NOT come from the platform, off until a human enables them.
    /// An entry may be a bare id or a full grant; see <see cref="Capabilities.Models.CapabilityGrant"/>.</summary>
    [System.Text.Json.Serialization.JsonConverter(typeof(GrantListConverter))]
    public IReadOnlyList<Capabilities.Models.CapabilityGrant> Enabled { get; init; } = [];
}
```

Add the list converter in the same file (a per-item converter is not enough for a list property):

```csharp
/// <summary>Applies <see cref="Capabilities.Models.CapabilityGrantConverter"/> per element so a
/// mixed list of bare ids and grant objects round-trips.</summary>
public sealed class GrantListConverter
    : System.Text.Json.Serialization.JsonConverter<IReadOnlyList<Capabilities.Models.CapabilityGrant>>
{
    private static readonly Capabilities.Models.CapabilityGrantConverter Item = new();

    public override IReadOnlyList<Capabilities.Models.CapabilityGrant> Read(
        ref System.Text.Json.Utf8JsonReader reader, Type type, System.Text.Json.JsonSerializerOptions options)
    {
        var list = new List<Capabilities.Models.CapabilityGrant>();
        if (reader.TokenType != System.Text.Json.JsonTokenType.StartArray) return list;
        while (reader.Read() && reader.TokenType != System.Text.Json.JsonTokenType.EndArray)
            list.Add(Item.Read(ref reader, typeof(Capabilities.Models.CapabilityGrant), options));
        return list;
    }

    public override void Write(System.Text.Json.Utf8JsonWriter writer,
        IReadOnlyList<Capabilities.Models.CapabilityGrant> value, System.Text.Json.JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        foreach (var g in value) Item.Write(writer, g, options);
        writer.WriteEndArray();
    }
}
```

- [ ] **Step 3: Build**

Run: `dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo`
Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`

- [ ] **Step 4: Verify both shapes round-trip**

The shipped template's `site.json` has `"enabled": []`; a hand-edited one may have `["x"]` or `[{"id":"x","fs":{"read":["plans"]},"net":true}]`. Confirm all three parse, using an inline check that starts the server against a scratch folder and reads back what it wrote — **do not add a test project, do not leave a scratch file in the repo.**

```bash
node devtools/scripts/make-test-data.mjs devtools/_s2-t1
```
Write each of the three shapes into `devtools/_s2-t1/site.json` in turn, start the server (`node devtools/dev.mjs server 5420`, `GATHERLIGHT_DATA` absolute), confirm it reaches `Startup migration complete → serving.` each time without an unparseable-manifest error, then stop it. Delete `devtools/_s2-t1`.

Report what you observed for each shape. A manifest that fails to parse is fatal by design (S1), so a startup failure here is a real defect, not a test artefact.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server/Platform
git commit -m "feat(capabilities): grant model with a tolerant enabled-list reader

An enabled entry may be a bare id or a full grant object; S1 shipped the string
form and promised S2 would be additive. Every grant field is deny-by-default,
so the least-specified form is the most restricted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The platform preload

**Files:**
- Create: `src/server/Gatherlight.Server/Platform/Capabilities/Sandbox/Assets/cap-guard.mjs`
- Modify: `src/server/Gatherlight.Server/Gatherlight.Server.csproj`
- Modify: `devtools/scripts/build-production.mjs`

- [ ] **Step 1: Write the preload**

Create `Platform/Capabilities/Sandbox/Assets/cap-guard.mjs`:

```js
// cap-guard.mjs — the platform's network denial for a sandboxed capability.
//
// Node's permission model has no network dimension, so this supplies one. It is loaded via
// --import BEFORE the capability's own code and is owned by the platform; a capability never
// sees it as editable content.
//
// This is airtight ONLY BECAUSE --permission already denies child_process spawn, worker_threads
// and process.binding. Those denials remove every route by which a capability could reach the
// network without going through module resolution. If any of them is ever relaxed, the
// "cannot reach the internet" promise printed on the approval card becomes false.
import { registerHooks } from 'node:module';

const BLOCKED = new Set(['net', 'http', 'https', 'tls', 'dgram', 'http2', 'dns', 'inspector']);
const bare = (s) => s.replace(/^node:/, '');

registerHooks({
  resolve(specifier, context, next) {
    if (BLOCKED.has(bare(specifier)))
      throw new Error(`network access is not granted to this capability (${specifier})`);
    return next(specifier, context);
  },
});

// Global fetch is built on internals rather than a resolvable module, so blocking modules is not
// enough — remove it and its siblings outright. With the network modules blocked there is no
// public API that restores them.
for (const k of ['fetch', 'WebSocket', 'EventSource']) {
  try { delete globalThis[k]; } catch { /* non-configurable on some runtimes; the module block still holds */ }
}
```

- [ ] **Step 2: Ship it**

In `Gatherlight.Server.csproj`, next to the existing `Assets\SiteTemplate` content item:

```xml
    <Content Include="Platform\Capabilities\Sandbox\Assets\cap-guard.mjs" CopyToOutputDirectory="PreserveNewest" />
```

In `devtools/scripts/build-production.mjs`, immediately after the `move(...SiteTemplate...)` line in step 3:

```js
// The capability sandbox preload — a security asset, not optional content. Its absence would mean
// a sandboxed capability silently keeps network access, so the required() check below asserts it.
move(path.join(stage, 'Platform', 'Capabilities', 'Sandbox', 'Assets', 'cap-guard.mjs'),
     path.join(res, 'cap-guard.mjs'));
```

And add it to the `required()` list in the same file:

```js
  path.join(res, 'cap-guard.mjs'),
```

- [ ] **Step 3: Verify it ships**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
ls src/server/Gatherlight.Server/bin/Debug/net10.0/Platform/Capabilities/Sandbox/Assets/cap-guard.mjs
```
Both must succeed. A `Content Include` with a wrong path fails silently, which is why this is checked rather than assumed.

- [ ] **Step 4: Prove the preload actually blocks, standalone**

Before wiring any C#, confirm the mechanism against real escape attempts. Create a throwaway probe **outside the repo** (use the OS temp directory, delete it afterwards) containing:

```js
const r = async (label, fn) => { try { await fn(); console.log(`${label}: ESCAPED`); } catch (e) { console.log(`${label}: blocked`); } };
await r('fetch', () => fetch('http://1.1.1.1/'));
await r('import node:net', async () => { const n = await import('node:net'); n.connect(80, '1.1.1.1'); });
await r('import net bare', async () => { const n = await import('net'); n.connect(80, '1.1.1.1'); });
await r('createRequire net', async () => { const { createRequire } = await import('node:module'); createRequire(import.meta.url)('node:net'); });
await r('spawn', async () => { const cp = await import('node:child_process'); const x = cp.spawnSync(process.execPath, ['-e', '1']); if (x.error) throw x.error; });
await r('worker', async () => { const w = await import('node:worker_threads'); new w.Worker('', { eval: true }); });
```

Run it with the built guard. **On Windows `--import` must be a `file://` URL** — build it with `require('node:url').pathToFileURL(p).href`, or Node throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` on the drive letter.

Expected: every line reports `blocked`. Report the actual output. If any line reports `ESCAPED`, STOP and report BLOCKED — the sandbox does not hold and nothing downstream should be built on it.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server devtools/scripts/build-production.mjs
git commit -m "feat(capabilities): platform preload that denies a capability the network

Node's permission model has no network dimension. This blocks the network
modules via a resolve hook and removes global fetch. It holds only because
spawn, workers and process.binding are already denied — that reasoning is the
guarantee, and is recorded in the file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The runtime probe — fail closed

**Files:**
- Create: `src/server/Gatherlight.Server/Platform/Capabilities/Sandbox/Services/CapabilityRuntime.cs`

- [ ] **Step 1: Write the probe**

The approval card in S2b prints permissions as promises. A runtime that cannot enforce them must therefore refuse to run the capability at all, rather than running it unsandboxed.

Create `Platform/Capabilities/Sandbox/Services/CapabilityRuntime.cs`:

```csharp
using System.Diagnostics;

namespace Gatherlight.Server.Platform.Capabilities.Sandbox.Services;

public interface ICapabilityRuntime
{
    /// <summary>The node executable able to enforce the sandbox, or null when none is.</summary>
    string? NodePath { get; }
    /// <summary>Why the sandbox is unavailable, for the operator. Null when it is available.</summary>
    string? Unavailable { get; }
}

/// <summary>
/// Probes a node executable for the two features the sandbox needs: the permission model
/// (<c>--permission</c>) and synchronous module hooks (<c>module.registerHooks</c>, Node 22.15+).
/// If neither the PATH node nor the provisioned one qualifies, the sandbox is UNAVAILABLE and
/// every Script capability refuses to run.
///
/// Failing closed is the whole point: an unenforced capability whose card claims "cannot reach the
/// internet" is worse than one that does not run, because the claim is what the household trusts.
/// </summary>
public sealed class CapabilityRuntime : ICapabilityRuntime
{
    private const string Probe = "const m=require('node:module');process.exit(typeof m.registerHooks==='function'?0:9)";

    public CapabilityRuntime(Kernel.Services.IPlatformContext platform, ILogger<CapabilityRuntime> log)
    {
        foreach (var candidate in Candidates(platform))
        {
            if (!Supports(candidate)) continue;
            NodePath = candidate;
            log.LogInformation("Capability sandbox: using {Node}", candidate);
            return;
        }
        Unavailable = "no node runtime supporting --permission + module.registerHooks (Node 22.15+) was found";
        log.LogWarning("Capability sandbox UNAVAILABLE — {Reason}. Script capabilities will refuse to run.", Unavailable);
    }

    public string? NodePath { get; }
    public string? Unavailable { get; }

    private static IEnumerable<string> Candidates(Kernel.Services.IPlatformContext platform)
    {
        var provisioned = Path.Combine(platform.ResourcesPath, ".playwright", "node", "win32_x64", "node.exe");
        if (File.Exists(provisioned)) yield return provisioned;
        yield return "node";
    }

    // Run the probe UNDER --permission, so a runtime that has registerHooks but rejects the
    // permission flag is also rejected. Exit code 0 means both features are present.
    private static bool Supports(string exe)
    {
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("--permission");
            psi.ArgumentList.Add("-e");
            psi.ArgumentList.Add(Probe);
            using var p = Process.Start(psi);
            if (p is null) return false;
            if (!p.WaitForExit(10_000)) { try { p.Kill(true); } catch { } return false; }
            return p.ExitCode == 0;
        }
        catch
        {
            return false;   // missing executable, or a node too old to accept --permission
        }
    }
}
```

- [ ] **Step 2: Register it**

In `GatherlightApp.cs`, alongside the other Platform singletons:

```csharp
            .AddSingleton<Platform.Capabilities.Sandbox.Services.ICapabilityRuntime,
                          Platform.Capabilities.Sandbox.Services.CapabilityRuntime>()
```

- [ ] **Step 3: Build and observe the probe**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
```
Then start the server against a scratch folder (`node devtools/scripts/make-test-data.mjs devtools/_s2-t3`, then `node devtools/dev.mjs server 5421` with `GATHERLIGHT_DATA` absolute) and find the `Capability sandbox:` line in the log. Report which node it selected. Stop the server and delete the folder.

- [ ] **Step 4: Verify it fails closed**

Confirm the negative path works, because it is the one that matters. Run the probe logic by hand against a runtime that cannot enforce — the simplest honest check is to confirm `Supports()` returns false for a non-existent executable and for one that rejects `--permission`:

```bash
node --permission -e "const m=require('node:module');process.exit(typeof m.registerHooks==='function'?0:9)"; echo "supported exit: $?"
```
Expected: `supported exit: 0` on the dev machine's Node.

Then confirm the failure shape without breaking your environment: temporarily rename nothing — instead reason from the code and state plainly what happens when `Supports()` returns false for every candidate (`NodePath` null, `Unavailable` set, warning logged). Task 4 makes that state refuse to launch, and Task 8's e2e proves it end to end.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server
git commit -m "feat(capabilities): probe the node runtime; sandbox fails closed when unavailable

An unenforced capability whose card claims it cannot reach the internet is
worse than one that does not run, because the claim is what is trusted. The
probe runs UNDER --permission so a runtime with registerHooks but no permission
support is also rejected.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The launcher

**Files:**
- Create: `src/server/Gatherlight.Server/Platform/Capabilities/Sandbox/Services/CapabilityLauncher.cs`

- [ ] **Step 1: Write the launcher**

```csharp
using System.Diagnostics;
using Gatherlight.Server.Platform.Capabilities.Models;

namespace Gatherlight.Server.Platform.Capabilities.Sandbox.Services;

public interface ICapabilityLauncher
{
    /// <summary>Build the process for a sandboxed capability entry. Throws when the sandbox cannot
    /// be enforced — never returns an unsandboxed process.</summary>
    ProcessStartInfo Build(CapabilityGrant grant, string workingDir, string entryFile);
}

/// <summary>
/// The Node implementation: filesystem scope from the grant, plus the platform preload that removes
/// the network unless the grant allows it. This is the seam a low-privilege-OS-account launcher can
/// replace later without touching capability code.
/// </summary>
public sealed class NodeCapabilityLauncher : ICapabilityLauncher
{
    private readonly ICapabilityRuntime _runtime;
    private readonly Kernel.Services.ISiteContext _site;

    public NodeCapabilityLauncher(ICapabilityRuntime runtime, Kernel.Services.ISiteContext site)
    {
        _runtime = runtime;
        _site = site;
    }

    public ProcessStartInfo Build(CapabilityGrant grant, string workingDir, string entryFile)
    {
        if (_runtime.NodePath is null)
            throw new Tools.Models.ToolException(503,
                $"能力沙箱不可用,拒绝以未受限方式运行:{_runtime.Unavailable}");

        var psi = new ProcessStartInfo(_runtime.NodePath)
        {
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("--permission");

        // The capability must be able to read its own code.
        psi.ArgumentList.Add($"--allow-fs-read={workingDir}");
        foreach (var dir in Resolve(grant.Fs.Read)) psi.ArgumentList.Add($"--allow-fs-read={dir}");
        foreach (var dir in Resolve(grant.Fs.Write)) psi.ArgumentList.Add($"--allow-fs-write={dir}");

        if (!grant.Net)
        {
            // Windows rejects a bare drive-letter path here with ERR_UNSUPPORTED_ESM_URL_SCHEME.
            var guard = new Uri(Kernel.Services.ResourcePaths.CapGuard).AbsoluteUri;
            psi.ArgumentList.Add($"--import={guard}");
        }

        psi.ArgumentList.Add(entryFile);
        return psi;
    }

    // Grant vocabulary is manifest-relative: a declared record directory, or the literal "cache".
    // Anything else — an absolute path, "state", a traversal — resolves to nothing and is dropped,
    // so a malformed grant fails CLOSED rather than widening reach.
    private IEnumerable<string> Resolve(IReadOnlyList<string> names)
    {
        foreach (var name in names)
        {
            if (string.IsNullOrWhiteSpace(name)) continue;
            var abs = _site.ResolveSitePath(name);
            if (abs is null) continue;
            Directory.CreateDirectory(abs);
            yield return abs;
        }
    }
}
```

- [ ] **Step 2: Add the guard path to ResourcePaths**

In `Platform/Kernel/Services/ResourcePaths.cs`:

```csharp
    /// <summary>The capability sandbox preload. Shipped as a security asset — its absence means a
    /// sandboxed capability would keep network access, so the launcher must treat a miss as fatal
    /// rather than spawning without it.</summary>
    public static string CapGuard => Path.Combine(
        First("cap-guard.mjs",
            Path.Combine(Base, "Platform", "Capabilities", "Sandbox", "Assets"),
            Path.Combine(Base, "res"),
            Path.Combine(Base, "..", "res")),
        "cap-guard.mjs");
```

`First` returns a **directory** (falling back to the first candidate when the marker is absent), which is why the filename is joined on afterwards. Read it before writing this to confirm that contract still holds.

Because `First` falls back rather than failing, `CapGuard` can name a file that does not exist. **The launcher must check** — add this to `NodeCapabilityLauncher.Build` immediately before composing the `--import` argument:

```csharp
            if (!File.Exists(Kernel.Services.ResourcePaths.CapGuard))
                throw new Tools.Models.ToolException(500,
                    "能力沙箱预载缺失(cap-guard.mjs),拒绝以可联网方式运行能力。");
```

Without that check a broken build would spawn capabilities *with* network access while their grant says `net: false` — the exact failure the whole design exists to prevent, and one no test would notice unless it looked for it.

- [ ] **Step 3: Register it**

```csharp
            .AddSingleton<Platform.Capabilities.Sandbox.Services.ICapabilityLauncher,
                          Platform.Capabilities.Sandbox.Services.NodeCapabilityLauncher>()
```

- [ ] **Step 4: Build**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
Server `0 Warning(s) 0 Error(s)`; Host `0 Error(s)` plus its one known MSB3277 warning.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server
git commit -m "feat(capabilities): sandboxed launcher building argv from a grant

Filesystem scope comes from the grant in manifest vocabulary; an unresolvable
name is dropped rather than widening reach. The network preload is attached
unless the grant allows net. Throws rather than returning an unsandboxed
process when the runtime cannot enforce.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Run script tools through the launcher

**Files:**
- Modify: `src/server/Gatherlight.Server/Platform/Capabilities/Tools/Services/ScriptToolProvider.cs`

- [ ] **Step 1: Read the existing spawn**

`ScriptTool.RunAsync` currently builds its own `ProcessStartInfo` from `command.exe` + `command.args` and writes the tool's JSON arguments to stdin. Read it fully before changing anything — the stdin/stdout contract, the output cap, the timeout and the kill-on-cancel behaviour must all survive.

- [ ] **Step 2: Route the spawn through the launcher**

`ScriptTool` takes `ICapabilityLauncher` and its `CapabilityGrant`, and replaces the hand-built `ProcessStartInfo` with `_launcher.Build(grant, dir, entry)`. Keep every other behaviour identical: stdin write, capped stdout/stderr reads, the timeout, `Kill(entireProcessTree: true)` on cancel, and the exit-code error shape.

A manifest declaring `command.exe` as something other than node is no longer honoured — the sandbox is a node sandbox. Reject such a manifest at load time with a clear message naming the tool, rather than silently running it unsandboxed.

- [ ] **Step 3: Build and confirm no behaviour drift**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p26
```
`p26` exercises the job/tool paths. Expected: `e2e-p26 PASS`.

- [ ] **Step 4: Commit**

```bash
git add src/server/Gatherlight.Server
git commit -m "feat(capabilities): script tools spawn through the sandboxed launcher

A manifest naming a non-node command is now rejected at load rather than run
unsandboxed — the sandbox is a node sandbox, and silently honouring another
runtime would break the promise the approval card makes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The registry — provenance and state

**Files:**
- Create: `src/server/Gatherlight.Server/Platform/Capabilities/Models/CapabilityInfo.cs`
- Create: `src/server/Gatherlight.Server/Platform/Capabilities/Services/CapabilityRegistry.cs`
- Modify: `src/server/Gatherlight.Server/Platform/Capabilities/Tools/Services/ToolRegistry.cs`

- [ ] **Step 1: The info model**

```csharp
namespace Gatherlight.Server.Platform.Capabilities.Models;

/// <summary>Where a capability came from. Provenance decides its treatment: what we shipped is
/// trusted and unsandboxed; anything else is off until enabled, and contained when it runs.</summary>
public enum CapabilityOrigin { Platform, Script, Mcp, Draft }

public enum CapabilityState { Available, NotEnabled, Denied }

/// <summary>One capability as the console and the agent see it — the single projection, so what the
/// agent can call and what the console displays can never disagree.</summary>
public sealed record CapabilityInfo(
    string Id,
    CapabilityOrigin Origin,
    string Title,
    string Description,
    string InputSchema,
    CapabilityState State);
```

- [ ] **Step 2: The registry**

```csharp
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Capabilities.Services;

public interface ICapabilityRegistry
{
    /// <summary>Every known capability with its state — including ones that are not available,
    /// so the console can show why.</summary>
    IReadOnlyList<CapabilityInfo> All();
    /// <summary>Only what the agent may actually call.</summary>
    IReadOnlyList<CapabilityInfo> Available();
    CapabilityGrant? GrantFor(string id);
}

/// <summary>
/// One projection over every origin, applying the manifest. Platform capabilities are available
/// unless denied; Script and Mcp are available only when enabled AND not denied. Drafts are never
/// available — an unapproved draft is inert by construction, not by policy.
/// </summary>
public sealed class CapabilityRegistry : ICapabilityRegistry
{
    private readonly IEnumerable<Tools.Services.IGatherlightTool> _platform;
    private readonly Tools.Services.IScriptToolProvider _scripts;
    private readonly ISiteManifestStore _manifest;

    public CapabilityRegistry(IEnumerable<Tools.Services.IGatherlightTool> platform,
        Tools.Services.IScriptToolProvider scripts, ISiteManifestStore manifest)
    {
        _platform = platform;
        _scripts = scripts;
        _manifest = manifest;
    }

    public IReadOnlyList<CapabilityInfo> All()
    {
        var caps = _manifest.Current.Capabilities;
        var denied = caps.Deny.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var enabled = caps.Enabled.ToDictionary(g => g.Id, StringComparer.OrdinalIgnoreCase);

        var list = new List<CapabilityInfo>();
        foreach (var t in _platform)
            list.Add(new CapabilityInfo(t.Name, CapabilityOrigin.Platform, t.Name, t.Description, t.InputSchema,
                denied.Contains(t.Name) ? CapabilityState.Denied : CapabilityState.Available));
        foreach (var t in _scripts.Current)
            list.Add(new CapabilityInfo(t.Name, CapabilityOrigin.Script, t.Name, t.Description, t.InputSchema,
                denied.Contains(t.Name) ? CapabilityState.Denied
                : enabled.ContainsKey(t.Name) ? CapabilityState.Available
                : CapabilityState.NotEnabled));
        return list;
    }

    public IReadOnlyList<CapabilityInfo> Available() =>
        All().Where(c => c.State == CapabilityState.Available).ToList();

    public CapabilityGrant? GrantFor(string id) =>
        _manifest.Current.Capabilities.Enabled.FirstOrDefault(g =>
            string.Equals(g.Id, id, StringComparison.OrdinalIgnoreCase));
}
```

`IScriptToolProvider` currently exposes `Current`; confirm its exact member names before writing against it and adjust if they differ. Mcp-origin capabilities are added in the same shape once the MCP proxy exposes its tool list — if that surface is not readily available, leave `Mcp` out of the projection for now and say so, rather than inventing an interface.

- [ ] **Step 3: Project the tool registry through it**

`ToolRegistry.List(surface)` and its call-path must return only `Available()` capabilities, so a denied or not-enabled capability is absent from `/api/tools` **and** `/mcp` tools/list, and refused on call with a 4xx naming the reason.

- [ ] **Step 4: Build + registration + suites**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p2
node devtools/dev.mjs e2e p10
```
Both expected PASS — they assert the shipped tools are registered, which must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server
git commit -m "feat(capabilities): one registry carrying provenance and state

Platform capabilities are available unless denied; Script and Mcp only when
enabled and not denied; drafts never. /api/tools and /mcp both project from it,
so what the agent can call and what the console shows cannot disagree.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Deny the CLI built-ins

**Files:**
- Modify: `src/server/Gatherlight.Server/Platform/Agent/Chat/Services/ChatEnvironmentService.cs`

- [ ] **Step 1: Filter the generated allow-list**

`BuildChatSettings` emits a fixed `permissions.allow` array (`Read`, `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit`, `TodoWrite`, `WebFetch`, `WebSearch`, `Skill`, `Bash`). Filter out any id present in `manifest.Current.Capabilities.Deny`, matched case-insensitively.

- [ ] **Step 2: Also deny it in the guard**

Removing a tool from the allow-list is one plane; the scope guard is the other, and a boundary that can be re-opened by editing one file is not a boundary. Add a `__DENIED_TOOLS__` placeholder to the `ScopeGuardMjs` template rendered the same way `__WRITE_DIRS__` already is, and an early check in the guard:

```js
const DENIED = __DENIED_TOOLS__;
```

and immediately after `toolName` is read:

```js
if (DENIED.includes(toolName))
  deny(`Blocked: ${toolName} is not available in this site (denied in site.json).`);
```

Bump `// GUARD_VERSION: 5` → `6` so existing data folders receive the re-issue.

- [ ] **Step 3: Update p24's extractor**

`devtools/scripts/e2e/p24.mjs` substitutes `__WRITE_DIRS__` when it extracts the guard from the C# constant, and asserts the placeholder exists. Add the same handling for `__DENIED_TOOLS__` — substitute `[]` (the default-manifest render) and assert that placeholder exists too, so the suite cannot silently drift.

- [ ] **Step 4: Verify both planes**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p24
```
`e2e-p24 PASS` expected.

Then by hand: `node devtools/scripts/make-test-data.mjs devtools/_s2-t7`, set its `site.json` `capabilities.deny` to `["WebFetch"]`, start the server (`node devtools/dev.mjs server 5422`), stop it, and confirm **both**:
- `devtools/_s2-t7/state/settings.chat.json` no longer lists `WebFetch` in `permissions.allow`
- `devtools/_s2-t7/.claude/hooks/scope-guard.mjs` contains `const DENIED = ['WebFetch'];`

Delete the folder. Report both observations.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server devtools/scripts/e2e/p24.mjs
git commit -m "feat(capabilities): deny spans CLI built-ins as well as MCP tools

WebFetch is granted to the agent and the guard's matcher never intercepted it —
the documented exfiltration residual. deny now removes it from the generated
allow-list AND denies it in the guard, so re-opening one plane does not re-open
the boundary. GUARD_VERSION 5 -> 6.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The escape battery — e2e p38

**Files:**
- Create: `devtools/scripts/e2e/p38.mjs`
- Create: `devtools/scripts/e2e/fixtures/cap-escape/tool.json`
- Create: `devtools/scripts/e2e/fixtures/cap-escape/escape.mjs`

This is the task the whole plan exists to make possible. **Every assertion must be a real attempt**, and every denial must be paired with a positive control — otherwise a launcher that denies everything, or spawns nothing at all, would pass.

- [ ] **Step 1: The fixture capability**

`fixtures/cap-escape/escape.mjs` reads its args from stdin (the script-tool contract) and reports, as JSON on stdout, the outcome of each attempt:

```js
#!/usr/bin/env node
// A capability that genuinely tries to escape its sandbox. Each probe reports allowed/blocked;
// the suite asserts the expected verdict for each, INCLUDING the positive controls — a launcher
// that denied everything, or never ran the process, must not be able to pass.
import fs from 'node:fs';
let input = ''; for await (const c of process.stdin) input += c;
const args = JSON.parse(input || '{}');
const site = args.site;

const probe = async (fn) => { try { await fn(); return 'allowed'; } catch { return 'blocked'; } };

const out = {
  readGranted:   await probe(() => fs.readFileSync(`${site}/plans/seed.md`, 'utf8')),   // control: must be allowed
  writeCache:    await probe(() => fs.writeFileSync(`${site}/cache/probe.txt`, 'x')),   // control: must be allowed
  readState:     await probe(() => fs.readFileSync(`${site}/state/gatherlight.db`)),    // must be blocked
  writeRecords:  await probe(() => fs.writeFileSync(`${site}/plans/evil.md`, 'x')),     // must be blocked
  spawn:         await probe(async () => { const cp = await import('node:child_process');
                                           const r = cp.spawnSync(process.execPath, ['-e', '1']);
                                           if (r.error) throw r.error; }),              // must be blocked
  worker:        await probe(async () => { const w = await import('node:worker_threads');
                                           new w.Worker('', { eval: true }); }),        // must be blocked
  // Network probes deliberately make NO round trip. "Can I obtain the capability to reach the
  // network" is the question; whether a socket then connects depends on the machine, and a suite
  // that needs the internet is a suite that fails for the wrong reason.
  fetchAvailable: typeof globalThis.fetch === 'function',                               // false unless net granted
  netModule:     await probe(async () => { await import('node:net'); }),                // must be blocked
  netBare:       await probe(async () => { await import('net'); }),                     // must be blocked
  httpModule:    await probe(async () => { await import('node:http'); }),               // must be blocked
};
process.stdout.write(JSON.stringify(out));
```

`fixtures/cap-escape/tool.json`:

```json
{
  "name": "cap_escape",
  "description": "e2e fixture: attempts to escape the capability sandbox",
  "command": { "exe": "node", "args": ["escape.mjs"] },
  "inputSchema": { "type": "object", "properties": { "site": { "type": "string" } }, "required": ["site"] }
}
```

- [ ] **Step 2: The suite**

`p38.mjs` must cover, each as a separate `ok(...)`:

1. **Not enabled = not registered.** Copy the fixture into `{data}/tools/cap_escape/` with `capabilities.enabled` empty; assert `cap_escape` is absent from `/api/tools` and a call returns 4xx.
2. **Enabled = registered.** Add `{"id":"cap_escape","fs":{"read":["plans"],"write":["cache"]},"net":false}` to `enabled`, restart, assert it appears.
3. **The battery.** Call it with `{site: <abs data dir>}` and assert **each** field of the returned JSON: `readGranted` and `writeCache` are `allowed`; `readState`, `writeRecords`, `spawn`, `worker`, `netModule`, `netBare`, `httpModule` are all `blocked`; and `fetchAvailable` is `false`.
4. **The net grant is real.** Flip the grant to `"net": true`, restart, call again, and assert `fetchAvailable` is now `true` and `netModule` reports `allowed`. This is the control that proves the denial comes from the preload doing its job rather than from probes that always fail — without it, a launcher that simply broke every import would pass the whole battery.
5. **Deny beats enabled.** Add `cap_escape` to `deny` while leaving it in `enabled`; assert it disappears again.
6. **Platform tools unaffected.** `pdf_inspect` remains present throughout — provenance means shipped tools need no enabling.

Use a free port (check the other suites; 5466/5467 are likely free).

- [ ] **Step 3: Run it**

```bash
node devtools/dev.mjs e2e p38
```
Expected: `e2e-p38 PASS`.

**If a `blocked` assertion fails, the sandbox does not hold — STOP and report BLOCKED.** Do not weaken the assertion. A softened escape test is worse than none, because S2b will print its promises to a household.

- [ ] **Step 4: Commit**

```bash
git add devtools/scripts/e2e/p38.mjs devtools/scripts/e2e/fixtures
git commit -m "test(e2e): p38 — capability enforcement + a real sandbox-escape battery

Every denial is a genuine attempt paired with a positive control, so a launcher
that denies everything or never spawns cannot pass. Covers not-enabled, enabled,
deny-beats-enabled, the fs/spawn/worker/network escapes, and a net:true grant
proving the network denial is the preload rather than an always-failing probe.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Close out

**Files:**
- Modify: `.claude/rules/dev-conventions.md`
- Modify: `docs/superpowers/specs/2026-08-05-capability-model-design.md` (status line + the two corrections)

- [ ] **Step 1: Correct the spec's two measured inaccuracies**

The spec says `child_process` is "denied outright". Measurement showed the **import succeeds** and only the operations throw. Reword to: "`child_process` operations (`spawn`/`exec`) throw `ERR_ACCESS_DENIED`; the module still imports, so the preload must not rely on import failing."

Also add to the sandbox section: "On Windows `--import` must be a `file://` URL; a bare drive-letter path throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`."

Change the status line to `Status: S2a implemented — see docs/superpowers/plans/2026-08-05-capability-model-sandbox.md; S2b (drafts, approval cards, escalation) not yet started.`

- [ ] **Step 2: Document the convention**

Add to `.claude/rules/dev-conventions.md` under the backend section:

```markdown
- **Capabilities carry provenance.** `Platform` (compiled, shipped by us) is available by default and
  runs in-process; `Script` and `Mcp` are off until `site.json` lists them in `capabilities.enabled`;
  `Draft` is never loaded. Non-platform capabilities run under `node --permission` with filesystem
  scope from their grant plus `cap-guard.mjs`, the platform preload that removes the network. That
  network denial holds ONLY because `--permission` already denies `child_process` spawn,
  `worker_threads` and `process.binding` — relaxing any of those silently breaks it. The launcher
  **fails closed**: if no node runtime supports `--permission` + `module.registerHooks`, a Script
  capability refuses to run rather than running unsandboxed. Proof lives in `e2e-p38`, whose denials
  are real attempts paired with positive controls.
```

- [ ] **Step 3: Full verification**

```bash
node devtools/dev.mjs check-layering
node devtools/scripts/check-sensitive.mjs --tree
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
```
All green; server at 0 warnings; Host with only its known MSB3277.

**Do not run the full e2e suite from a subagent** — a backgrounded suite is orphaned when the agent's turn ends. The coordinator runs `node devtools/dev.mjs e2e all` as the final gate, expecting `38/38`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: S2a delivered — capability provenance, enforcement + sandbox

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Deferred to S2b — do not build here

- Drafts under `.claude/tool-drafts/`, and promoting one to an enabled capability.
- The approval card and the escalation card, their SSE event channel, and the chat-ownership boundary.
- Typed fenced blocks (`table`, `chart`) in agent output.
- Any database schema change. S2a needs none; if S2b wants tables for escalation records, that is its plan's decision — and the whole-install export/import path is available to carry data across a schema change.
