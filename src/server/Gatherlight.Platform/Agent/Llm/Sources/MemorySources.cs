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
        // ONE class in BOTH lists — the first backend to implement both layer interfaces, which is the
        // case this design was built for. Two instances, because the two layers may point at different
        // servers and each instance reads its own layer's address.
        // The SECOND class in both lists, and the runtime the app provisions as of 2026-08-22. Same
        // protocol as the entry above, opposite ownership — see LlamaCppSource.
        new LlamaCppSource(MemoryLayers.Judge),
    };

    public static readonly IReadOnlyList<IMemorySemanticSource> Semantic = new IMemorySemanticSource[]
    {
        // The CLI arm: no vectors, no local model, no GPU — it stores rephrasings at write time so a
        // differently-worded question still matches. One class plus one line, which is what this catalog is
        // shaped for, and it is what makes SemanticDeclined empty.
        new ClaudeCliSemanticSource(),
        new LlamaCppSource(MemoryLayers.Semantic),
        // 内置 — the one backend with NO prerequisite outside the app. Its arrival is what turned a
        // declined entry into a bindable one, which is exactly the "one class plus one line" this catalog
        // was shaped for.
        new BuiltInSemanticSource(),
    };

    /// <summary>Backends 判断 does not run on, with the reason. Listed on the layer anyway — see
    /// <see cref="DeclinedBackend"/> for why an unavailable option is shown rather than omitted. The one entry
    /// is NOT impossible, only unbuilt — its reason says so (<see cref="BuiltInCannotJudge"/>).</summary>
    public static readonly IReadOnlyList<DeclinedBackend> JudgeDeclined = new[]
    {
        new DeclinedBackend(MemoryBackends.BuiltIn, "ONNX", BuiltInCannotJudge,
            // Under 本机模型 alongside llama.cpp, which CAN judge — so the group is usable and this
            // member stops being a dead choice, it is just the arm of it that does not serve here.
            MemoryGroups.Managed),
    };

    /// <summary>Backends 语义 cannot run on. EMPTY, and that is the point.
    ///
    /// <para>Claude used to be here with a paragraph explaining that it ships no embeddings endpoint, so the
    /// layer "could not have it". True about embeddings and false as a conclusion: the layer was defined as
    /// embeddings BY US, which made it unavailable on precisely the machines that cannot run a local model.
    /// <see cref="ClaudeCliSemanticSource"/> serves the layer's actual job — a paraphrase finds the fact —
    /// by storing rephrasings instead of vectors, so there is nothing left to decline and nothing left to
    /// explain. A declined entry is the right shape for a real impossibility; it is the wrong shape for an
    /// option nobody had built.</para></summary>
    public static readonly IReadOnlyList<DeclinedBackend> SemanticDeclined = Array.Empty<DeclinedBackend>();

    /// <summary>Why 内置 does not judge — and it is NOT an impossibility any more, which is what this sentence
    /// has to say.
    ///
    /// <para><b>It used to open 「判断需要一个能对话的模型」, and this branch made that false.</b> A reranker judges
    /// now — it VERIFIES, and tagging stays on the CLI — and Lyntai 3.2.0 ships an in-process ONNX
    /// cross-encoder (<c>AddOnnxProvider</c> with <c>Produces = Score</c>, its D157). So an in-process verifier
    /// for 判断 is BUILDABLE, the same shape as the llama.cpp reranker. It was not built, for a measured reason
    /// recorded in <c>docs/superpowers/specs/2026-09-23-reranker-judge-and-verdict-bench-design.md</c>
    /// §Constraints: that path reads WordPiece tokenizers only, so the one model proven through it
    /// (ms-marco-MiniLM-L6-v2) is English-only — +3.0 of 9.5 on Lyntai's English LoCoMo (2026-09-15,
    /// nomic-embed-text, base 83.0%), −5.4 on multi-hop —
    /// while the multilingual rerankers (LAMAR, BGE) are SentencePiece, which is why they run on llama.cpp.
    /// By dev-conventions' own rule this is "an option nobody built", so it says that and why, and does not
    /// steer: it names where the multilingual ones run and that tagging would need the CLI either way.</para>
    ///
    /// <para>Earlier rewrites, still true as rules: it once said a local model meant installing Ollama
    /// yourself (false since the app provisions llama.cpp, 2026-08-22), and it once called the group 「内置」,
    /// the word that now names this very arm.</para></summary>
    private const string BuiltInCannotJudge =
        "「判断」也可以用重排模型来做,但「内置」这条还没做:应用内直接运行的方式目前读不了多语言重排模型的格式,"
        + "验证过的唯一一个只懂英文。支持中文的重排模型在同一组「本机模型」里的 llama.cpp 上运行。"
        + "无论哪种,写入事实时的主题标注都由 Claude CLI 完成。";

    public const string DefaultJudgeSource = "claude-cli";

    /// <summary>The CLI arm's default model. Cheap on purpose: this seam runs on every write and every
    /// recall, so it is the app's most frequent model call by a wide margin.</summary>
    public const string DefaultJudgeModel = "haiku";

    /// <summary>What TAGGING costs when the bound judge only CHECKS — a reranker scores and never generates, so
    /// every fact write is annotated by the Claude CLI instead. ONE writer for the clause, because three
    /// surfaces carry it at three moments of one decision: the reranker's model note (while choosing), the
    /// bind toast (on choosing) and the bound cost line (afterwards).
    ///
    /// <para><b>The quota half was missing from all three.</b> Each said the checking is 不消耗账号额度 and
    /// that the content goes to Claude, and none said the tagging SPENDS the account — so the only quota
    /// statement a household read about this binding was the reassuring one. The CLI arm's own cost line has
    /// always said it uses the signed-in account; this is that fact, for the half that stays on the CLI.
    /// <c>e2e-p52</c> case 5 pins it in all three.</para></summary>
    public const string CliTaggingCost = "每条事实一次调用,消耗账号额度,事实内容会发给 Claude";

    /// <summary>Where a checks-only judge's TAGGING stands NOW, read from the CLI's CACHED probe — or null
    /// when nothing has probed it yet, in which case the caller says nothing rather than guess.
    ///
    /// <para><b>Why it has to be said at all.</b> A reranker binding moves tagging to the Claude CLI, and a CLI
    /// that is signed out or missing means ZERO tagging: the annotation policy is fail-open, so every fact is
    /// written unlabelled and nothing anywhere reports it. The row's status, the bind toast and the startup
    /// warning all used to assert the tagging "carries on" regardless.</para>
    ///
    /// <para><b>Cached, never probed here</b> — a panel must not await a process (dev-conventions). Something
    /// else keeps it current: the startup <c>ClaudeRuntimeStep</c>, and the CLI arm's own status on every
    /// 记忆检索 load.</para></summary>
    public static TaggingState? CliTaggingNow(Services.ClaudeCliState? cli) =>
        cli is null ? null
        : !cli.Runnable
            ? new(false, "写入事实时的主题标注要用 Claude CLI,但这台机器上现在没有可运行的 CLI —— 装好并登录之前,"
                + "新写入的事实不会被标注;检索时的核对照常。可在「资源 · Resources」面板安装。",
                "这台机器上没有可运行的 Claude CLI")
        : !cli.LoggedIn
            ? new(false, "写入事实时的主题标注要用 Claude CLI,但它现在还没有登录 —— 登录之前,新写入的事实不会被"
                + "标注;检索时的核对照常。在「资源」面板点「登录」。",
                "Claude CLI 还没有登录")
        : new(true, "写入事实时的主题标注由 Claude CLI 完成(已登录)。", null);

    /// <summary>Both lookups go through <see cref="MemoryBackends.Canonical"/>, so an install still
    /// naming the removed <c>ollama</c> backend resolves to the generic one instead of falling through to a
    /// default — which for 判断 would silently move the household to the CLI and for 语义 would turn the
    /// layer off.</summary>
    public static IMemoryJudgeSource? FindJudge(string? id) =>
        Judge.FirstOrDefault(s =>
            string.Equals(s.Id, MemoryBackends.Canonical(id), StringComparison.OrdinalIgnoreCase));

    public static IMemorySemanticSource? FindSemantic(string? id) =>
        Semantic.FirstOrDefault(s =>
            string.Equals(s.Id, MemoryBackends.Canonical(id), StringComparison.OrdinalIgnoreCase));

    /// <summary>Which source 判断 is bound to, honouring the pre-2026-08-21 <c>JudgeTransport</c> key.
    ///
    /// <para>Read-side compatibility rather than a migration step: an existing settings.json keeps working
    /// untouched and the first write through the console replaces it. A migration would have to run before
    /// the DB opens — which is exactly where this value is consumed — and would gain nothing over these
    /// three lines.</para></summary>
    public static IMemoryJudgeSource ResolveJudge(MemorySourceSettings s)
    {
        var id = SavedJudgeSource(s.Config) ?? DefaultJudgeSource;

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
    /// <para><b>The saved model belongs to the SAVED source, and only counts when that is the source that
    /// resolved.</b> A settings.json carrying <see cref="MemoryConfig.JudgeSource"/> was written by the
    /// binding endpoint, which always writes source and model TOGETHER — so the pair is trustworthy, but only
    /// as a pair. When <see cref="ResolveJudge"/> falls back (the runtime was deleted, the model file is
    /// gone), the source that runs is the CLI while the saved model is still, say, a GGUF id; reading it
    /// anyway handed that id to Claude and put it on the badge as <c>claude-cli · &lt;gguf&gt;</c>. The
    /// legacy trap above is the same rule with no saved source at all.</para></summary>
    public static string? ResolveJudgeModel(MemorySourceSettings s)
    {
        var source = ResolveJudge(s);
        var model = SavedIs(s.Config, source.Id) ? s.Config.JudgeModel : null;

        return source.Id == DefaultJudgeSource
            ? (string.IsNullOrWhiteSpace(model) ? DefaultJudgeModel : model)
            : model;
    }

    /// <summary>The source the settings NAME for 判断 — the binding endpoint's <see cref="MemoryConfig.JudgeSource"/>,
    /// or the pre-2026-08-21 <c>JudgeTransport: local</c>, which meant Ollama. Null when they name none: an
    /// install that never bound the layer, or a legacy CLI one, whose <c>JudgeModel</c> belonged to the local
    /// arm and names nothing here.</summary>
    public static string? SavedJudgeSource(MemoryConfig c) =>
        !string.IsNullOrWhiteSpace(c.JudgeSource) ? c.JudgeSource
        : string.Equals(c.JudgeTransport, "local", StringComparison.OrdinalIgnoreCase) ? MemoryBackends.Ollama
        : null;

    /// <summary>Do the settings NAME the source whose id is <paramref name="sourceId"/>? False after a
    /// FALLBACK — and false in the window between binding another source and the restart that wires it.
    /// Either way, what was written for the saved source (its model, and the live <c>llm.model.memory</c> the
    /// binding wrote beside it) describes a backend that is not the one answering. Also false when nothing is
    /// saved; a caller for whom that case means "the default" says so itself.</summary>
    public static bool SavedIs(MemoryConfig c, string sourceId) =>
        SavedJudgeSource(c) is { } saved
        && string.Equals(MemoryBackends.Canonical(saved), sourceId, StringComparison.OrdinalIgnoreCase);

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

/// <summary>Whether a checks-only judge's tagging is happening now, and the sentence that says so — see
/// <see cref="MemorySources.CliTaggingNow"/>.</summary>
/// <param name="Works">False means NO tagging until the CLI is fixed — the case that used to go unsaid.</param>
/// <param name="Text">The whole sentence, for a surface where the checking is running (the panel, the toast).</param>
/// <param name="Why">Just the cause, for a surface that says something else about the checking — the startup
/// warning, where llama.cpp is down and "checking carries on" would be false. Null when it works.</param>
public sealed record TaggingState(bool Works, string Text, string? Why);
