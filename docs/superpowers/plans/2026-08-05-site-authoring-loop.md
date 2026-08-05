# S3b — the site authoring loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent write and update the site's own pages, reviewed by looking at the rendered page rather than at a JSON diff.

**Architecture:** `ui/` joins the scope guard's write set, restricted to top-level `.json` — so a path the agent may write there is exactly a page. A page file gains `nav`, and writing it publishes it. At the diff gate the server attaches a validated tree plus a deterministic change summary per page file, the client renders it with the same `UiTree` the live page uses, and an invalid page blocks the commit. A `Button` may name an approved capability; the click confirms against the enforced grant before anything runs.

**Tech Stack:** ASP.NET Core net10.0 (`Gatherlight.Platform`), React 18 + Vite, node e2e suites.

**Spec:** `docs/superpowers/specs/2026-08-05-site-authoring-loop-design.md`

---

## Before you start

Read these — the work depends on how they already behave:

- `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatEnvironmentService.cs` — `RenderScopeGuard` (builds `WRITE_DIRS` from the manifest's records plus `.claude`), the `ScopeGuardMjs` const with `GUARD_VERSION: 6`, and `UiSpecMd` with `UI_CONTRACT_VERSION: 1`.
- `guard/system-scope-guard.mjs` — `GUARD_VERSION: 4`, `WRITE_DIRS = ['']`, the same `underAny` helper. **Identical logic, different scope**; `e2e-p24` runs both and extracts the planner guard live from the C# const.
- `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatSessionService.cs` — `PresentDiffAsync` (builds `ReviewPayload`) and `ApproveDiffAsync` (already refuses to commit a failed build — the pattern the invalid-page refusal copies).
- `src/client/src/ui/organisms/ChatReview.tsx` — `DiffReview`, its content / `.claude` grouping, and `canApprove`.
- `src/server/Gatherlight.Platform/Agent/Ui/Services/SitePageStore.cs` — `ValidName` (bare stem, no separators) and the top-level-only `List()`. **This is why `ui/` is flat.**

**The invariant this sub-project buys:** a path the agent may write under `ui/` is a page. The guard's rule and the store's rule are deliberately identical, so there is no way to write a file there that never appears.

**Conventions:** everything server-side is Platform (`check-layering` must stay clean); client primitives come from `@/ui/atoms`, never `antd`; sources are BOM-less UTF-8.

```bash
cd D:/Development/Games/Gatherlight
git checkout -b feat/s3b-site-authoring
```

Per-task commits. Do not push. Do not run `e2e all` from a subagent.

---

## File structure

**Server**

| File | Responsibility |
|---|---|
| `Agent/Chat/Services/ChatEnvironmentService.cs` | `WRITE_DIRS` gains `ui.spec`; new `WRITE_EXTS`; `GUARD_VERSION` → 7; `UI_CONTRACT_VERSION` → 2 with a Pages section |
| `guard/system-scope-guard.mjs` | the same `WRITE_EXTS` rule, empty; `GUARD_VERSION` → 5 |
| `Agent/Ui/Models/SitePage.cs` | `nav` on the page file; `SitePageSummary` gains label/order/hidden; `PageDiffView` |
| `Agent/Ui/Services/SitePageStore.cs` | ordering, `hidden`, label fallback |
| `Agent/Ui/Services/PageDiffSummary.cs` (new) | deterministic before/after tree comparison |
| `Agent/Ui/Services/PageReviewService.cs` (new) | turns a diffed path into a `PageDiffView` |
| `Agent/Ui/UiController.cs` | `GET /api/ui/capability/{id}` for the button confirmation |
| `Agent/Ui/Schemas/InteractiveSchemas.cs` · `Services/UiActionValidator.cs` | the `runCapability` verb |
| `Agent/Chat/Services/ChatSessionService.cs` | attach page views to the review; refuse approval when one is invalid |
| `Agent/Llm/Services/PromptHarness.cs` | the execute prompt names the pages capability |

**Client**

| File | Responsibility |
|---|---|
| `ui/organisms/ChatReview.tsx` | the page group: preview, summary, collapsed diff, invalid-page block |
| `ui/organisms/Sidebar.tsx` | the Pages section |
| `ui/blocks/interactive.tsx` | `runCapability` — confirm, run, render the result |
| `lib/chatTypes.ts` | `PageDiffView` |

**Tests:** `devtools/scripts/e2e/p42.mjs` (new — the number is free; suites are p1–p41 and p43).

---

### Task 1: `ui/` in the write scope

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatEnvironmentService.cs`
- Modify: `guard/system-scope-guard.mjs`
- Create: `devtools/scripts/e2e/p42.mjs`

- [ ] **Step 1: Add the extension rule to the planner guard**

In the `ScopeGuardMjs` const, beside `WRITE_DIRS`:

```javascript
        const WRITE_DIRS = __WRITE_DIRS__;
        // Dirs whose file TYPE is restricted. ui/ holds the site's pages: a path the agent may write
        // there must be exactly a page, so nothing else can end up in the directory the app renders.
        // Flat by rule too — SitePageStore lists the top level only and a page name is a bare stem,
        // so a file in a subdirectory would be writable and permanently invisible.
        const WRITE_EXTS = __WRITE_EXTS__;
```

and in the write check, immediately after the `WRITE_DIRS` test and before `PROTECTED`:

```javascript
          if (!underAny(rel, WRITE_DIRS))
            deny(`Blocked: the agent may only edit ${WRITE_DIRS.join(', ')} — not "${rel}".`);
          for (const [dir, exts] of Object.entries(WRITE_EXTS)) {
            if (rel !== dir && !rel.startsWith(dir + '/')) continue;
            const rest = rel.slice(dir.length + 1);
            if (rest.includes('/'))
              deny(`Blocked: ${dir}/ is flat — put "${rel}" directly in ${dir}/.`);
            if (!exts.some((e) => rest.toLowerCase().endsWith(e)))
              deny(`Blocked: only ${exts.join('/')} files may be written under ${dir}/ — not "${rel}".`);
          }
          if (underAny(rel, PROTECTED))
```

Bump the version comment to `GUARD_VERSION: 7`.

- [ ] **Step 2: Render both substitutions**

In `RenderScopeGuard`:

```csharp
    private string RenderScopeGuard()
    {
        var uiDir = _manifest.Current.Ui.Spec.Trim('/');
        var dirs = _manifest.Current.Records.Concat([".claude", uiDir]).Where(d => d.Length > 0).Distinct();
        var literal = "[" + string.Join(", ", dirs.Select(d => $"'{d.Replace("'", "\\'")}'")) + "]";
        var deniedLiteral = "[" + string.Join(", ", _manifest.Current.Capabilities.Deny.Select(d => $"'{d.Replace("'", "\\'")}'")) + "]";
        // The UI directory holds pages and nothing else. Rendered from the manifest like WRITE_DIRS,
        // so a site that relocates its UI directory stays jailed correctly.
        var extsLiteral = uiDir.Length == 0 ? "{}" : $"{{ '{uiDir.Replace("'", "\\'")}': ['.json'] }}";
        return ScopeGuardMjs
            .Replace("__WRITE_DIRS__", literal)
            .Replace("__DENIED_TOOLS__", deniedLiteral)
            .Replace("__WRITE_EXTS__", extsLiteral);
    }
```

- [ ] **Step 3: Mirror it in the system guard**

`guard/system-scope-guard.mjs` is a tracked file, not generated. Add the same constant and the same
check, with an empty map, and bump its `GUARD_VERSION` to 5:

```javascript
const WRITE_DIRS = [''];  // '' = the whole jail (repo); writes are gated by PROTECTED below
const WRITE_EXTS = {};    // 系统模式 restricts no directory by file type — kept so both guards stay one logic
```

The two guards must stay identical apart from `WRITE_DIRS` / `WRITE_EXTS` / `PROTECTED` — `e2e-p24`
compares their logic.

- [ ] **Step 4: Write the failing e2e**

Create `devtools/scripts/e2e/p42.mjs`. Drive the guard directly the way `p24` does — read how it
extracts the planner guard from the C# const and invokes the hook, and follow that shape rather than
inventing a new harness:

```javascript
#!/usr/bin/env node
// e2e P42 — the site authoring loop (S3b). The agent may write pages and only pages; a page change
// is reviewed as a RENDERED page; an invalid page cannot be committed. Every denial here sits beside
// a positive control, the discipline p38/p39/p41 established.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p42');
const { ok, fail, done } = makeReporter('p42');
makeTestData(dataDir);

// Free port — suites use up to 5484 (p43); this one is clear.
const PORT = 5486;

let server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
const base = server.base ?? `http://127.0.0.1:${PORT}`;
const { j, post } = makeClient(base);

// Ask the generated scope guard whether a write would be allowed. Mirrors p24's invocation: run the
// hook with a PreToolUse payload on stdin and read its decision.
const guardPath = path.join(dataDir, '.claude', 'hooks', 'scope-guard.mjs');
const wouldAllow = (relPath) => {
  const { spawnSync } = require('node:child_process');
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(dataDir, relPath) },
  });
  const r = spawnSync('node', [guardPath], { input: payload, encoding: 'utf8', cwd: dataDir });
  return { allowed: r.status === 0 && !/Blocked/.test(r.stdout + r.stderr), out: r.stdout + r.stderr };
};

try {
  await waitHealthy(base);

  ok('the guard was issued into the data folder', fs.existsSync(guardPath));
  const guardBody = fs.readFileSync(guardPath, 'utf8');
  ok('the guard carries the bumped version', /GUARD_VERSION:\s*7/.test(guardBody));
  ok('ui/ is in the write dirs', /WRITE_DIRS = \[[^\]]*'ui'/.test(guardBody), guardBody.match(/WRITE_DIRS = .*/)?.[0] ?? '');

  // POSITIVE CONTROL first — if this fails, every denial below is meaningless.
  ok('a page file is writable', wouldAllow('ui/tokyo.json').allowed, wouldAllow('ui/tokyo.json').out);
  const md = wouldAllow('ui/notes.md');
  ok('a .md under ui/ is denied', !md.allowed);
  ok('the denial names the extension rule', /\.json/.test(md.out), md.out.slice(0, 160));
  const mjs = wouldAllow('ui/hack.mjs');
  ok('a .mjs under ui/ is denied', !mjs.allowed, mjs.out.slice(0, 160));
  const deep = wouldAllow('ui/sub/deep.json');
  ok('a page in a subdirectory is denied — ui/ is flat', !deep.allowed);
  ok('the flat denial says so', /flat/.test(deep.out), deep.out.slice(0, 160));
  // The other write dirs are untouched by the new rule.
  ok('plans/ is still writable', wouldAllow('plans/trips/x.md').allowed);
  ok('state/ is still denied', !wouldAllow('state/gatherlight.db').allowed);
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  server.stop();
}

done();
```

`require` is not available in an ESM suite — import `spawnSync` at the top with the other imports
instead, and delete the inline `require` line.

- [ ] **Step 5: Run it and watch it fail**

```bash
node devtools/dev.mjs e2e p42
```
Expected: **FAIL** — `ui/` is not in the write dirs yet.

- [ ] **Step 6: Build, re-issue, pass**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p42
node devtools/dev.mjs e2e p24
```

`p42` passes; **`p24` must also pass** — it runs both guards and extracts the planner one live from
the C# const, so it is the suite most likely to break here.

- [ ] **Step 7: Commit**

```bash
git add src/server/Gatherlight.Platform guard/system-scope-guard.mjs devtools/scripts/e2e/p42.mjs
git commit -m "feat(ui): the agent may write pages, and only pages

ui/ joins the write scope with a file-type rule and a flat rule, both rendered
from the manifest. SitePageStore lists the top level only and a page name is a
bare stem, so without the flat rule the agent could write a file that is
permanently invisible. A path it may write under ui/ is now exactly a page.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Navigation

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Ui/Models/SitePage.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Ui/Services/SitePageStore.cs`
- Modify: `devtools/scripts/e2e/p42.mjs`

- [ ] **Step 1: The nav shape**

In `SitePage.cs`:

```csharp
/// <summary>Optional navigation hints a page carries about itself. Writing the file publishes it —
/// there is no separate list to keep in sync, so a page cannot exist and be invisible.</summary>
public sealed record SitePageNav(string? Label = null, int? Order = null, bool Hidden = false);
```

Add `SitePageNav? Nav` to `SitePageFile`, and change `SitePageSummary`:

```csharp
public sealed record SitePageSummary(string Name, string Title, string Label, int Order, bool Hidden);
```

- [ ] **Step 2: Order and label in the store**

In `SitePageStore.List()`, parse `nav` alongside the title and return ordered summaries:

```csharp
            var nav = parsed?.Nav;
            pages.Add(new SitePageSummary(
                name, title,
                Label: string.IsNullOrWhiteSpace(nav?.Label) ? title : nav!.Label!,
                Order: nav?.Order ?? 1000,
                Hidden: nav?.Hidden ?? false));
        }
        // Declared order first, then name — a page with no order sorts after the ordered ones
        // rather than jumping to the front.
        return pages.OrderBy(p => p.Order).ThenBy(p => p.Name, StringComparer.Ordinal).ToList();
```

A malformed page keeps its file-name title (the existing `catch (JsonException)` path) and defaults
to `Order: 1000`, `Hidden: false` — it still appears, marked, rather than vanishing.

- [ ] **Step 3: Add the nav rows to p42**

```javascript
  // --- navigation ---------------------------------------------------------------------------
  const uiDir = path.join(dataDir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  const page = (name, body) => fs.writeFileSync(path.join(uiDir, `${name}.json`), JSON.stringify(body, null, 2), 'utf8');
  const leaf = (text) => ({ type: 'Text', text });

  page('zzz-ordered', { title: 'Ordered page', nav: { label: '第一', order: 1 }, root: leaf('a') });
  page('aaa-plain', { title: 'Plain page', root: leaf('b') });
  page('secret', { title: 'Hidden page', nav: { hidden: true }, root: leaf('c') });

  const pages = (await j('/api/ui/pages')).body ?? [];
  const named = (n) => pages.find((p) => p.name === n);
  ok('a page with nav.order sorts first despite its name',
    pages.filter((p) => !p.hidden)[0]?.name === 'zzz-ordered', pages.map((p) => p.name).join(','));
  ok('nav.label wins over the title', named('zzz-ordered')?.label === '第一', named('zzz-ordered')?.label ?? '');
  ok('a page with no nav falls back to its title', named('aaa-plain')?.label === 'Plain page');
  ok('a hidden page is marked hidden', named('secret')?.hidden === true);
  ok('a hidden page is still fetchable by name',
    (await j('/api/ui/pages/secret')).body?.status === 'ready');
```

- [ ] **Step 4: Build and run**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p42
node devtools/dev.mjs e2e p41
```

`p41` asserts the seeded `welcome` page and the page routes — the summary shape just changed under
it, so run it.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Platform devtools/scripts/e2e/p42.mjs
git commit -m "feat(ui): pages carry their own navigation

Writing the file publishes it — the rejected alternative, a list in site.json,
makes a page that exists on disk, renders at its URL, and appears nowhere.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The page preview at the diff gate (server)

**Files:**
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Services/PageDiffSummary.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Ui/Services/PageReviewService.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Ui/Models/SitePage.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatSessionService.cs`
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`
- Modify: `devtools/scripts/e2e/p42.mjs`

- [ ] **Step 1: The view shape**

In `SitePage.cs`:

```csharp
/// <summary>What the diff gate shows for one changed page. <c>Summary</c> is computed from the two
/// trees in code — a summary the AGENT wrote would be the agent describing its own change at an
/// approval surface, which is exactly what S2 established must not be trusted.</summary>
public sealed record PageDiffView(
    string Path, string Name, string Title, string Status, UiNode? Root, string? Reason, string Summary);
```

- [ ] **Step 2: The deterministic summary**

`Services/PageDiffSummary.cs`:

```csharp
using Gatherlight.Server.Platform.Agent.Ui.Models;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>
/// Plain-language account of what changed between two page trees, counted by component type. No LLM:
/// the household is being asked to approve a change, and the description of that change must come
/// from the change itself.
/// </summary>
public static class PageDiffSummary
{
    public static string Describe(UiNode? before, UiNode? after)
    {
        if (after is null) return "这个页面将被删除。";
        if (before is null) return $"新页面,包含 {Count(after)} 个组件。";

        var b = Tally(before);
        var a = Tally(after);
        var added = new List<string>();
        var removed = new List<string>();
        foreach (var type in a.Keys.Union(b.Keys).OrderBy(t => t, StringComparer.Ordinal))
        {
            var delta = a.GetValueOrDefault(type) - b.GetValueOrDefault(type);
            if (delta > 0) added.Add($"{delta} 个 {type}");
            else if (delta < 0) removed.Add($"{-delta} 个 {type}");
        }

        var parts = new List<string>();
        if (added.Count > 0) parts.Add("新增 " + string.Join("、", added));
        if (removed.Count > 0) parts.Add("移除 " + string.Join("、", removed));
        // Same components, different content — a text edit. Say so rather than "no change", which
        // would be false and would make the gate look broken.
        return parts.Count == 0 ? "组件结构未变,内容有改动。" : string.Join(";", parts) + "。";
    }

    private static int Count(UiNode n) => 1 + n.Children.Sum(Count);

    private static Dictionary<string, int> Tally(UiNode root)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        void Walk(UiNode n)
        {
            counts[n.Type] = counts.GetValueOrDefault(n.Type) + 1;
            foreach (var c in n.Children) Walk(c);
        }
        Walk(root);
        return counts;
    }
}
```

- [ ] **Step 3: Turn a diffed path into a view**

`Services/PageReviewService.cs`:

```csharp
using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>Builds the diff gate's page previews. Reads the WORKING TREE — at review time that
/// already holds the agent's edits and not yet a commit, so what is validated and rendered is
/// exactly what approval would commit.</summary>
public interface IPageReviewService
{
    bool IsPagePath(string relPath);
    PageDiffView Review(string relPath, string? beforeJson);
}

public sealed class PageReviewService : IPageReviewService
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly ISiteContext _site;
    private readonly ISiteManifestStore _manifest;
    private readonly IUiTreeValidator _validator;

    public PageReviewService(ISiteContext site, ISiteManifestStore manifest, IUiTreeValidator validator)
    {
        _site = site;
        _manifest = manifest;
        _validator = validator;
    }

    private string UiDir => _manifest.Current.Ui.Spec.Trim('/');

    public bool IsPagePath(string relPath)
    {
        var rel = relPath.Replace('\\', '/');
        var dir = UiDir;
        return dir.Length > 0
            && rel.StartsWith(dir + "/", StringComparison.Ordinal)
            && rel.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
            && !rel[(dir.Length + 1)..].Contains('/');
    }

    public PageDiffView Review(string relPath, string? beforeJson)
    {
        var rel = relPath.Replace('\\', '/');
        var name = Path.GetFileNameWithoutExtension(rel);
        var abs = _site.ResolveSitePath(rel);

        if (abs is null || !File.Exists(abs))
            return new PageDiffView(rel, name, name, "deleted", null, null, PageDiffSummary.Describe(Parse(beforeJson), null));

        SitePageFile? parsed;
        try { parsed = JsonSerializer.Deserialize<SitePageFile>(File.ReadAllText(abs), Json); }
        catch (JsonException ex)
        {
            return new PageDiffView(rel, name, name, "invalid", null, $"not valid JSON: {ex.Message}", "");
        }
        if (parsed is null)
            return new PageDiffView(rel, name, name, "invalid", null, "page file is empty", "");

        var result = _validator.ValidateElement(parsed.Root);
        var title = string.IsNullOrWhiteSpace(parsed.Title) ? name : parsed.Title;
        return result.Ok
            ? new PageDiffView(rel, name, title, "ready", result.Node, null,
                PageDiffSummary.Describe(Parse(beforeJson), result.Node))
            : new PageDiffView(rel, name, title, "invalid", null, result.Reason, "");
    }

    // The pre-change tree, when git gave us one. A previous version that no longer validates is not
    // an error here — it just means there is nothing to compare against.
    private UiNode? Parse(string? beforeJson)
    {
        if (string.IsNullOrWhiteSpace(beforeJson)) return null;
        try
        {
            var file = JsonSerializer.Deserialize<SitePageFile>(beforeJson, Json);
            return file is null ? null : _validator.ValidateElement(file.Root).Node;
        }
        catch (JsonException) { return null; }
    }
}
```

Register it in `GatherlightApp.cs` beside the other UI registrations:

```csharp
            .AddSingleton<IPageReviewService, PageReviewService>()
```

- [ ] **Step 4: Attach the views and refuse an invalid page**

In `ChatSessionService.cs`, extend the payload record:

```csharp
public sealed record ReviewPayload(List<DiffFile> Files, bool HasClaudeInfra, ClaudeValidation? Validation,
    BuildResult? Build = null, List<PageDiffView>? Pages = null);
```

Adding a field to `ReviewPayload` rather than to `DiffFile` is deliberate: `DiffFile` is git's shape
and three other modules consume it (`JobHandlers`, `UnattendedRunService`, `ZhikuMigrator`).

In `PresentDiffAsync`, just before constructing the payload:

```csharp
        // Page previews: the gate reviews a page by rendering it, so a non-technical household can
        // judge what they are approving. Only for the data workspace — 系统模式 edits code, not pages.
        List<PageDiffView>? pages = null;
        if (!IsSystem(s))
        {
            var pageFiles = files.Where(f => _pageReview.IsPagePath(f.Path)).ToList();
            if (pageFiles.Count > 0)
                pages = pageFiles.Select(f => _pageReview.Review(f.Path, PreviousVersion(git, f))).ToList();
        }

        s.Review = new ReviewPayload(files, claudeFiles.Count > 0, validation, build, pages);
```

`GitCliService` has **no** show-a-file-at-a-revision method today (verified), so add one. It already
exposes `Task<GitResult> RunAsync(string[] args, CancellationToken)` returning
`(ExitCode, Stdout, Stderr)` — build on that rather than a new process helper:

```csharp
    /// <summary>Contents of one path at a revision, or null when it does not exist there (a new
    /// file). Never throws on a missing path: "not in HEAD" is an ordinary answer, not an error.</summary>
    public async Task<string?> ShowAsync(string revPath, CancellationToken ct = default)
    {
        var r = await RunAsync(new[] { "show", revPath }, ct);
        return r.ExitCode == 0 ? r.Stdout : null;
    }
```

Add it to `IGitCliService` too. Then the caller, awaited rather than blocked on:

```csharp
        // The committed version — what approval would replace. Null for a page being created.
        var pages = new List<PageDiffView>();
        foreach (var f in pageFiles)
            pages.Add(_pageReview.Review(f.Path, await git.ShowAsync($"HEAD:{f.Path}")));
```

and drop the `pages = pageFiles.Select(...)` line above in favour of this loop.

In `ApproveDiffAsync`, beside the existing build refusal:

```csharp
        // A page that would not render cannot be committed — the same rule as a failed build. The
        // thing being approved has already been through the validator, so this is enforcement, not
        // advice.
        if (s.Review?.Pages?.FirstOrDefault(p => p.Status == "invalid") is { } bad)
        {
            Emit(s, new AgentEvent
            {
                Kind = "error",
                Text = $"页面 {bad.Path} 无法显示({bad.Reason}),不能提交。请让 AI 修正后再试。",
            });
            return;
        }
```

- [ ] **Step 5: Add the gate rows to p42**

The stub needs a case that writes a page during the execute phase. Add to
`devtools/scripts/claude-stub.mjs`, beside the other trigger checks and **after** the `SCORING TASK`
branch:

```javascript
// S3b: write a page during the execute phase. `readOnly` is false only on the execute run, so the
// plan turn returns a plan and the execute turn does the write — matching the real two-gate flow.
const pageCase = (current.match(/PAGE_CASE:([A-Z_]+)/) || [])[1];
if (pageCase) {
  if (readOnly) { done(`计划:写一个页面 (${pageCase})`); process.exit(0); }
  const bodies = {
    GOOD: { title: '行程面板', nav: { label: '行程', order: 1 }, root: {
      type: 'Stack', children: [
        { type: 'Heading', text: '东京', level: 2 },
        { type: 'Table', columns: ['项目', '金额'], rows: [['机票', '82000']] },
      ] } },
    BAD: { title: '坏页面', root: { type: 'Gantt', text: 'nope' } },
  };
  fs.mkdirSync('ui', { recursive: true });
  fs.writeFileSync(`ui/${pageCase.toLowerCase()}.json`, JSON.stringify(bodies[pageCase], null, 2), 'utf8');
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write',
    input: { file_path: `ui/${pageCase.toLowerCase()}.json` } }] } });
  done(`已写入 ui/${pageCase.toLowerCase()}.json`);
  process.exit(0);
}
```

Match the stub's existing `tool_use` emission shape — read how the file-writing branch near the
bottom of the stub emits its `Edit` tool call and copy that exactly, or the server's `EditTracker`
will not record the write and the diff will be empty.

Then in p42:

```javascript
  // --- the preview gate ---------------------------------------------------------------------
  const runToGate = async (message) => {
    const started = await post('/api/chat', { message, mode: 'plan' });
    const id = started.body?.id;
    await until(async () => (await j(`/api/chat/${id}`)).body?.phase === 'awaiting-plan-approval', 60000);
    await post(`/api/chat/${id}/plan/approve`);
    await until(async () => {
      const p = (await j(`/api/chat/${id}`)).body?.phase;
      return p === 'awaiting-diff-approval' || p === 'error' || p === 'rejected';
    }, 60000);
    return id;
  };

  const goodId = await runToGate('PAGE_CASE:GOOD 给行程做个面板');
  const goodReview = (await j(`/api/chat/${goodId}`)).body?.review;
  const goodPage = (goodReview?.pages ?? [])[0];
  ok('a page change carries a page preview', Boolean(goodPage), JSON.stringify(goodReview?.pages ?? null));
  ok('the preview is ready', goodPage?.status === 'ready', goodPage?.reason ?? '');
  ok('the preview carries the validated tree', goodPage?.root?.type === 'Stack');
  ok('the summary is computed, not empty', (goodPage?.summary ?? '').length > 0, goodPage?.summary ?? '');
  ok('a new page says so in the summary', /新页面/.test(goodPage?.summary ?? ''), goodPage?.summary ?? '');
  // POSITIVE CONTROL: a valid page COMMITS.
  await post(`/api/chat/${goodId}/diff/approve`);
  await until(async () => (await j(`/api/chat/${goodId}`)).body?.phase === 'committed', 60000);
  ok('a valid page commits', (await j(`/api/chat/${goodId}`)).body?.phase === 'committed');

  const badId = await runToGate('PAGE_CASE:BAD 再来一个');
  const badPage = ((await j(`/api/chat/${badId}`)).body?.review?.pages ?? [])[0];
  ok('an invalid page is marked invalid', badPage?.status === 'invalid', JSON.stringify(badPage ?? null));
  ok('the reason names the unknown component', /Gantt/.test(badPage?.reason ?? ''), badPage?.reason ?? '');
  await post(`/api/chat/${badId}/diff/approve`);
  const stillAtGate = (await j(`/api/chat/${badId}`)).body?.phase;
  ok('approving an invalid page is REFUSED', stillAtGate === 'awaiting-diff-approval', String(stillAtGate));
  await post(`/api/chat/${badId}/diff/reject`);
```

- [ ] **Step 6: Build and run**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p42
```
Expected: `e2e-p42 PASS`, including the refusal row.

- [ ] **Step 7: Commit**

```bash
git add src/server devtools/scripts devtools/scripts/e2e/p42.mjs
git commit -m "feat(ui): review a page change by rendering the page

The gate reads the working tree — what is validated and rendered is exactly what
approval would commit. The change summary is computed from the two trees, never
written by the agent: a summary the agent authored is the agent describing its
own change at an approval surface. An invalid page cannot be committed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The preview at the gate (client)

**Files:**
- Modify: `src/client/src/lib/chatTypes.ts`
- Modify: `src/client/src/ui/organisms/ChatReview.tsx`

- [ ] **Step 1: The type**

In `chatTypes.ts`:

```typescript
/**
 * One changed page at the diff gate. `root` is the validated tree — rendered with the SAME UiTree
 * the live page uses. `summary` is the server's computed account of what changed, never the agent's.
 */
export interface PageDiffView {
  path: string;
  name: string;
  title: string;
  status: 'ready' | 'invalid' | 'deleted';
  root?: UiNode;
  reason?: string;
  summary: string;
}
```

and add `pages?: PageDiffView[]` to `ReviewPayload`.

- [ ] **Step 2: The page group**

In `ChatReview.tsx`, add a component above `DiffReview`:

```tsx
/** A changed page, reviewed by looking at it. The raw diff stays one disclosure away — the render is
 *  the review, the diff is the appeal. */
function PageChange({ page, diff }: { page: PageDiffView; diff?: DiffFile }) {
  return (
    <div className="page-change">
      <div className="page-change-head">
        <Tag color={page.status === 'ready' ? 'blue' : page.status === 'deleted' ? 'default' : 'red'}>
          {page.status === 'ready' ? '页面' : page.status === 'deleted' ? '删除页面' : '无法显示'}
        </Tag>
        <span className="page-change-title">{page.title}</span>
        <code className="diff-file-path">{page.path}</code>
      </div>
      {page.summary && <div className="page-change-summary">{page.summary}</div>}
      {page.status === 'ready' && page.root && (
        <div className="page-change-preview"><UiTree node={page.root} /></div>
      )}
      {page.status === 'invalid' && (
        <Alert type="warning" showIcon message="这个页面无法显示,不能提交" description={page.reason} />
      )}
      {diff && (
        <Collapse
          ghost
          size="small"
          items={[{ key: 'd', label: '查看原始差异', children: <DiffBlock diff={diff.diff} /> }]}
        />
      )}
    </div>
  );
}
```

Import `UiTree` from `@/ui/blocks/UiTree` and `PageDiffView` from `@/lib/chatTypes`. **No `onSend` /
`onOpenRecord` is passed** — a preview's buttons are inert, which is correct: you are approving the
page, not operating it.

- [ ] **Step 3: Render the group and block approval**

In `DiffReview`, partition the files and add the term to `canApprove`:

```tsx
  const pages = review.pages ?? [];
  const pagePaths = new Set(pages.map((p) => p.path));
  const contentFiles = review.files.filter((f) => !f.isClaudeInfra && !pagePaths.has(f.path));
  const hasInvalidPage = pages.some((p) => p.status === 'invalid');
  const canApprove = !busy && (!needsAck || ackClaude) && !buildFailed && !hasInvalidPage;
```

Render the page group above the content group:

```tsx
      {pages.length > 0 && (
        <div className="diff-group">
          <div className="diff-group-title">页面改动 ({pages.length})</div>
          {pages.map((p) => (
            <PageChange key={p.path} page={p} diff={review.files.find((f) => f.path === p.path)} />
          ))}
        </div>
      )}
```

and, when `hasInvalidPage`, an `Alert` above the actions saying the commit is blocked and naming the
page — the button being disabled with no explanation is the failure to avoid.

- [ ] **Step 4: Style it**

Add to `src/client/src/styles.css`, using variables that file already defines (`--surface`,
`--surface-2`, `--border`, `--border-soft`, `--text-2`, `--muted`, `--radius-sm`):

```css
/* --- page previews at the diff gate --- */
.page-change { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; margin-bottom: 10px; background: var(--surface); }
.page-change-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.page-change-title { font-weight: 600; }
.page-change-summary { color: var(--text-2); font-size: 13px; margin-bottom: 8px; }
.page-change-preview { border: 1px dashed var(--border-soft); border-radius: var(--radius-sm); padding: 12px; background: var(--surface-2); margin-bottom: 8px; }
```

- [ ] **Step 5: Build and look at it**

```bash
node devtools/dev.mjs build
```

Then run the server against a scratch data folder under `devtools/_*` (**never `local/`**), drive
`PAGE_CASE:GOOD` and `PAGE_CASE:BAD` through the stub, and confirm:

1. The good page's gate shows the rendered page — heading and table — with a summary line, and the
   raw diff collapsed.
2. The bad page's gate shows the warning, and **批准并提交 is disabled** with an explanation.
3. Approving the good page commits.

Report each. Tear the server down and delete the scratch folder.

- [ ] **Step 6: Commit**

```bash
git add src/client/src
git commit -m "feat(ui): the diff gate renders the page it is asking about

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The Pages section in the sidebar

**Files:**
- Modify: `src/client/src/ui/organisms/Sidebar.tsx`
- Modify: `src/client/src/App.tsx`

- [ ] **Step 1: Load the pages**

In `App.tsx`, fetch `GET /api/ui/pages` on mount (and after a chat commit, where the plan index is
already refreshed — find that refresh and add this beside it, so a page the agent just created
appears without a reload). Keep them in state and pass to `Sidebar` as
`pages: SitePageSummary[]`, along with `activePage` and `onOpenPage`.

- [ ] **Step 2: Render the section**

`Sidebar.tsx` gains the props and renders a Pages block **above** the existing `side-pins side-foot`
group, reusing the `side-lib` button styling the two pinned surfaces already use so it reads as part
of the same rail rather than a new visual language:

```tsx
      {pages.filter((p) => !p.hidden).length > 0 && (
        <div className="side-pins side-pages">
          {pages.filter((p) => !p.hidden).map((p) => (
            <button
              key={p.name}
              className={`side-lib pin-page${activePage === p.name ? ' active' : ''}`}
              onClick={() => onOpenPage(p.name)}
              aria-current={activePage === p.name ? 'page' : undefined}
            >
              <LayoutOutlined className="side-lib-icon" />
              <span className="side-lib-text">
                <span className="side-lib-zh">{p.label}</span>
                <span className="side-lib-en">PAGE</span>
              </span>
            </button>
          ))}
        </div>
      )}
```

Import `LayoutOutlined` from `@ant-design/icons` (the file already imports icons from there).

- [ ] **Step 3: Build and look**

```bash
node devtools/dev.mjs build
```

Run the server against a scratch data folder, confirm the seeded `welcome` page appears in the rail
and opens, and that a `hidden: true` page does not appear but still opens via `?page=`.

- [ ] **Step 4: Commit**

```bash
git add src/client/src
git commit -m "feat(ui): pages appear in the sidebar

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Buttons that call approved capabilities

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Ui/Services/UiActionValidator.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Ui/UiController.cs`
- Modify: `src/client/src/ui/blocks/interactive.tsx`
- Modify: `devtools/scripts/e2e/p42.mjs`

- [ ] **Step 1: The verb**

In `UiActionValidator.Validate`, add to the switch:

```csharp
            // Validated by SHAPE, not by state: a page may legitimately name a capability enabled
            // later, and failing validation for that would make the page uncommittable for a reason
            // that has nothing to do with the page. Enablement is enforced at invocation by
            // ToolRegistry, which already refuses a NotEnabled capability with a 4xx.
            "runCapability" => System.Text.RegularExpressions.Regex.IsMatch(arg, @"^[a-z0-9_]{1,64}$")
                ? null
                : $"action 'runCapability' needs a capability id (lower-case, digits, underscore): {arg}",
```

- [ ] **Step 2: The confirmation data**

In `UiController.cs`:

```csharp
    /// <summary>What a runCapability button will actually do, for the confirmation the click shows.
    /// The clauses come from PermissionSentence over the ENFORCED grant — never from the page, whose
    /// label the agent chose.</summary>
    [HttpGet("capability/{id}")]
    public IActionResult Capability(string id)
    {
        var info = _capabilities.All().FirstOrDefault(c => c.Id == id);
        if (info is null) return NotFound(new { error = "unknown capability" });
        var grant = _capabilities.GrantFor(id);
        return Ok(new
        {
            id,
            state = info.State.ToString(),
            can = grant is null ? Array.Empty<string>() : PermissionSentence.Can(grant),
            cannot = grant is null ? Array.Empty<string>() : PermissionSentence.Cannot(grant),
        });
    }
```

Inject `ICapabilityRegistry _capabilities`. `CapabilityInfo` is
`(Id, Origin, Title, Description, InputSchema, State)` and `ICapabilityRegistry` exposes
`All()`, `Available()` and `GrantFor(id)` — verified, so use them as written.

- [ ] **Step 3: The client button**

In `src/client/src/ui/blocks/interactive.tsx`, extend `Button`: a `runCapability` action opens a
confirmation (fetch `/api/ui/capability/{id}`, show id + `can`/`cannot` clauses, Confirm / Cancel),
and on confirm POSTs `/api/tools/call` with `{ name: id, arguments: {} }`. Render the result below
the button: if it parses as a valid UI tree render it with `UiTree`, otherwise show it as
preformatted text. A 4xx (not enabled) renders its message rather than failing silently.

The clauses come from the server, never from the node — **do not** let the page supply any part of
the confirmation text.

- [ ] **Step 4: Add the rows to p42**

```javascript
  // --- runCapability --------------------------------------------------------------------------
  const actionPage = (action) => ({ title: 'act', root: { type: 'Button', label: '跑一下', action } });
  page('act-ok', actionPage({ runCapability: 'budget_scan' }));
  page('act-bad', actionPage({ runCapability: 'Not A Valid Id!' }));

  ok('a well-formed runCapability validates', (await j('/api/ui/pages/act-ok')).body?.status === 'ready');
  const badAct = (await j('/api/ui/pages/act-bad')).body;
  ok('a malformed capability id is refused', badAct?.status === 'invalid');
  ok('the reason names the verb', /runCapability/.test(badAct?.reason ?? ''), badAct?.reason ?? '');

  const cap = await j('/api/ui/capability/budget_scan');
  ok('the confirmation data comes from the server', cap.status === 200, String(cap.status));
  ok('it carries the enforced clauses', Array.isArray(cap.body?.can) && Array.isArray(cap.body?.cannot));
  ok('an unknown capability is 404', (await j('/api/ui/capability/nope_nope')).status === 404);
```

`budget_scan` is a real Platform tool — check its id with `curl /api/tools` and use whatever it
actually is rather than assuming.

- [ ] **Step 5: Build, run, look**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs build
node devtools/dev.mjs e2e p42
```

Then in a browser, open a page with a `runCapability` button and confirm the click shows the
platform confirmation **before** anything runs, and that cancelling runs nothing.

- [ ] **Step 6: Commit**

```bash
git add src/server src/client devtools/scripts/e2e/p42.mjs
git commit -m "feat(ui): a page button may call an approved capability

The JS lives in a sandboxed capability a human approved; the page only names it,
so no new code-execution path enters the browser. The click confirms against the
enforced grant, because a label the agent chose on a button that runs code is a
forgery surface.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Tell the agent, and close out

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatEnvironmentService.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Services/PromptHarness.cs`
- Modify: `.claude/rules/dev-conventions.md`
- Modify: `devtools/scripts/e2e/p42.mjs`

- [ ] **Step 1: The contract gains a Pages section**

In `UiSpecMd`, bump the header to `UI_CONTRACT_VERSION: 2` and replace the existing Pages paragraph
with:

````markdown
        ## 页面 · Pages

        You can also SAVE a tree as a page of this site. Write it to `ui/<name>.json`:

        ```json
        { "title": "Trip dashboard",
          "nav": { "label": "行程", "order": 1 },
          "root": { "type": "Stack", "children": [] } }
        ```

        - `ui/` is FLAT and holds only `.json` page files — no subdirectories, no other file types.
        - `<name>` is letters, digits, `-` and `_` only.
        - `nav` is optional: `label` (defaults to the title), `order` (lower sorts first),
          `hidden` (keeps it out of the menu but still reachable by link).
        - Writing the file publishes it. There is no separate list to update.
        - The person reviews your page by LOOKING at it, rendered, before it is committed. A page
          that fails validation cannot be committed at all — so use only the components above.

        A `Button` on a page can also run a capability you already had approved:
        `{ "label": "重算预算", "action": { "runCapability": "budget_scan" } }`. The app shows the
        person what that capability may do before it runs.
````

- [ ] **Step 2: The prompt names it**

In `PromptHarness`, in the `Common` block beside the existing `ui-spec.md` line, extend that bullet
so it covers pages — the agent must know pages exist or it will never write one:

```
        - You can render REAL UI in your replies, not just text: put a ```ui fenced block holding one component tree (JSON) anywhere in your message. You can also SAVE a tree as a page of this site by writing `ui/<name>.json` — the person reviews it as a rendered page before it is committed. The exact component list, props, limits and page file shape are in .claude/ui-spec.md — read it before your FIRST ```ui block or page in a session, and use only what it lists: a component it does not name renders as "content this app cannot display". There is no HTML and no script; if you cannot express something with those components, just say so in prose.
```

- [ ] **Step 3: Assert both**

Add to p42:

```javascript
  // --- the agent is told ----------------------------------------------------------------------
  const spec = fs.readFileSync(path.join(dataDir, '.claude', 'ui-spec.md'), 'utf8');
  ok('the contract is at version 2', /UI_CONTRACT_VERSION:\s*2/.test(spec));
  ok('the contract documents pages', /ui\/<name>\.json/.test(spec));
  ok('the contract says ui/ is flat', /FLAT/i.test(spec));
  ok('the contract documents runCapability', /runCapability/.test(spec));
```

and extend the stub's `CONTRACT_POINTER` case (added in S3a) to also report whether the prompt
mentions pages:

```javascript
    CONTRACT_POINTER: (prompt.includes('.claude/ui-spec.md') ? 'CONTRACT_POINTER_PRESENT' : 'CONTRACT_POINTER_MISSING')
      + ' ' + (/ui\/<name>\.json|SAVE a tree as a page/.test(prompt) ? 'PAGES_PRESENT' : 'PAGES_MISSING'),
```

with the matching row in p42 (p41 already asserts the first half):

```javascript
  const pointer = await blocksFor('CONTRACT_POINTER');   // reuse p41's helper shape
  ok('the prompt tells the agent it can write pages', /PAGES_PRESENT/.test(pointer.prose), pointer.prose.slice(0, 160));
```

If reusing p41's `blocksFor` is awkward, drive one plan turn and read its `plan` text instead — the
point is that the assertion exists and can fail, not which helper it uses. **Prove it by deleting
the prompt line and watching that row alone go red**, then restore.

- [ ] **Step 4: Document the convention**

Add to the UI bullet in `.claude/rules/dev-conventions.md`:

```markdown
  The agent authors pages too: `ui/` is in the scope guard's write set, restricted to flat `.json`
  by `WRITE_EXTS` so a path it may write there is exactly a page (the store lists the top level only
  — without the flat rule it could write a permanently invisible file). A page change is reviewed by
  RENDERING it at the diff gate from the working tree, with a change summary computed from the two
  trees rather than written by the agent, and an invalid page **cannot be committed**.
```

- [ ] **Step 5: Full verification**

```bash
node devtools/dev.mjs check-layering
node devtools/dev.mjs check-ui-registry
node devtools/scripts/check-sensitive.mjs --tree
dotnet build src/server/Gatherlight.Platform/Gatherlight.Platform.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Planner/Gatherlight.Planner.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
node devtools/dev.mjs build
node devtools/dev.mjs e2e p42
node devtools/dev.mjs e2e p41
node devtools/dev.mjs e2e p24
```

The coordinator runs `node devtools/dev.mjs e2e all`, expecting `43/43`.

- [ ] **Step 6: Commit**

```bash
git add src/server .claude/rules/dev-conventions.md devtools/scripts
git commit -m "feat(ui): tell the agent it can write pages

The contract and the prompt both name it, version-gated so existing data folders
get it. S3a's lesson: a capability the agent is not told about is unreachable,
and every check stays green while the feature does nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in scope

- **Composites (`defineComponent`)** and **data binding** — S3c.
- **Page deletion by the agent** — the guard denies `rm`; a page is retired by a human.
- **Tightening `img-src`** — the remote-image channel is a named residual whose fix is a CSP change
  plus a tile proxy.
