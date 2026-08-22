using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// Every backend that can serve a recall layer, in one static list — the shape
/// <c>CortexConfigService.ModelCatalog</c> and <c>PromptHarness.Catalog</c> already use.
///
/// <para><b>Why static rather than a DI collection.</b> The wiring happens inside <c>AddLyntai(b =&gt; …)</c>,
/// while the container is being BUILT — there is nothing to resolve from yet. A DI collection would
/// therefore need a second, registration-time list beside it, and two lists for one set is precisely the
/// drift <c>check-ui-registry</c> exists to catch elsewhere. Sources take their runtime dependencies as a
/// per-call <see cref="MemorySourceContext"/> instead: one parameter, one list.</para>
///
/// <para><b>Adding a backend is one class plus one line here.</b> A built-in runtime appears in 语义's
/// toggle the moment a <c>BuiltInSemanticSource</c> joins <see cref="Semantic"/> — and drops out of
/// <see cref="SemanticDeclined"/> at the same time. No controller change, no client change, no capability
/// table to keep in step.</para>
///
/// <para><b>Bindable and declined are two lists, not one list with a flag.</b> What a layer CAN be bound to
/// is decided by which classes implement its interface — there is nothing to filter, and no predicate to
/// get wrong. What it cannot be bound to is stated in prose beside it, because those reasons are VENDOR
/// facts (no embeddings endpoint; not shipped yet) rather than anything the type system knows. Both are
/// shown: a layer that silently omits an impossible option answers "why isn't this here?" only in the
/// source tree.</para>
/// </summary>
public static class MemorySources
{
    public static readonly IReadOnlyList<IMemoryJudgeSource> Judge = new IMemoryJudgeSource[]
    {
        new ClaudeCliJudgeSource(),
        new OllamaJudgeSource(),
        // ONE class in BOTH lists — the first backend to implement both layer interfaces, which is the
        // case this design was built for. Two instances, because the two layers may point at different
        // servers and each instance reads its own layer's address.
        new OpenAiCompatibleSource(MemoryLayers.Judge),
        // The SECOND class in both lists, and the runtime the app provisions as of 2026-08-22. Same
        // protocol as the entry above, opposite ownership — see LlamaCppSource.
        new LlamaCppSource(MemoryLayers.Judge),
    };

    public static readonly IReadOnlyList<IMemorySemanticSource> Semantic = new IMemorySemanticSource[]
    {
        new OllamaSemanticSource(),
        new OpenAiCompatibleSource(MemoryLayers.Semantic),
        new LlamaCppSource(MemoryLayers.Semantic),
        // 内置 — the one backend with NO prerequisite outside the app. Its arrival is what turned a
        // declined entry into a bindable one, which is exactly the "one class plus one line" this catalog
        // was shaped for.
        new BuiltInSemanticSource(),
    };

    /// <summary>Backends 判断 cannot run on, with the reason. Listed on the layer anyway — see
    /// <see cref="DeclinedBackend"/> for why an impossible option is shown rather than omitted.</summary>
    public static readonly IReadOnlyList<DeclinedBackend> JudgeDeclined = new[]
    {
        new DeclinedBackend(MemoryBackends.BuiltIn, "内置(随应用附带)", BuiltInNotYet),
    };

    /// <summary>Backends 语义 cannot run on, with the reason. <b>The built-in runtime is NO LONGER here</b> —
    /// it shipped for this layer, so it moved from this list into <see cref="Semantic"/>. It stays declined
    /// for 判断, which would need an in-process CHAT model (a much larger thing than an embedder).</summary>
    public static readonly IReadOnlyList<DeclinedBackend> SemanticDeclined = new[]
    {
        new DeclinedBackend(MemoryBackends.ClaudeCli, "Claude CLI",
            "Claude 不提供嵌入接口 —— 它生成文字,不生成向量,所以这一层没有它。"
            + "但这不代表 Claude 帮不上按语义找东西:Lyntai 实测里,把「答对了却排在后面」捞上来的"
            + "主要是「判断」那一层(漏检 0.54 → 0.19)—— 想让改写过的问法也能问到,先开「判断」更划算。"),
    };

    /// <summary>One sentence, shared: the two layers decline it for the same reason, and saying it twice in
    /// two wordings would let them drift into looking like two different limitations.</summary>
    private const string BuiltInNotYet =
        "还没有随应用附带的模型运行时 —— 现在本机模型都跑在 Ollama 上,要单独装。"
        + "这一项做好之后会自动出现在这里,不需要改任何设置。";

    public const string DefaultJudgeSource = "claude-cli";

    /// <summary>The CLI arm's default model. Cheap on purpose: this seam runs on every write and every
    /// recall, so it is the app's most frequent model call by a wide margin.</summary>
    public const string DefaultJudgeModel = "haiku";

    public static IMemoryJudgeSource? FindJudge(string? id) =>
        Judge.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.OrdinalIgnoreCase));

    public static IMemorySemanticSource? FindSemantic(string? id) =>
        Semantic.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>Which source 判断 is bound to, honouring the pre-2026-08-21 <c>JudgeTransport</c> key.
    ///
    /// <para>Read-side compatibility rather than a migration step: an existing settings.json keeps working
    /// untouched and the first write through the console replaces it. A migration would have to run before
    /// the DB opens — which is exactly where this value is consumed — and would gain nothing over these
    /// three lines.</para></summary>
    public static IMemoryJudgeSource ResolveJudge(MemorySourceSettings s)
    {
        var id = !string.IsNullOrWhiteSpace(s.Config.JudgeSource) ? s.Config.JudgeSource
            : string.Equals(s.Config.JudgeTransport, "local", StringComparison.OrdinalIgnoreCase) ? "ollama"
            : DefaultJudgeSource;

        // A non-default source with NO model is half-configured, and the half that is missing is the one
        // with no sensible default: a machine-specific model is not something a release can guess. Falling
        // back to the CLI keeps the layer working instead of wiring a provider against whatever the model
        // default happens to be — which is how "haiku" would reach an Ollama that has never heard of it.
        if (id != DefaultJudgeSource && string.IsNullOrWhiteSpace(s.Config.JudgeModel)) id = DefaultJudgeSource;

        // Falls back to the first source rather than throwing: a settings.json naming a backend this build
        // does not have (a downgrade, a hand edit) must come up on the default, not refuse to start.
        var source = FindJudge(id) ?? Judge[0];

        // …and the same fallback for a backend whose OWN configuration is incomplete — a typed endpoint
        // that is absent or refused. Asked of the source rather than switched on its id, so a future
        // backend with its own prerequisites needs no edit here.
        return source.IsConfigured(s) ? source : (FindJudge(DefaultJudgeSource) ?? Judge[0]);
    }

    /// <summary>The model 判断 is bound to. The CLI arm has a default; the local arm cannot have one,
    /// because a machine-specific model is not something a release can guess.
    ///
    /// <para><b>The legacy trap, found on a real data folder and not by the fixture.</b> Before the source
    /// model, <c>JudgeModel</c> belonged to the LOCAL arm alone, and the old switch deliberately REMEMBERED
    /// it when moving back to the CLI — "going back should not throw away a choice that cost a download".
    /// So an install written before 2026-08-22 can hold <c>transport: cli</c> beside
    /// <c>judgeModel: gemma3:4b</c>. Reading that as the CLI's model hands an Ollama model id to Claude and
    /// writes it into <c>DefaultModelByConsumer</c> — the exact mirror of the two-writers bug this pass
    /// removed, pointing the other way, and just as silent because the policies are fail-open. It showed up
    /// as a badge reading <c>Claude CLI · gemma3:4b</c>.</para>
    ///
    /// <para>A settings.json carrying <see cref="MemoryConfig.JudgeSource"/> was written by the binding
    /// endpoint, which always writes source and model TOGETHER, so that pair is trustworthy. Only the
    /// legacy shape needs the guard.</para></summary>
    public static string? ResolveJudgeModel(MemorySourceSettings s)
    {
        var source = ResolveJudge(s);
        var paired = !string.IsNullOrWhiteSpace(s.Config.JudgeSource)
            || string.Equals(s.Config.JudgeTransport, "local", StringComparison.OrdinalIgnoreCase);
        var model = paired ? s.Config.JudgeModel : null;

        return source.Id == DefaultJudgeSource
            ? (string.IsNullOrWhiteSpace(model) ? DefaultJudgeModel : model)
            : model;
    }

    /// <summary>Which source 语义 is bound to, or null when the layer is off — honouring the legacy
    /// <c>SemanticEnabled</c> flag the same way.
    /// <para>A model with no source is a REMEMBERED choice, not an active one: turning the layer off leaves
    /// the model and its vectors alone, so switching it back on does not cost the download and the reindex
    /// a second time.</para></summary>
    public static IMemorySemanticSource? ResolveSemantic(MemorySourceSettings s)
    {
        if (string.IsNullOrWhiteSpace(s.Config.EmbeddingModel)) return null;
        var source = !string.IsNullOrWhiteSpace(s.Config.SemanticSource)
            ? FindSemantic(s.Config.SemanticSource)
            : s.Config.SemanticEnabled ? FindSemantic(MemoryBackends.Ollama) : null;

        // Incomplete = OFF, not "wire it and hope". Unlike 判断 there is nothing to fall back TO here: a
        // second-best embedder would write vectors of a different width, which is worse than no layer.
        return source is not null && source.IsConfigured(s) ? source : null;
    }
}
