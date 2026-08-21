# Memory Recall — Per-Layer Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three bespoke model-picking surfaces in 记忆检索 and 校准 with one shape — each recall layer owns an interface, each backend that can serve a layer implements it, and 资源 owns every provisioned artifact (runtimes *and* models).

**Architecture:** One interface per layer (`IMemoryJudgeSource`, `IMemorySemanticSource`), implemented by per-backend classes held in a static catalog (`MemorySources`) shaped like `CortexConfigService.ModelCatalog`. `GatherlightApp` wires from that catalog at DI-registration time; the panel renders from the same list at runtime. A backend appears in a layer's toggle because a class implementing that layer's interface **exists and is listed** — never because a filter admitted it. Model provisioning (pull/remove/disk/progress/the measured comparison table) moves to `/api/manage/models`, rendered in 资源.

**Tech Stack:** ASP.NET Core (net10.0), Dapper/SQLite, Lyntai 3.0.2 (`Lyntai.Core`, `Lyntai.Providers.Default`, `Lyntai.Storage.Sqlite`), React + Vite, e2e suites in `devtools/scripts/e2e/`.

**Testing idiom — read this before Task 1.** This repo has **no C# unit-test project**. Every behavioural claim is proved by an e2e suite that self-hosts the server against an isolated `devtools/_e2e-*` data folder with a stubbed claude CLI. So "write the failing test" means "add the assertion to `devtools/scripts/e2e/p51.mjs`", and "run the test" means `node devtools/dev.mjs e2e p51`. A build alone is never proof.

**Two standing traps in this area** (both cost real time before):
1. Kill stray fixture servers before building — they hold a lock on `Gatherlight.Platform.dll`, so the build fails while `--no-build` silently keeps testing the stale binary.
2. Never stop and restart a fixture server on the **same port** inside one suite. Give each server its own port.

---

## File Structure

**Create**
| path | responsibility |
|---|---|
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/MemorySourceTypes.cs` | The shared value types every source speaks: `SourceStatus`, `ModelOption`, `MemorySourceContext`, `MemoryWiringContext`, `MemoryLayers` |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/IMemoryJudgeSource.cs` | 判断's interface |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/IMemorySemanticSource.cs` | 语义's interface |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/ClaudeCliJudgeSource.cs` | 判断 on the authenticated CLI |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/OllamaJudgeSource.cs` | 判断 on a local chat model |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/OllamaSemanticSource.cs` | 语义 on a local embedding model |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/MemorySources.cs` | The static catalog + binding resolution (incl. legacy `JudgeTransport`) |
| `src/server/Gatherlight.Platform/Hosting/Resources/ModelsController.cs` | `/api/manage/models` — list, pull, remove, start-runtime |
| `src/client/src/screens/Models.tsx` | The 本机模型 section rendered inside 资源 |

**Modify**
| path | change |
|---|---|
| `src/server/Gatherlight.Platform/Kernel/Services/ServerConfigService.cs:157-192` | `MemoryConfig` gains `JudgeSource` + `SemanticSource`; `JudgeTransport` becomes legacy-read-only |
| `src/server/Gatherlight.Server/GatherlightApp.cs:97-127,166-194,282-367` | Wire from `MemorySources` instead of the inline `judgeLocal` / `semanticOn` branches |
| `src/server/Gatherlight.Platform/Agent/Llm/MemoryRecallController.cs` | Layer rows; drop `/judge`, `/local/{pull,remove,start,enable,disable}`; add `/layer/{layer}` + `/layer/{layer}/off` |
| `src/server/Gatherlight.Platform/Ops/Cortex/Services/CortexConfigService.cs:46-59` | Drop the `memory` row; 记忆检索 owns that model now |
| `src/client/src/screens/MemoryRecall.tsx` | Layer rows with a source toggle + model select; 语义 under a 高级 divider |
| `src/client/src/screens/Manage.tsx:1173-1256` | `ResourcesView` mounts `ModelsSection` |
| `src/client/src/styles.css` | Layer-row + models-section rules |
| `devtools/scripts/e2e/p51.mjs` | Rewritten against the new endpoints, plus the new denials |
| `.claude/rules/dev-conventions.md` | Amend the "must appear in cortex's ModelCatalog" rule |
| `CLAUDE.md` | Current state |
| `docs/release-notes/next.md` | Append this pass |
| `TASKS.md` | Delete the resharpen backlog item when Task 9 lands |

**Delete:** nothing. `EmbeddingCatalog`, `OllamaRuntime`, `ModelPullStatus`, `ReindexStatus` all survive unchanged — they become what the sources are built *from*.

---

### Task 1: The source contracts and the catalog

Pure addition. Nothing calls it yet, so the only proof at this stage is that it compiles and the existing suite is untouched.

**Files:**
- Create: `src/server/Gatherlight.Platform/Agent/Llm/Sources/MemorySourceTypes.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Llm/Sources/IMemoryJudgeSource.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Llm/Sources/IMemorySemanticSource.cs`

- [ ] **Step 1: Write the shared types**

`MemorySourceTypes.cs`:

```csharp
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>The layer ids, in one place. They are stored in settings.json and appear in URLs, so a typo
/// would be a silently unbindable layer rather than a compile error.</summary>
public static class MemoryLayers
{
    public const string Judge = "judge";
    public const string Semantic = "semantic";
}

/// <summary>Whether a source can serve its layer on THIS machine right now, and the one sentence the
/// household reads when it cannot.
///
/// <para><paramref name="Suggest"/> is a model id the panel may offer to download when the fix IS a
/// download. It exists because the alternative — printing a shell command at a household sitting in front
/// of a panel that downloads models — draws a line the system does not have.</para>
///
/// <para>A source that is unavailable is still LISTED. Removing it would answer "why can't I pick this?"
/// by making the question unaskable, which is the dead-switch failure this whole surface exists to end.</para></summary>
public sealed record SourceStatus(bool Available, string? Reason = null, string? Suggest = null)
{
    public static readonly SourceStatus Ready = new(true);
}

/// <summary>One model a source can offer for its layer.
///
/// <para><paramref name="Installed"/> false means it is offerable but must be fetched first — 资源 owns
/// that. <paramref name="Measured"/> is null for anything nobody benchmarked, which the UI must SAY rather
/// than leave blank: an empty cell in a comparison table reads as a zero.</para></summary>
public sealed record ModelOption(
    string Id,
    string Name,
    bool Installed,
    long? SizeBytes = null,
    string? Note = null,
    Services.EmbeddingMeasurement? Measured = null,
    string? Vintage = null);

/// <summary>What a source needs to ANSWER questions at runtime. Passed per call rather than injected, so a
/// source can be a stateless instance in a static catalog — which is what lets the same list be used by
/// <c>GatherlightApp</c> before the container exists and by the panel after it.</summary>
public sealed record MemorySourceContext(
    IOllamaRuntime Ollama,
    IClaudeCliRuntime Claude,
    MemoryConfig Config);

/// <summary>What a source needs to REGISTER itself at startup. No DI, no container — only the two facts a
/// backend registration turns on.</summary>
/// <param name="Model">The bound model for this layer.</param>
/// <param name="OllamaUrl">Already resolved through <see cref="OllamaRuntime.ResolveBaseUrl"/>, so a source
/// never re-derives it — two answers for one endpoint is how an install embeds against one host and
/// reports another.</param>
public sealed record MemoryWiringContext(string Model, string OllamaUrl);
```

> Note the `using` for `IOllamaRuntime` / `IClaudeCliRuntime` / `EmbeddingMeasurement`: they live in
> `Gatherlight.Server.Platform.Agent.Llm.Services`, one namespace up. Add
> `using Gatherlight.Server.Platform.Agent.Llm.Services;` at the top and drop the `Services.` qualifier on
> `EmbeddingMeasurement` if the compiler prefers it — either compiles; be consistent across the folder.

- [ ] **Step 2: Write the judge interface**

`IMemoryJudgeSource.cs`:

```csharp
using Lyntai.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// A backend that can answer a memory JUDGEMENT — a subject label on every write, a verdict on which
/// candidates answered on every recall.
///
/// <para><b>Why one interface per layer rather than one model list with capability flags.</b> Claude ships
/// no embeddings endpoint and Ollama refuses a chat model an embedding call, so the two layers genuinely
/// have disjoint backend sets today. Expressing that as a capability STRING plus a filter would put the
/// rule in a predicate somebody can get wrong; expressing it as "there is no ClaudeCliSemanticSource class"
/// makes it a fact about which types exist. The day a backend can do both, it implements both interfaces
/// and appears in both toggles with no release of ours.</para>
/// </summary>
public interface IMemoryJudgeSource
{
    /// <summary>Stable id, stored in settings.json and sent by the panel: <c>claude-cli</c> · <c>ollama</c>.</summary>
    string Id { get; }

    /// <summary>What the toggle button says.</summary>
    string Name { get; }

    /// <summary>One line under the toggle: what choosing this costs and buys.</summary>
    string Description { get; }

    /// <summary>Can it serve the layer here and now — and if not, why, in a sentence with a fix in it.</summary>
    Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default);

    /// <summary>The models this source offers for this layer. Empty is a legitimate answer and must be
    /// paired with a <see cref="StatusAsync"/> reason — an empty picker with no sentence is the exact dead
    /// control this design replaces.</summary>
    Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default);

    /// <summary>Refuse a model that is installed, well-formed and unable to do the job. Both memory
    /// policies are FAIL-OPEN, so an accepted-but-incapable model surfaces as recall that quietly never
    /// improves — never as an error. Return null when it is fine, or the sentence explaining the refusal.</summary>
    Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default);

    /// <summary>The Lyntai client name the judge runs on, or null for the default client. A name selects
    /// BACKENDS, never permissions.</summary>
    string? ClientName { get; }

    /// <summary>Provider ids to append to the GLOBAL candidate list, after <c>claude-cli</c>. Required
    /// because <c>LlmRouterFactory.For()</c> narrows a named client's provider pool but reuses the same
    /// candidates — a client pooled over a provider absent from the global list matches nothing and every
    /// call fails silently. Empty for a source that adds no provider.</summary>
    IReadOnlyList<string> CandidateProviderIds { get; }

    /// <summary>Register whatever this source needs (a provider, a named client). A no-op for the CLI,
    /// which is already registered as the default.</summary>
    void Register(LyntaiBuilder b, MemoryWiringContext ctx);
}
```

- [ ] **Step 3: Write the semantic interface**

`IMemorySemanticSource.cs`:

```csharp
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// A backend that can turn a fact into a VECTOR, so a paraphrase finds it.
///
/// <para>There is deliberately no <c>ClaudeCliSemanticSource</c>: Anthropic ships no embeddings endpoint,
/// so one cannot exist. That absence IS the rule — see <see cref="IMemoryJudgeSource"/>.</para>
/// </summary>
public interface IMemorySemanticSource
{
    string Id { get; }
    string Name { get; }
    string Description { get; }

    Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default);
    Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default);

    /// <summary>PROVE the model embeds before a setting is saved, and report the vector width it returned.
    /// Being installed is not being usable, and the width decides whether a switch invalidates every stored
    /// vector. Null = it did not produce a vector, so nothing is saved.</summary>
    Task<EmbedProbe?> ProveAsync(MemorySourceContext ctx, string model, CancellationToken ct = default);

    void Register(LyntaiBuilder b, MemoryWiringContext ctx);
}
```

- [ ] **Step 4: Build**

Run: `dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v q --nologo`
Expected: `Build succeeded. 0 Error(s)`.
If `LyntaiBuilder` does not resolve: it is in the bare `Lyntai` namespace (confirmed against the sibling
Lyntai checkout's `src/Lyntai.Core/DependencyInjection/LyntaiBuilder.cs`), **not** `Lyntai.DependencyInjection`.
`AddOllamaProvider` / `AddOpenAiCompatibleEmbedder` are extension methods in the same namespace, shipped by
`Lyntai.Providers.Default`, which `Gatherlight.Platform` already references — so the source classes can live
in Platform.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Llm/Sources
git commit -m "feat(memory): one interface per recall layer, so a backend serves a layer by existing"
```

---

### Task 2: The three source implementations and the catalog

**Files:**
- Create: `src/server/Gatherlight.Platform/Agent/Llm/Sources/ClaudeCliJudgeSource.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Llm/Sources/OllamaJudgeSource.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Llm/Sources/OllamaSemanticSource.cs`
- Create: `src/server/Gatherlight.Platform/Agent/Llm/Sources/MemorySources.cs`

- [ ] **Step 1: `ClaudeCliJudgeSource`**

Its models are the cortex model vocabulary (`haiku` · `sonnet` · `opus`), and its availability is the CLI
probe — *installed is not signed in*, which is the one thing this source must not paper over.

```csharp
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>判断 on the authenticated claude CLI — the default, and what shipped before any of this was a
/// choice. It registers nothing: the CLI provider is already the default client.</summary>
public sealed class ClaudeCliJudgeSource : IMemoryJudgeSource
{
    public string Id => "claude-cli";
    public string Name => "Claude CLI";
    public string Description =>
        "用已登录的账号判断:每次记录事实与每次检索各消耗一次调用。Lyntai 实测漏检最低(0.54 → 0.19)。";

    /// <summary>Null = the default client. The CLI provider is registered unconditionally at startup.</summary>
    public string? ClientName => null;
    public IReadOnlyList<string> CandidateProviderIds => Array.Empty<string>();
    public void Register(LyntaiBuilder b, MemoryWiringContext ctx) { }

    /// <summary>INSTALLED IS NOT USABLE. A downloaded CLI is not a signed-in one, and `claude auth login`
    /// is a browser flow with no headless variant — so this reports the state exactly and names the command
    /// rather than pretending it can fix it.</summary>
    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Claude.ProbeAsync(ct: ct);
        return !s.Runnable
            ? new SourceStatus(false, "这台机器上没有可运行的 Claude CLI —— 可在「资源 · Resources」面板安装。")
            : !s.LoggedIn
                ? new SourceStatus(false, "Claude CLI 已安装但尚未登录 —— 在本机运行 `claude auth login` 后即可使用。")
                : SourceStatus.Ready;
    }

    /// <summary>The same vocabulary cortex routes with, because it is the same router. Ordered cheapest
    /// first: this seam runs on every write and every recall, so the default is the cheap one.</summary>
    public Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<ModelOption>>(new[]
        {
            new ModelOption("haiku", "Haiku(默认 · 最省)", Installed: true,
                Note: "判断这类短任务足够,且是三者里最便宜的 —— 每次写入与每次检索都会调用一次。"),
            new ModelOption("sonnet", "Sonnet", Installed: true,
                Note: "更强,但这一层调用极其频繁,费用按次数放大。"),
            new ModelOption("opus", "Opus", Installed: true,
                Note: "最强也最贵;这一层不建议 —— 判断的收益远小于它的调用次数。"),
        });

    public Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default) =>
        Task.FromResult<string?>(null);
}
```

- [ ] **Step 2: `OllamaJudgeSource`**

Carries over, unchanged in substance, the capability filter and the three blocked-reasons the previous pass
proved out — they move from `MemoryRecallController` into the source that owns them.

```csharp
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>判断 on a chat model held by the local Ollama. No tokens, no network, works offline — and
/// Lyntai measured a local gemma3:4b beating its ground-truth reference on junk admitted, so this is not
/// the cheap-and-worse arm it sounds like.</summary>
public sealed class OllamaJudgeSource : IMemoryJudgeSource
{
    public const string ProviderId = "ollama-chat";
    public const string ClientId = "memory-judge";

    /// <summary>A small chat model to offer when Ollama is running but nothing on it can hold a
    /// conversation. Deliberately NOT in <see cref="EmbeddingCatalog"/> — that list is a measured shortlist
    /// of embedders and a chat model has no business in it.</summary>
    public const string Suggested = "gemma3:4b";

    public string Id => "ollama";
    public string Name => "本机 · Ollama";
    public string Description =>
        "用这台机器上的对话模型判断:不消耗账号额度,不联网,断网也能用;占用本机算力。"
        + "避免选「会思考」的模型 —— 判断在每次回忆的必经路径上。";

    public string? ClientName => ClientId;
    public IReadOnlyList<string> CandidateProviderIds => new[] { ProviderId };

    /// <summary>claude-cli stays FIRST in the global candidate list, so appending this provider is a
    /// FALLBACK rather than a re-route. See <c>GatherlightApp</c> for the upstream narrowing bug this
    /// contains.</summary>
    public void Register(LyntaiBuilder b, MemoryWiringContext ctx) =>
        b.AddOllamaProvider(baseUrl: ctx.OllamaUrl, id: ProviderId)
         .AddLlmClient(ClientId, c => c.UseProviders(ProviderId));

    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(ct: ct);
        if (Candidates(s).Count > 0) return SourceStatus.Ready;
        return !s.Installed
            ? new SourceStatus(false, "这台机器没有安装 Ollama —— 可在「资源 · Resources」面板安装。")
            : !s.Serving
                ? new SourceStatus(false, "Ollama 已安装但没有运行 —— 在「资源」面板点「启动」,这里就能选了。")
                : new SourceStatus(false,
                    $"这台机器上只有嵌入模型,没有能对话的 —— 判断需要一个对话模型。可以下载 {Suggested}"
                    + "(约 3.3 GB,和嵌入模型装在同一个 Ollama 里),或自己 pull 别的再回来选。", Suggested);
    }

    public async Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(ct: ct);
        return Candidates(s)
            .Select(m => new ModelOption(m.Name, m.Name, Installed: true, SizeBytes: m.SizeBytes))
            .ToList();
    }

    /// <summary>OLLAMA's capability array decides; the shortlist is the fallback for a daemon too old to
    /// report one. Asking the catalog FIRST was the defect: it knows the models we measured and nothing
    /// else, so the first uncatalogued embedder — there is always one — passed straight through the check
    /// written to stop exactly it, into a fail-open policy.</summary>
    private static List<OllamaModel> Candidates(OllamaState s) => s.Models
        .Where(m => m.CanComplete ?? !EmbeddingCatalog.Options.Any(o => OllamaState.Matches(m.Name, o.Id)))
        .ToList();

    public async Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(refresh: true, ct: ct);
        if (!s.Serving) return s.Problem ?? "Ollama 未运行。";
        var held = s.Find(model);
        if (held is null) return $"模型 {model} 尚未下载 —— 请先在「资源」面板下载再启用。";
        return held.CanComplete is false || (held.CanComplete is null && EmbeddingCatalog.Find(model) is not null)
            ? $"{model} 不是对话模型,不能用来判断检索结果 —— 请选一个对话模型(例如 {Suggested})。"
            : null;
    }
}
```

- [ ] **Step 3: `OllamaSemanticSource`**

```csharp
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>语义 on an embedding model held by the local Ollama — the same daemon at the same URL as
/// <see cref="OllamaJudgeSource"/>, with a different model on it.</summary>
public sealed class OllamaSemanticSource : IMemorySemanticSource
{
    public string Id => "ollama";
    public string Name => "本机 · Ollama";
    public string Description =>
        "用这台机器上的嵌入模型为事实生成向量:占用磁盘与算力,不消耗 token,资料不离开这台电脑。";

    /// <summary>Keyless on purpose: a local Ollama takes no bearer token, and inventing one would only make
    /// a misconfigured remote endpoint look authenticated.</summary>
    public void Register(LyntaiBuilder b, MemoryWiringContext ctx) =>
        b.AddOpenAiCompatibleEmbedder("ollama", o =>
         {
             o.BaseUrl = ctx.OllamaUrl;
             o.Model = ctx.Model;
         })
         .UseSqliteVectorStore()
         .AddSemanticMemory();

    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(ct: ct);
        return !s.Installed
            ? new SourceStatus(false, "这台机器没有安装 Ollama —— 可在「资源 · Resources」面板安装。")
            : !s.Serving
                ? new SourceStatus(false, "Ollama 已安装但没有运行 —— 在「资源」面板点「启动」。")
                : SourceStatus.Ready;
    }

    /// <summary>Installed embedders FIRST (what you can use now), then the measured shortlist as things to
    /// fetch. The list is not the limit — 资源 also takes a free-form id — so an uncatalogued model that is
    /// already on disk still appears, and appears as usable.</summary>
    public async Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(ct: ct);
        var installed = s.Models
            .Where(m => m.CanEmbed ?? EmbeddingCatalog.Find(m.Name) is not null)
            .Select(m => new ModelOption(m.Name, m.Name, Installed: true, SizeBytes: m.SizeBytes,
                Note: EmbeddingCatalog.Find(m.Name)?.Note,
                Measured: EmbeddingCatalog.Find(m.Name)?.Measured,
                Vintage: EmbeddingCatalog.Find(m.Name)?.Vintage))
            .ToList();

        var offerable = EmbeddingCatalog.Options
            .Where(o => !s.Has(o.Id))
            .Select(o => new ModelOption(o.Id, o.Name, Installed: false, SizeBytes: o.ApproxBytes,
                Note: o.Note, Measured: o.Measured, Vintage: o.Vintage));

        return installed.Concat(offerable).ToList();
    }

    /// <summary>The CHEAP no before the expensive one, then the real proof. A model Ollama has already said
    /// cannot embed will not start embedding once it is in memory, and the probe costs a cold model load —
    /// up to minutes — to reach the same answer.</summary>
    public async Task<EmbedProbe?> ProveAsync(MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        var s = await ctx.Ollama.ProbeAsync(refresh: true, ct: ct);
        if (!s.Serving) return null;
        var held = s.Find(model);
        if (held is null || held.CanEmbed is false) return null;
        return await ctx.Ollama.ProbeEmbeddingAsync(model, ct);
    }
}
```

- [ ] **Step 4: `MemorySources` — the catalog and the binding**

This is the single list. `GatherlightApp` reads it before the container exists; the controller reads it
after. Both find the same instances, so there is no second registry to drift.

```csharp
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// Every backend that can serve a recall layer, in one static list — the shape
/// <c>CortexConfigService.ModelCatalog</c> and <c>PromptHarness.Catalog</c> already use.
///
/// <para><b>Why static instead of a DI collection.</b> The wiring happens inside
/// <c>AddLyntai(b => …)</c>, while the container is being BUILT — there is nothing to resolve from yet.
/// A DI collection would therefore need a second, registration-time list beside it, and two lists for one
/// set is precisely the drift <c>check-ui-registry</c> exists to catch elsewhere. Sources take their
/// runtime dependencies as a per-call <see cref="MemorySourceContext"/> instead, which costs one parameter
/// and buys one list.</para>
///
/// <para><b>Adding a backend is one line here plus one class.</b> An ONNX embedder appears in 语义's toggle
/// the moment <c>new EmbeddedSemanticSource()</c> joins <see cref="Semantic"/> — no controller change, no
/// client change, no capability table to update.</para>
/// </summary>
public static class MemorySources
{
    public static readonly IReadOnlyList<IMemoryJudgeSource> Judge = new IMemoryJudgeSource[]
    {
        new ClaudeCliJudgeSource(),
        new OllamaJudgeSource(),
    };

    public static readonly IReadOnlyList<IMemorySemanticSource> Semantic = new IMemorySemanticSource[]
    {
        new OllamaSemanticSource(),
    };

    public const string DefaultJudgeSource = "claude-cli";
    public const string DefaultJudgeModel = "haiku";

    public static IMemoryJudgeSource? FindJudge(string? id) =>
        Judge.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.OrdinalIgnoreCase));

    public static IMemorySemanticSource? FindSemantic(string? id) =>
        Semantic.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>Which source 判断 is bound to, honouring the pre-2026-08-21 <c>JudgeTransport</c> key.
    /// <para>Read-side compatibility rather than a migration step: an existing settings.json keeps working
    /// untouched, and the first write through the panel replaces it. A migration would have to run before
    /// the DB opens, which is where this value is consumed, and gains nothing over three lines here.</para></summary>
    public static IMemoryJudgeSource ResolveJudge(MemoryConfig c)
    {
        var id = !string.IsNullOrWhiteSpace(c.JudgeSource) ? c.JudgeSource
            : string.Equals(c.JudgeTransport, "local", StringComparison.OrdinalIgnoreCase) ? "ollama"
            : DefaultJudgeSource;
        return FindJudge(id) ?? Judge[0];
    }

    /// <summary>The model 判断 is bound to. The CLI arm's default is haiku; the local arm has no default,
    /// because a machine-specific model cannot have one.</summary>
    public static string? ResolveJudgeModel(MemoryConfig c)
    {
        var src = ResolveJudge(c);
        return src.Id == DefaultJudgeSource
            ? (string.IsNullOrWhiteSpace(c.JudgeModel) ? DefaultJudgeModel : c.JudgeModel)
            : c.JudgeModel;
    }

    /// <summary>Which source 语义 is bound to, or null when the layer is off. Honours the legacy
    /// <c>SemanticEnabled</c> flag the same way.</summary>
    public static IMemorySemanticSource? ResolveSemantic(MemoryConfig c)
    {
        if (string.IsNullOrWhiteSpace(c.EmbeddingModel)) return null;
        if (!string.IsNullOrWhiteSpace(c.SemanticSource)) return FindSemantic(c.SemanticSource);
        return c.SemanticEnabled ? FindSemantic("ollama") : null;
    }
}
```

- [ ] **Step 5: Add the two config fields**

Modify `src/server/Gatherlight.Platform/Kernel/Services/ServerConfigService.cs`, inside `MemoryConfig`
(after `JudgeModel`, line ~191):

```csharp
    /// <summary>Which backend serves 判断 — a <see cref="Sources.IMemoryJudgeSource.Id"/>: <c>claude-cli</c>
    /// or <c>ollama</c>. Supersedes <see cref="JudgeTransport"/>, which is still READ for an install written
    /// before 2026-08-21 and never written again.</summary>
    public string? JudgeSource { get; set; }

    /// <summary>Which backend serves 语义 — an <see cref="Sources.IMemorySemanticSource.Id"/>. Null with an
    /// <see cref="EmbeddingModel"/> present means the layer is off but its choice is remembered, so turning
    /// it back on does not cost the download and the reindex again.</summary>
    public string? SemanticSource { get; set; }
```

And amend `JudgeTransport`'s summary to open with:
`/// <summary>LEGACY — superseded by <see cref="JudgeSource"/>; still read so an older settings.json keeps working. …`

- [ ] **Step 6: Build**

Run: `dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v q --nologo`
Expected: `Build succeeded. 0 Error(s)`.

- [ ] **Step 7: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Llm/Sources src/server/Gatherlight.Platform/Kernel/Services/ServerConfigService.cs
git commit -m "feat(memory): the three recall backends as sources, in one static catalog"
```

---

### Task 3: Wire startup from the catalog

The behaviour must not change. `p51` staying green **is** the proof — this is a refactor whose whole risk is
a silent wiring regression, which is the failure class this area specialises in.

**Files:**
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`

- [ ] **Step 1: Run p51 first, to have a known-good baseline**

Run: `node devtools/dev.mjs e2e p51`
Expected: `e2e-p51 PASS` — record the case count so a silently *shrunk* suite is visible later.

- [ ] **Step 2: Replace the resolution block (lines ~97-119)**

```csharp
        // WHICH BACKEND SERVES EACH LAYER, resolved from the one catalog the console also renders from.
        // Both are startup decisions by construction — a provider, a named client, an embedder and a vector
        // store are all DI registrations — so the console reports a restart rather than pretending
        // otherwise. See MemorySources for why that catalog is static rather than a DI collection.
        var memoryConfig = config.Current.Memory;
        var ollamaUrl = Platform.Agent.Llm.Services.OllamaRuntime.ResolveBaseUrl(memoryConfig.OllamaUrl);

        var judgeSource = Platform.Agent.Llm.Sources.MemorySources.ResolveJudge(memoryConfig);
        var judgeModel = Platform.Agent.Llm.Sources.MemorySources.ResolveJudgeModel(memoryConfig)
            ?? Platform.Agent.Llm.Sources.MemorySources.DefaultJudgeModel;
        // A bound source with no model has nothing to embed WITH, so a half-configured install stays off
        // rather than failing at the first fact write.
        var semanticSource = Platform.Agent.Llm.Sources.MemorySources.ResolveSemantic(memoryConfig);
        var embeddingModel = memoryConfig.EmbeddingModel;
        var semanticOn = semanticSource is not null && !string.IsNullOrWhiteSpace(embeddingModel);
```

- [ ] **Step 3: Update `MemoryJudgeWiring` (line ~126)**

```csharp
            .AddSingleton(new Platform.Agent.Llm.Services.MemoryJudgeWiring(judgeSource.Id, judgeModel))
```

Then widen the record's doc in
`src/server/Gatherlight.Platform/Agent/Llm/Services/MemoryEnrichmentPolicies.cs` — `Transport` now carries a
source id, not `cli`/`local`:

```csharp
/// <param name="Transport">The bound <c>IMemoryJudgeSource.Id</c> — <c>claude-cli</c> or <c>ollama</c>.</param>
/// <param name="Model">The model in effect on it.</param>
```

- [ ] **Step 4: Route the model through one key (line ~180)**

```csharp
                    // ONE source of truth for which model judges. It was two: this default AND cortex's
                    // live llm.model.memory, which overrides it — so a household that had ever set 记忆判断
                    // to `haiku` and later moved the judge to a local model got the router asking the
                    // OLLAMA provider for a model called "haiku". Both policies are fail-open, so the
                    // symptom was no model calls and no error. 记忆检索's picker now writes the model key
                    // itself, and cortex no longer offers a second place to disagree from.
                    o.DefaultModelByConsumer["memory"] = judgeModel;
```

- [ ] **Step 5: Candidates and registration from the source (lines ~194, ~345-367)**

```csharp
                // claude-cli stays FIRST, so a source's provider is a FALLBACK rather than a re-route.
                // The list must carry it at all because LlmRouterFactory.For() narrows a named client's
                // PROVIDER POOL but reuses these candidates — a client pooled over a provider absent here
                // matches nothing and fails silently.
                .UseDefaultCandidates(["claude-cli", .. judgeSource.CandidateProviderIds])
```

and, replacing both `if (judgeLocal) { … }` and `if (semanticOn) { … }`:

```csharp
                // Each source registers its OWN backend. The CLI's Register is a no-op; Ollama's adds a
                // provider plus a named client; a future embedded runtime adds whatever it needs, with no
                // edit here.
                judgeSource.Register(b, new Platform.Agent.Llm.Sources.MemoryWiringContext(judgeModel, ollamaUrl));
                if (semanticOn)
                    semanticSource!.Register(b,
                        new Platform.Agent.Llm.Sources.MemoryWiringContext(embeddingModel!, ollamaUrl));
```

- [ ] **Step 6: Client name from the source (line ~282)**

```csharp
                var judgeClient = judgeSource.ClientName;
```

- [ ] **Step 7: Build and run p51 — it must still pass unchanged**

Run: `dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v q --nologo`
Then: `node devtools/dev.mjs e2e p51`
Expected: `e2e-p51 PASS`, same case count as Step 1. A *reduced* count means an assertion silently stopped
running, which is worse than a failure.

- [ ] **Step 8: Commit**

```bash
git add src/server/Gatherlight.Server/GatherlightApp.cs src/server/Gatherlight.Platform/Agent/Llm/Services/MemoryEnrichmentPolicies.cs
git commit -m "refactor(memory): startup wires each layer from its source, and one key names the judge model"
```

---

### Task 4: `/api/manage/models` — 资源 owns provisioning

Moves pull / remove / runtime-start off the recall controller. The recall controller keeps only recall.

**Files:**
- Create: `src/server/Gatherlight.Platform/Hosting/Resources/ModelsController.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/MemoryRecallController.cs` (delete `Pull`, `Remove`, `Start`)
- Modify: `devtools/scripts/e2e/p51.mjs`

- [ ] **Step 1: Write the failing assertions in `p51.mjs`**

Add a new case block. `call` returns `{status, json}`; `post` throws on a non-2xx (see `_e2e-common.mjs`).

```js
  // ---- E · models are a RESOURCE, not a recall setting --------------------------------------------
  const inv = await getJson('/api/manage/models');
  ok('the model inventory answers, and says where each model can run',
    Array.isArray(inv.models), JSON.stringify(inv).slice(0, 200));
  ok('every entry names its runtime and what it can do',
    (inv.models ?? []).every((m) => !!m.runtime && Array.isArray(m.capabilities)),
    JSON.stringify(inv.models?.[0]));
  ok('downloads in flight are readable here — this is what the progress bar renders from',
    Array.isArray(inv.pulls));

  const badPull = await call('POST', '/api/manage/models/pull', { model: '--rm -rf' });
  ok('pull refuses a flag-shaped id before it reaches the registry', badPull.status === 400, badPull.status);
  const trav = await call('POST', '/api/manage/models/pull', { model: '../etc/passwd' });
  ok('pull refuses a path traversal before it reaches the registry', trav.status === 400, trav.status);

  const rmMissing = await call('POST', '/api/manage/models/remove', { model: 'not-a-real-model-xyz' });
  ok('deleting something that is not installed does not report success',
    rmMissing.status >= 400, rmMissing.status);

  // The OLD paths are gone — a moved endpoint that answers at both addresses is two surfaces to keep
  // in step, and the one nobody remembers is the one that rots.
  const gonePull = await call('POST', '/api/manage/memory/local/pull', { model: 'bge-m3' });
  ok('the old pull path is gone, not quietly aliased', gonePull.status === 404, gonePull.status);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node devtools/dev.mjs e2e p51`
Expected: FAIL — `the model inventory answers…` (404 from an endpoint that does not exist yet).

- [ ] **Step 3: Write `ModelsController`**

```csharp
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Kernel.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Platform.Hosting.Resources;

/// <summary>
/// 本机模型 · Local models — the provisioning half of 资源.
///
/// <para><b>Why models live beside chromium and git rather than inside 记忆检索.</b> A model is a file with
/// a size, a capability and a delete button; it carries no opinion about recall. The chat/embedding split
/// is Ollama's, enforced upstream — not a product rule we chose and could relax. So downloading one is the
/// same act as downloading a browser, and the panel that does it is the same panel.</para>
///
/// <para>What stays in 记忆检索 is the only part that IS a recall decision: which model each layer uses.</para>
/// </summary>
[ApiController]
public sealed class ModelsController : ControllerBase
{
    private readonly IOllamaRuntime _ollama;
    private readonly ServerConfigService _config;
    private readonly IModelPullStatus _pulls;
    private readonly ILogger<ModelsController> _log;

    public ModelsController(IOllamaRuntime ollama, ServerConfigService config,
        IModelPullStatus pulls, ILogger<ModelsController> log)
    {
        _ollama = ollama;
        _config = config;
        _pulls = pulls;
        _log = log;
    }

    [HttpGet("api/manage/models")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {
        var s = await _ollama.ProbeAsync(refresh);
        var mem = _config.Current.Memory;
        var judgeModel = MemorySources.ResolveJudgeModel(mem);
        var rec = EmbeddingCatalog.Recommend(s.GpuLikely);

        return Ok(new
        {
            runtime = new
            {
                id = "ollama", baseUrl = s.BaseUrl, installed = s.Installed, serving = s.Serving,
                version = s.Version, gpuLikely = s.GpuLikely, problem = s.Problem,
            },
            // On disk now: what it costs, what it can do, and whether a layer is holding it.
            models = s.Models.Select(m => new
            {
                id = m.Name, name = m.Name, runtime = "ollama", sizeBytes = m.SizeBytes,
                capabilities = m.Capabilities,
                inUse = InUse(m.Name, mem, judgeModel),
                measured = Measured(m.Name),
            }),
            // Offerable but absent — the measured shortlist plus a chat model, so the panel that installs
            // an embedder with a button does not answer "you need a chat model" with a shell command.
            offers = EmbeddingCatalog.Options.Where(o => !s.Has(o.Id)).Select(o => new
            {
                id = o.Id, name = o.Name, runtime = "ollama", approxBytes = o.ApproxBytes,
                dimensions = o.Dimensions, note = o.Note, vintage = o.Vintage, capability = "embedding",
                measured = o.Measured is null ? null : new
                {
                    top1 = o.Measured.RecallTop1, top3 = o.Measured.RecallTop3,
                    queries = o.Measured.Queries, msPerQuery = o.Measured.MsPerQuery,
                },
            }).Concat(s.Has(OllamaJudgeSource.Suggested) ? [] : new[] { new
            {
                id = OllamaJudgeSource.Suggested, name = $"{OllamaJudgeSource.Suggested}(对话 · 可用于判断)",
                runtime = "ollama", approxBytes = 3_300_000_000L, dimensions = 0,
                note = "小而快的对话模型 —— 判断这一层用它就够,且不消耗账号额度。", vintage = (string?)null,
                capability = "completion", measured = (object?)null,
            } }),
            recommendation = new { id = rec.Id, reason = rec.Reason, caution = rec.Caution },
            measuredOn = "20 条中英混排事实 · 10 个改写提问 · 2026-08-21",
            pulls = _pulls.Current.Select(p => new
            {
                model = p.Model, running = p.Running, percent = p.Percent, status = p.Status, error = p.Error,
            }),
        });
    }

    /// <summary>Which layer, if any, is holding this model — the reason a delete is refused, named.</summary>
    private static string? InUse(string name, MemoryConfig mem, string? judgeModel) =>
        MemorySources.ResolveSemantic(mem) is not null && mem.EmbeddingModel is { } emb
            && OllamaState.Matches(name, emb) ? "semantic"
        : MemorySources.ResolveJudge(mem).Id == "ollama" && judgeModel is { } j
            && OllamaState.Matches(name, j) ? "judge"
        : null;

    private static object? Measured(string name)
    {
        var m = EmbeddingCatalog.Find(name)?.Measured;
        return m is null ? null
            : new { top1 = m.RecallTop1, top3 = m.RecallTop3, queries = m.Queries, msPerQuery = m.MsPerQuery };
    }

    /// <summary>Start Ollama ONLY when nothing is answering — a household's own instance is left alone.</summary>
    [HttpPost("api/manage/models/start")]
    public async Task<IActionResult> Start()
    {
        var ok = await _ollama.EnsureServingAsync();
        return ok ? Ok(new { ok = true })
            : StatusCode(409, new { error = (await _ollama.ProbeAsync(refresh: true)).Problem ?? "无法启动 Ollama。" });
    }

    /// <summary>Start a download and RETURN. Progress is read back from <c>GET /api/manage/models</c>.
    /// <para>Detached because a model is hundreds of megabytes to gigabytes over whatever line the household
    /// has: inside the POST it gave a button reading 下载中… with no bar for minutes, indistinguishable from
    /// a hang — over a request the browser may abandon while Ollama carries on, which is how a completed
    /// pull got reported as a failure.</para></summary>
    [HttpPost("api/manage/models/pull")]
    public IActionResult Pull([FromBody] ModelRequest body)
    {
        if (string.IsNullOrWhiteSpace(body?.Model)) return BadRequest(new { error = "model is required" });
        // Shape, not membership. A list baked into a release cannot contain a model published after it —
        // see EmbeddingCatalog.IsWellFormedId for what the gate still checks and why that is the right line.
        if (!EmbeddingCatalog.IsWellFormedId(body.Model))
            return BadRequest(new { error = $"模型名称格式不正确:{body.Model}" });

        var model = body.Model.Trim();
        // Already downloading is SUCCESS: the household asked for a download and one is running. A 409 here
        // would drop an error toast over a working progress bar.
        if (!_pulls.TryStart(model))
            return Accepted(new { ok = true, started = false, model, note = "这个模型已经在下载中。" });

        _ = Task.Run(async () =>
        {
            try
            {
                // Deliberately NOT the request's token: the work outlives the POST.
                await _ollama.PullModelAsync(model, (p, st) => _pulls.Report(model, p, st), CancellationToken.None);
                _pulls.Finish(model, null);
                _log.LogInformation("pulled local model {Model}", model);
            }
            catch (Exception ex)
            {
                _log.LogWarning("model pull failed for {Model}: {Msg}", model, ex.Message);
                _pulls.Finish(model, ex.Message);
            }
        });
        return Accepted(new { ok = true, started = true, model, note = "开始下载 —— 进度显示在模型列表里。" });
    }

    /// <summary>Delete a model, freeing its disk. Refused for one a layer is BOUND to, even when that
    /// binding is not running yet: recall is fail-open, so the household would see searches that quietly
    /// find less rather than an error naming what they removed.</summary>
    [HttpPost("api/manage/models/remove")]
    public async Task<IActionResult> Remove([FromBody] ModelRequest body)
    {
        var model = body?.Model?.Trim();
        if (!EmbeddingCatalog.IsWellFormedId(model))
            return BadRequest(new { error = $"模型名称格式不正确:{body?.Model}" });

        var mem = _config.Current.Memory;
        var holder = InUse(model!, mem, MemorySources.ResolveJudgeModel(mem));
        if (holder == "semantic")
            return StatusCode(409, new { error = $"{model} 正在用于语义检索 —— 请先在「记忆检索」换个模型或停用,再删除。" });
        if (holder == "judge")
            return StatusCode(409, new { error = $"{model} 正在用于记忆判断 —— 请先在「记忆检索」换个后端或模型,再删除。" });

        try
        {
            await _ollama.RemoveModelAsync(model!);
            return Ok(new { ok = true, removed = model });
        }
        catch (Exception ex)
        {
            _log.LogWarning("removing {Model} failed: {Msg}", model, ex.Message);
            return StatusCode(502, new { error = ex.Message });
        }
    }

    public sealed record ModelRequest(string Model);
}
```

- [ ] **Step 4: Delete the three moved actions from `MemoryRecallController`**

Remove `Start()` (`api/manage/memory/local/start`), `Pull()` (`…/local/pull`) and `Remove()`
(`…/local/remove`) along with their doc-comments. Keep `ModelRequest` for now — `EnableLocal` still uses it
until Task 5.

- [ ] **Step 5: Run p51 — the new case block must pass**

Run: `node devtools/dev.mjs e2e p51`
Expected: `e2e-p51 PASS` including the five new rows. The old-path row proves the move was a MOVE.

- [ ] **Step 6: Commit**

```bash
git add src/server/Gatherlight.Platform/Hosting/Resources/ModelsController.cs src/server/Gatherlight.Platform/Agent/Llm/MemoryRecallController.cs devtools/scripts/e2e/p51.mjs
git commit -m "feat(resources): models are provisioned artifacts, so 资源 owns pulling and deleting them"
```

---

### Task 5: `/api/manage/memory` becomes layer rows

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/MemoryRecallController.cs`
- Modify: `devtools/scripts/e2e/p51.mjs`

- [ ] **Step 1: Write the failing assertions**

```js
  // ---- F · layers are rows, and a backend serves a layer by EXISTING -----------------------------
  const m = await getJson('/api/manage/memory');
  ok('the layers are reported as rows', Array.isArray(m.layers) && m.layers.length === 3,
    JSON.stringify((m.layers ?? []).map((l) => l.id)));
  const judge = m.layers.find((l) => l.id === 'judge');
  const semantic = m.layers.find((l) => l.id === 'semantic');
  ok('公式 is a row too, and is not optional',
    m.layers.some((l) => l.id === 'formula' && l.alwaysOn === true));

  ok('判断 offers both backends', (judge.sources ?? []).map((x) => x.id).join() === 'claude-cli,ollama',
    JSON.stringify(judge.sources?.map((x) => x.id)));
  // The load-bearing assertion of this whole design: Claude is absent from 语义 because no class
  // implements that layer's interface — not because a filter dropped it. If a ClaudeCliSemanticSource is
  // ever added, this row SHOULD fail and be updated deliberately.
  ok('语义 offers only backends that can actually embed',
    (semantic.sources ?? []).every((x) => x.id !== 'claude-cli'),
    JSON.stringify(semantic.sources?.map((x) => x.id)));
  ok('every source says whether it is usable here, and why not when it is not',
    [...judge.sources, ...semantic.sources].every(
      (x) => typeof x.available === 'boolean' && (x.available || !!x.reason)),
    JSON.stringify([...judge.sources, ...semantic.sources].map((x) => [x.id, x.available, x.reason])));

  ok('判断 defaults to the CLI, and reports SAVED separately from RUNNING',
    judge.source === 'claude-cli' && judge.activeSource === 'claude-cli',
    JSON.stringify({ saved: judge.source, active: judge.activeSource }));

  const unknownSrc = await call('POST', '/api/manage/memory/layer/judge', { source: 'nope', model: 'haiku' });
  ok('an unknown backend is refused', unknownSrc.status === 400, unknownSrc.status);
  const unknownLayer = await call('POST', '/api/manage/memory/layer/nope', { source: 'claude-cli', model: 'haiku' });
  ok('an unknown layer is refused', unknownLayer.status === 404, unknownLayer.status);

  // A backend that cannot serve the layer is refused BY NAME. Both policies are fail-open, so accepting
  // one would surface as recall that quietly never improves — never as an error.
  const inv2 = await getJson('/api/manage/models');
  const embedders = (inv2.models ?? []).filter((x) => (x.capabilities ?? []).includes('embedding')
    && !(x.capabilities ?? []).includes('completion'));
  for (const e of embedders) {
    const r = await call('POST', '/api/manage/memory/layer/judge', { source: 'ollama', model: e.id });
    ok(`an embedding-only model is refused as a judge: ${e.id}`, r.status === 409, r.status);
  }

  // Binding the CLI arm writes the MODEL KEY too — the fix for a bug that had no symptom: cortex's live
  // llm.model.memory used to override the local judge's model and hand "haiku" to the Ollama provider.
  await post('/api/manage/memory/layer/judge', { source: 'claude-cli', model: 'sonnet' });
  const cortex = await getJson('/api/manage/cortex');
  ok('cortex no longer offers a second place to set the judge model',
    !(cortex.models ?? []).some((x) => x.consumer === 'memory'),
    JSON.stringify((cortex.models ?? []).map((x) => x.consumer)));
  const after = await getJson('/api/manage/memory');
  ok('and the layer reports the model it was just bound to',
    after.layers.find((l) => l.id === 'judge').model === 'sonnet',
    after.layers.find((l) => l.id === 'judge').model);
```

> Confirm the cortex read path before running: `Select-String -Path src/server/Gatherlight.Platform/Ops/Cortex/*.cs -Pattern "HttpGet"`. If the route is not `api/manage/cortex`, use the real one in the two rows above.

- [ ] **Step 2: Run it and watch it fail**

Run: `node devtools/dev.mjs e2e p51`
Expected: FAIL — `the layers are reported as rows` (`m.layers` is undefined).

- [ ] **Step 3: Replace `Get()` in `MemoryRecallController`**

Keep the existing class doc, replacing its layer list with the source model. The response becomes:

```csharp
    [HttpGet("api/manage/memory")]
    public async Task<IActionResult> Get([FromQuery] bool refresh = false)
    {
        var mem = _config.Current.Memory;
        var ctx = new MemorySourceContext(_ollama, _claude, mem);
        if (refresh) await _ollama.ProbeAsync(refresh: true);

        var boundJudge = MemorySources.ResolveJudge(mem);
        var boundSemantic = MemorySources.ResolveSemantic(mem);
        var (indexed, totalFacts) = await _knowledge.CoverageAsync();

        return Ok(new
        {
            layers = new object[]
            {
                new
                {
                    id = "formula", name = "公式 · Formula", alwaysOn = true, on = true, live = true,
                    what = "图谱衰减 + 排名融合 + 三元组全文检索。不需要设置,不产生费用 —— 其余两项都建立在它之上。",
                    sources = Array.Empty<object>(),
                },
                new
                {
                    id = MemoryLayers.Judge, name = "判断 · Judgement", alwaysOn = false,
                    // LIVE: an app_config value read per call. The BINDING below is a startup registration,
                    // so the two kinds of change are reported differently rather than looking alike.
                    on = MemoryEnrichment.IsOn(_appConfig), live = true,
                    what = "写入事实时标注主题,检索时判断哪些结果真正回答了问题(明显提升召回质量)。",
                    source = boundJudge.Id, model = MemorySources.ResolveJudgeModel(mem),
                    // …and what is ACTUALLY running, which is not the same thing until the restart happens.
                    activeSource = _judgeWiring.Transport, activeModel = _judgeWiring.Model,
                    sources = await SourceViews(MemorySources.Judge, ctx),
                },
                new
                {
                    id = MemoryLayers.Semantic, name = "语义 · Semantic", alwaysOn = false,
                    on = boundSemantic is not null, live = false,
                    what = "用本地模型为事实生成向量,按语义检索 —— 问法与原文用词完全不同也能找到。",
                    source = boundSemantic?.Id, model = mem.EmbeddingModel,
                    // Only the semantic layer has a saved-vs-running gap it can OBSERVE: ISemanticMemory
                    // resolves only when an embedder did.
                    activeSource = _semantic is not null ? boundSemantic?.Id : null,
                    activeModel = _semantic is not null ? mem.EmbeddingModel : null,
                    sources = await SourceViews(MemorySources.Semantic, ctx),
                    note = "开启或更换模型后需要重建索引:会重新计算全部向量,并重置已积累的排序权重(事实本身不受影响)。",
                    reindex = ReindexView(),
                    // COVERAGE, not a history of rebuilds — the standing answer to "is what I know
                    // searchable now", and self-correcting where an event log is not.
                    coverage = new { indexed, total = totalFacts },
                },
            },
            // WHY 语义 sits under 高级 rather than as a co-equal third. Attributed, because it was measured
            // on LYNTAI's corpus and not on this household's — presenting it as ours would be the same
            // unearned confidence the card model exists to prevent.
            weighting = new
            {
                primary = MemoryLayers.Judge,
                note = "Lyntai 在自己的语料上实测:漏检里 0% 是「没检索到」—— 答案本来就在候选里,只是排在后面。"
                    + "所以先开「判断」比先开「语义」更划算(漏检 0.54 → 0.19)。这份实测来自 Lyntai 的语料,不是这个家庭的。",
            },
        });
    }

    /// <summary>Every source for a layer, whether or not it can serve right now. An unavailable source is
    /// LISTED with its reason: removing it answers "why can't I pick this?" by making the question
    /// unaskable, which is the dead-switch failure this surface exists to end.</summary>
    private static async Task<object[]> SourceViews(IReadOnlyList<IMemoryJudgeSource> sources,
        MemorySourceContext ctx)
    {
        var views = new List<object>();
        foreach (var s in sources)
        {
            var st = await s.StatusAsync(ctx);
            views.Add(new
            {
                id = s.Id, name = s.Name, description = s.Description,
                available = st.Available, reason = st.Reason, suggest = st.Suggest,
                models = (await s.ModelsAsync(ctx)).Select(ModelView),
            });
        }
        return views.ToArray();
    }

    // The semantic overload is identical in shape; the two interfaces do not share a base because their
    // third members differ (RejectAsync vs ProveAsync) and a shared base would exist only to let one
    // helper serve both — which is what the overload does instead, without weakening either contract.
    private static async Task<object[]> SourceViews(IReadOnlyList<IMemorySemanticSource> sources,
        MemorySourceContext ctx)
    {
        var views = new List<object>();
        foreach (var s in sources)
        {
            var st = await s.StatusAsync(ctx);
            views.Add(new
            {
                id = s.Id, name = s.Name, description = s.Description,
                available = st.Available, reason = st.Reason, suggest = st.Suggest,
                models = (await s.ModelsAsync(ctx)).Select(ModelView),
            });
        }
        return views.ToArray();
    }

    private static object ModelView(ModelOption m) => new
    {
        id = m.Id, name = m.Name, installed = m.Installed, sizeBytes = m.SizeBytes,
        note = m.Note, vintage = m.Vintage,
        measured = m.Measured is null ? null : new
        {
            top1 = m.Measured.RecallTop1, top3 = m.Measured.RecallTop3,
            queries = m.Measured.Queries, msPerQuery = m.Measured.MsPerQuery,
        },
    };
```

Add `IClaudeCliRuntime _claude` to the constructor (it is already registered — `ResourcesController` takes
it) and `using Gatherlight.Server.Platform.Agent.Llm.Sources;` at the top.

- [ ] **Step 4: Replace the three binding endpoints with one**

Delete `SetJudge`, `EnableLocal`, `DisableLocal`, `JudgeRequest` and `ModelRequest`. Add:

```csharp
    /// <summary>Bind a layer to a backend and a model — the one action that used to be three, spread over
    /// two stores.
    /// <para>A restart is owed either way: a backend is a provider, a named client, an embedder or a vector
    /// store, all registered while the container is built. The judge's ON/OFF beside it stays live, and the
    /// console distinguishes the two rather than making every change look like it needs a restart.</para></summary>
    [HttpPost("api/manage/memory/layer/{layer}")]
    public async Task<IActionResult> Bind(string layer, [FromBody] BindRequest body)
    {
        var model = body?.Model?.Trim();
        var ctx = new MemorySourceContext(_ollama, _claude, _config.Current.Memory);

        if (string.Equals(layer, MemoryLayers.Judge, StringComparison.OrdinalIgnoreCase))
        {
            var src = MemorySources.FindJudge(body?.Source);
            if (src is null) return BadRequest(new { error = $"未知的后端:{body?.Source}" });
            if (string.IsNullOrWhiteSpace(model)) return BadRequest(new { error = "model is required" });
            if (!EmbeddingCatalog.IsWellFormedId(model))
                return BadRequest(new { error = $"模型名称格式不正确:{model}" });

            // A model that is installed, well-formed and unable to judge would sail into a FAIL-OPEN
            // policy, where the only symptom is recall that quietly never improves.
            if (await src.RejectAsync(ctx, model!) is { } why) return StatusCode(409, new { error = why });

            _config.Update(c =>
            {
                c.Memory.JudgeSource = src.Id;
                c.Memory.JudgeModel = model;
                // The legacy key is cleared on the first write through this path, so an old install stops
                // carrying two answers to one question.
                c.Memory.JudgeTransport = null;
            });
            // ONE key names the model. Cortex used to offer a second, and its value overrode this one —
            // which is how "haiku" got handed to the Ollama provider.
            _appConfig.Set("llm.model.memory", model!);
            return Ok(new
            {
                ok = true, layer, source = src.Id, model, restartRequired = true,
                note = "设置已保存。重启服务后由这个后端完成标注与核对。",
            });
        }

        if (string.Equals(layer, MemoryLayers.Semantic, StringComparison.OrdinalIgnoreCase))
        {
            var src = MemorySources.FindSemantic(body?.Source);
            if (src is null) return BadRequest(new { error = $"未知的后端:{body?.Source}" });
            if (string.IsNullOrWhiteSpace(model)) return BadRequest(new { error = "model is required" });
            if (!EmbeddingCatalog.IsWellFormedId(model))
                return BadRequest(new { error = $"模型名称格式不正确:{model}" });

            // PROVE it embeds before saving. Installed is not usable, and the failure would surface only as
            // recall that finds nothing — indistinguishable from a household with no facts.
            var probe = await src.ProveAsync(ctx, model!);
            if (probe is null)
                return StatusCode(409, new
                {
                    error = $"{model} 没有返回向量 —— 它可能不是嵌入模型,或 Ollama 未运行。请换一个,或先在「资源」面板确认。",
                });

            var previous = _config.Current.Memory.EmbeddingModel;
            _config.Update(c =>
            {
                c.Memory.SemanticSource = src.Id;
                c.Memory.EmbeddingModel = model;
                c.Memory.SemanticEnabled = true;   // legacy readers stay correct
            });
            // A CHANGED model invalidates every stored vector — they keep the old width and recall then
            // matches nothing rather than erroring — so the reindex is not optional.
            var modelChanged = previous is not null && !OllamaState.Matches(previous, model!);
            return Ok(new
            {
                ok = true, layer, source = src.Id, model, restartRequired = true, reindexRequired = true,
                modelChanged, dimensions = probe.Dimensions, probeMs = probe.Milliseconds,
                note = "设置已保存。重启服务后生效,然后请重新建立一次语义索引。",
            });
        }

        return NotFound(new { error = $"未知的层:{layer}" });
    }

    /// <summary>Unbind a layer. The model and its vectors are left alone on purpose: turning a feature off
    /// should not throw away something that cost a large download and a long reindex.</summary>
    [HttpPost("api/manage/memory/layer/{layer}/off")]
    public IActionResult Unbind(string layer)
    {
        if (!string.Equals(layer, MemoryLayers.Semantic, StringComparison.OrdinalIgnoreCase))
            // 判断 is turned off by its LIVE switch, not by unbinding — a different kind of change, and
            // conflating them would put a restart in front of something that needs none.
            return NotFound(new { error = "只有「语义」可以这样停用;「判断」请用它自己的开关。" });

        _config.Update(c => { c.Memory.SemanticSource = null; c.Memory.SemanticEnabled = false; });
        return Ok(new { ok = true, layer, restartRequired = true });
    }

    public sealed record BindRequest(string? Source, string? Model);
```

Rename the reindex route to `api/manage/memory/layer/semantic/reindex` and update its guard to
`MemorySources.ResolveSemantic(_config.Current.Memory) is null → 409`.

- [ ] **Step 5: Run p51**

Run: `node devtools/dev.mjs e2e p51`
Expected: `e2e-p51 PASS`. The cortex row will still fail until Task 6 — that is expected; land Task 6 before
declaring this green, or move that one assertion into Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Llm/MemoryRecallController.cs devtools/scripts/e2e/p51.mjs
git commit -m "feat(memory): one binding endpoint per layer, replacing three that spanned two stores"
```

---

### Task 6: Cortex stops offering a second place to set the judge model

**Files:**
- Modify: `src/server/Gatherlight.Platform/Ops/Cortex/Services/CortexConfigService.cs:54-58`
- Modify: `.claude/rules/dev-conventions.md`

- [ ] **Step 1: Remove the `memory` row**

Delete the `("memory", "记忆判断 · Memory", …)` entry and replace the comment above `ModelCatalog` with:

```csharp
    // Consumers whose model is chosen HERE. Keep in sync with the llm.model.{consumer} lookups AND with
    // GatherlightApp's DefaultModelByConsumer — a consumer routed there and settable NOWHERE is routable in
    // principle and unreachable in practice.
    //
    // `memory` is routed but deliberately absent: 记忆检索 binds it together with its BACKEND, and this row
    // was the second place to set one value. Its value overrode the other, so a household who set it to
    // haiku and later moved the judge to a local model had "haiku" handed to the Ollama provider — with
    // both memory policies fail-open, that produced no calls and no error. One decision, one control.
```

- [ ] **Step 2: Amend the rule so the doc matches**

In `.claude/rules/dev-conventions.md`, find the sentence beginning **"A consumer routed in
`DefaultModelByConsumer` must also be listed in cortex's `ModelCatalog`"** and replace it with:

> **A consumer routed in `DefaultModelByConsumer` must be settable SOMEWHERE the household can reach** — or
> its model is routable in principle and unreachable in practice (`memory` was exactly that, with a comment
> promising a live override the product gave no way to set). Cortex's `ModelCatalog` is the default home;
> `memory` is the exception, bound in 记忆检索 together with its backend, because splitting model from
> backend across two panels put two writers on one key and the cortex one silently won.

- [ ] **Step 3: Run p51**

Run: `node devtools/dev.mjs e2e p51`
Expected: `e2e-p51 PASS`, including `cortex no longer offers a second place to set the judge model`.

- [ ] **Step 4: Commit**

```bash
git add src/server/Gatherlight.Platform/Ops/Cortex/Services/CortexConfigService.cs .claude/rules/dev-conventions.md
git commit -m "fix(cortex): the judge model had two writers, and the wrong one won"
```

---

### Task 7: 资源 renders the model inventory

**Files:**
- Create: `src/client/src/screens/Models.tsx`
- Modify: `src/client/src/screens/Manage.tsx:1206-1254`
- Modify: `src/client/src/styles.css`

- [ ] **Step 1: Write `Models.tsx`**

Export `ModelsSection({ toast })`. It owns:
- a header row: the Ollama runtime line (installed / serving / version / baseUrl) with a **启动** button
  posting `/api/manage/models/start` when installed and not serving;
- **本机模型** — one row per `models[]`: name, capability badges (嵌入 / 对话, tested for the WORD, since an
  older daemon reports none and a guess printed as a fact is worse than a blank), size, `使用中` when
  `inUse` is set, else a 删除 button posting `/api/manage/models/remove`;
- **可下载** — the measured comparison table over `offers[]` (模型 / 检索质量 / 每次查询 / 体积 / 维度 /
  发布 / 下载), with `推荐` on `recommendation.id` and the `measuredOn` footnote;
- a free-form 其他模型 field posting `/api/manage/models/pull`;
- `PullProgress`, moved verbatim from `MemoryRecall.tsx`, matching a row on the id it SENT (Ollama reports
  `bge-m3:latest` for a model pulled as `bge-m3`, so a row keyed on the normalised name never finds itself);
- polling every 1.5s **only while** `pulls.some(p => p.running)` — gate the effect on that derived boolean,
  never on the state object, or the interval is torn down and recreated every tick.

Move `PullProgress`, `memBytes` and the measured-table markup out of `MemoryRecall.tsx` rather than copying
them; `MemoryRecall.tsx` keeps none of it.

- [ ] **Step 2: Mount it in `ResourcesView`**

In `Manage.tsx`, after the `</div>` closing `res-list` (line ~1247):

```tsx
      {/* Models are provisioned artifacts, so they live beside chromium and git — one panel for
          everything downloaded into the data folder. Which model each recall layer USES stays in
          校准 · Cortex → 记忆检索, because that is a recall decision, not a provisioning one. */}
      <ModelsSection toast={toast} />
```

with `import { ModelsSection } from './Models';` at the top.

- [ ] **Step 3: Build the client and look at it**

Run: `node devtools/dev.mjs build`
Then: `node devtools/dev.mjs server` and open `http://127.0.0.1:5317/manage` → 资源.
Expected: the runtime line, the installed models with capability badges, the comparison table, the
free-form field. A compiled server serves `bin/wwwroot`, so a client-only vite build proves nothing here.

- [ ] **Step 4: Commit**

```bash
git add src/client/src/screens/Models.tsx src/client/src/screens/Manage.tsx src/client/src/styles.css
git commit -m "feat(console): 资源 lists the models it downloads, beside the runtimes that host them"
```

---

### Task 8: 记忆检索 becomes layer rows with a source toggle

**Files:**
- Modify: `src/client/src/screens/MemoryRecall.tsx`
- Modify: `src/client/src/styles.css`

- [ ] **Step 1: Replace the state interface**

```ts
interface SourceView {
  id: string; name: string; description: string;
  available: boolean; reason: string | null; suggest: string | null;
  models: { id: string; name: string; installed: boolean; sizeBytes: number | null;
            note: string | null; vintage: string | null;
            measured: { top1: number; top3: number; queries: number; msPerQuery: number } | null }[];
}
interface LayerView {
  id: 'formula' | 'judge' | 'semantic';
  name: string; alwaysOn: boolean; on: boolean; live: boolean; what: string;
  source?: string | null; model?: string | null;
  // What is RUNNING, as opposed to what is saved — between the two, a panel reading only the setting lies.
  activeSource?: string | null; activeModel?: string | null;
  sources: SourceView[];
  note?: string | null;
  reindex?: { running: boolean; done: number; total: number;
              embedded: number | null; error: string | null; percent: number | null };
  coverage?: { indexed: number; total: number };
}
interface MemoryState {
  layers: LayerView[];
  weighting: { primary: string; note: string };
}
```

- [ ] **Step 2: Write `LayerRow` and `SourcePicker`**

`SourcePicker` is the `cx-seg` control you already have, rendered from `layer.sources` — **not** two
hard-coded buttons:

```tsx
/** WHERE a layer runs. Rendered from the sources the server reports for THIS layer, so 语义 shows one
 *  button today and grows a second the day a class implementing its interface is registered — no edit
 *  here. An unavailable source stays visible and carries its own sentence: a disabled control that says
 *  nothing is a dead end, and the household can see the models listed one panel over. */
function SourcePicker(
  { layer, busy, bind }:
  { layer: LayerView; busy: string | null; bind: (source: string, model: string) => void },
) {
  const [pickedSource, setPickedSource] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  // DERIVED from the latest props with an explicit pick layered on top — never seeded into state. A
  // useState initialiser runs once, and this component is not remounted when the panel reloads, so a
  // household who started Ollama and watched their models appear would otherwise be left holding ''.
  const source = layer.sources.find((s) => s.id === (pickedSource ?? layer.source)) ?? layer.sources[0];
  if (!source) return null;
  const names = source.models.filter((m) => m.installed).map((m) => m.id);
  const model = [pickedModel, layer.model, names[0]].find((n) => !!n && names.includes(n)) ?? '';

  return (
    <div className="mem-src">
      <span className="mem-src-lbl">运行于</span>
      <div className="cx-seg">
        {layer.sources.map((s) => (
          <button key={s.id} className={`cx-seg-b${source.id === s.id ? ' on' : ''}`}
            disabled={busy !== null} onClick={() => setPickedSource(s.id)}>{s.name}</button>
        ))}
      </div>
      {names.length > 0 && (
        <select className="mem-src-sel" value={model} onChange={(e) => setPickedModel(e.target.value)}>
          {source.models.filter((m) => m.installed).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}{m.sizeBytes ? ` · ${memBytes(m.sizeBytes)}` : ''}
            </option>
          ))}
        </select>
      )}
      <button className="cx-btn primary"
        disabled={busy !== null || !model || !source.available
          || (source.id === layer.source && model === layer.model)}
        onClick={() => bind(source.id, model)}>
        {busy === `bind:${layer.id}` ? '保存中…' : '使用'}
      </button>
      <div className="mem-fine">{source.description}</div>
      {/* WHY it is unavailable — outside the <select>, which only renders when there is something to
          select: the one case a sentence inside it existed to explain was the one case it could never
          appear in. */}
      {!source.available && source.reason && <div className="mem-fine warn">{source.reason}</div>}
      {source.suggest && (
        <div className="mem-fine">
          需要的模型可在「资源 · Resources」面板一键下载:<b>{source.suggest}</b>
        </div>
      )}
      {source.available && names.length === 0 && (
        <div className="mem-fine warn">这个后端还没有可用的模型 —— 请先到「资源 · Resources」面板下载。</div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Render the rows, with 语义 under 高级**

The summary pill row keeps all three layers, because state is state. Below it, 公式 and 判断 render as full
cards; then a `高级 · Advanced` divider carrying `weighting.note`; then 语义, collapsed while it is off.

```tsx
      <div className="mem-adv-head">
        <span className="mem-adv-label">高级 · Advanced</span>
        {/* Attributed on purpose. It is Lyntai's measurement on Lyntai's corpus, and presenting someone
            else's numbers as this household's would be exactly the unearned confidence the card model
            exists to prevent. */}
        <span className="mem-fine">{s.weighting.note}</span>
      </div>
```

Keep, unchanged in substance: the restart banner driven by `source !== activeSource || model !== activeModel`
on any layer; the reindex bar and its 统计中… indeterminate case; the coverage line shown ONLY when short.
Delete `ModelManager`, `LocalDisk`, `OtherModelField`, `PullProgress` and the measured table — all now in
`Models.tsx`. Add, where the table used to be:

```tsx
      <div className="mem-fine">
        下载 · 删除模型在「资源 · Resources」面板 —— 这里只决定每一层用哪个。
      </div>
```

- [ ] **Step 4: Build and drive it**

Run: `node devtools/dev.mjs build`, then `node devtools/dev.mjs server`, open `/manage` → 校准 → 记忆检索.
Check, in order: the three pills; 判断's toggle showing **both** backends with the unavailable one carrying
a sentence; 语义 under 高级 with one backend; binding 判断 → Claude CLI → `sonnet` producing the
restart banner; no download or delete button anywhere on this screen.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/screens/MemoryRecall.tsx src/client/src/styles.css
git commit -m "feat(console): each recall layer picks its backend from the ones that can serve it"
```

---

### Task 9: Docs, release notes, and the backlog line

**Files:**
- Modify: `CLAUDE.md`, `docs/release-notes/next.md`, `TASKS.md`, `docs/memory-recall-resharpen.md`

- [ ] **Step 1: `CLAUDE.md`** — replace the 记忆检索 paragraph's description of "three independent switches"
with the source model: layers own interfaces, backends implement them, 资源 owns provisioning, and adding a
backend is one class plus one line in `MemorySources`.

- [ ] **Step 2: `docs/release-notes/next.md`** — append a section in the existing voice covering: models
moved to 资源; each layer picks its backend from the ones that can serve it; 语义 under 高级 with Lyntai's
measurement attributed; and the judge-model bug that had no symptom.

- [ ] **Step 3: `TASKS.md`** — delete the `Resharpen 记忆检索 · Memory recall` backlog item. Add, under
Product (deferred), a line noting that `EmbeddedJudgeSource` / `EmbeddedSemanticSource` are now a one-class
addition, and cross-reference the existing Phase B item.

- [ ] **Step 4: `docs/memory-recall-resharpen.md`** — mark §2 and §3's first, second and fourth questions
answered, with the answers. Leave §3's third (Phase B interaction) open and point it at the new seam.

- [ ] **Step 5: Full verification before the last commit**

```bash
node devtools/dev.mjs build
node devtools/dev.mjs e2e p51
node devtools/scripts/check-sensitive.mjs --tree
```
Expected: `Build succeeded`, `e2e-p51 PASS`, sensitive scan clean. Then the wider fleet, which is ~13
minutes and must not be piped through `tail` (the output file stays 0 bytes):

```bash
node devtools/dev.mjs e2e all
```
Expected: all suites passing. `p17` / `p36` / `p43` / `p46` are the confirmed flake set — re-run any of
those solo before investigating.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs TASKS.md
git commit -m "docs(memory): record the per-layer source model and close the resharpen item"
```

---

## Self-Review

**Spec coverage.** 资源 owns runtimes + models → Tasks 4, 7. Per-layer toggle + model select → Tasks 5, 8.
`ISource`/`IProvider` per layer → Tasks 1, 2. 嵌入式 as a seam → `MemorySources` (Task 2 Step 4), asserted
by the `语义 offers only backends that can actually embed` row (Task 5). 语义 demoted on Lyntai's numbers,
attributed → Task 5 (`weighting`) + Task 8 Step 3. `/api/manage/models` split → Task 4. Capability filtering
rather than curated kind lists → `OllamaJudgeSource.Candidates` + `OllamaSemanticSource.ModelsAsync`.

**Gaps deliberately left.** No ONNX embedder (confirmed out of scope). No change to `chat` / `extract` /
`scorer` routing — they keep cortex's control, which the amended rule now describes accurately.

**Type consistency.** `MemorySourceContext(Ollama, Claude, Config)` is constructed identically in Tasks 4
and 5. `SourceStatus(Available, Reason, Suggest)` is consumed as `available`/`reason`/`suggest` in Tasks 5
and 8. `ModelOption(Id, Name, Installed, SizeBytes, Note, Measured, Vintage)` maps to the same JSON keys in
`ModelView` (Task 5) and `SourceView.models` (Task 8). `MemoryLayers.Judge`/`Semantic` are the same strings
the client sends. `MemoryJudgeWiring.Transport` carries a source id from Task 3 onward and is read as
`activeSource` in Task 5.

**One risk to watch.** Task 5's cortex assertion depends on Task 6. Land them together, or the suite is red
between two commits — which is a state this repo does not otherwise leave itself in.
