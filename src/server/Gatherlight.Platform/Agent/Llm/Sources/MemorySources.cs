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
/// <para><b>Adding a backend is one class plus one line here.</b> An embedded ONNX embedder appears in
/// 语义's toggle the moment <c>new EmbeddedSemanticSource()</c> joins <see cref="Semantic"/> — no controller
/// change, no client change, no capability table to keep in step.</para>
///
/// <para><b>Two lists, not one filtered list.</b> That is what keeps the CLI out of 语义: there is nothing
/// to filter, because a source that cannot embed is not in the semantic list and cannot be added to it
/// without implementing <see cref="IMemorySemanticSource"/>.</para>
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
    public static IMemoryJudgeSource ResolveJudge(MemoryConfig c)
    {
        var id = !string.IsNullOrWhiteSpace(c.JudgeSource) ? c.JudgeSource
            : string.Equals(c.JudgeTransport, "local", StringComparison.OrdinalIgnoreCase) ? "ollama"
            : DefaultJudgeSource;
        // Falls back to the first source rather than throwing: a settings.json naming a backend this build
        // does not have (a downgrade, a hand edit) must come up on the default, not refuse to start.
        return FindJudge(id) ?? Judge[0];
    }

    /// <summary>The model 判断 is bound to. The CLI arm has a default; the local arm cannot have one,
    /// because a machine-specific model is not something a release can guess.</summary>
    public static string? ResolveJudgeModel(MemoryConfig c)
    {
        var source = ResolveJudge(c);
        return source.Id == DefaultJudgeSource
            ? (string.IsNullOrWhiteSpace(c.JudgeModel) ? DefaultJudgeModel : c.JudgeModel)
            : c.JudgeModel;
    }

    /// <summary>Which source 语义 is bound to, or null when the layer is off — honouring the legacy
    /// <c>SemanticEnabled</c> flag the same way.
    /// <para>A model with no source is a REMEMBERED choice, not an active one: turning the layer off leaves
    /// the model and its vectors alone, so switching it back on does not cost the download and the reindex
    /// a second time.</para></summary>
    public static IMemorySemanticSource? ResolveSemantic(MemoryConfig c)
    {
        if (string.IsNullOrWhiteSpace(c.EmbeddingModel)) return null;
        if (!string.IsNullOrWhiteSpace(c.SemanticSource)) return FindSemantic(c.SemanticSource);
        return c.SemanticEnabled ? FindSemantic("ollama") : null;
    }
}
