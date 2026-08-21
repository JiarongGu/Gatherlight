using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>The layer ids, in one place. They are stored in settings.json and appear in URLs, so a typo
/// would produce a silently unbindable layer rather than a compile error.</summary>
public static class MemoryLayers
{
    public const string Formula = "formula";
    public const string Judge = "judge";
    public const string Semantic = "semantic";
}

/// <summary>Whether a source can serve its layer on THIS machine right now, and the one sentence the
/// household reads when it cannot.
///
/// <para><see cref="Suggest"/> names a model the panel may offer to fetch, when the fix IS a download.
/// It exists because the alternative — printing a shell command at a household sitting in front of a
/// console that downloads models — draws a line the system does not have.</para>
///
/// <para><b>An unavailable source is still LISTED.</b> Dropping it would answer "why can't I pick this?"
/// by making the question unaskable, which is the dead-control failure this whole surface exists to end:
/// the previous panel disabled 本机模型 with no explanation while listing, three inches below, the very
/// models the household was wondering about.</para></summary>
public sealed record SourceStatus(bool Available, string? Reason = null, string? Suggest = null)
{
    public static readonly SourceStatus Ready = new(true);
}

/// <summary>One model a source offers for its layer.
///
/// <para><see cref="Installed"/> false means it is offerable but must be fetched first — 资源 owns that.
/// <see cref="Measured"/> is null for anything nobody benchmarked, which the UI must SAY rather than leave
/// blank: an empty cell in a comparison table reads as a zero.</para></summary>
public sealed record ModelOption(
    string Id,
    string Name,
    bool Installed,
    long? SizeBytes = null,
    string? Note = null,
    EmbeddingMeasurement? Measured = null,
    string? Vintage = null);

/// <summary>What a source needs to ANSWER questions at runtime.
///
/// <para>Passed per call rather than injected, so a source can be a stateless instance in a static
/// catalog — which is what lets ONE list serve <c>GatherlightApp</c> before the container exists and the
/// console after it. Two lists for one set is the drift this arrangement is built to avoid.</para></summary>
public sealed record MemorySourceContext(
    IOllamaRuntime Ollama,
    IClaudeCliRuntime Claude,
    MemoryConfig Config);

/// <summary>What a source needs to REGISTER itself at startup. No DI and no container — only the two facts
/// a backend registration turns on.</summary>
/// <param name="Model">The model this layer is bound to.</param>
/// <param name="OllamaUrl">Already resolved through <see cref="OllamaRuntime.ResolveBaseUrl"/>, so a source
/// never re-derives it: two answers for one endpoint is how an install ends up embedding against one host
/// and reporting another.</param>
public sealed record MemoryWiringContext(string Model, string OllamaUrl);
