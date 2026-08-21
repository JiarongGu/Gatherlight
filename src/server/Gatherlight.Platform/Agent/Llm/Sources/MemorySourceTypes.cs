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

/// <summary>Every backend a recall layer could conceivably run on — WHERE the model comes from, which is
/// the distinction the household actually makes.
///
/// <para><b>All three are listed on every layer</b>, whether or not that layer can use them. A layer
/// showing one button and no explanation for the absent ones is the dead-control failure this surface
/// exists to end, one level up: "there is no class implementing it" is an answer only the source tree
/// gives.</para></summary>
public static class MemoryBackends
{
    /// <summary>The authenticated Claude CLI — a provisioned resource, run as a process.</summary>
    public const string ClaudeCli = "claude-cli";

    /// <summary>An Ollama on this machine, whether the household's own or the copy the app provisioned.
    /// One daemon on one port serves both layers; only the model differs. It gets its own backend not
    /// because it is special as a runtime — it speaks the same API as the one below — but because the app
    /// MANAGES it: listing, pulling and deleting models is what 资源's buttons rest on.</summary>
    public const string Ollama = "ollama";

    /// <summary>Any other local runtime speaking the OpenAI-compatible API — llama.cpp's llama-server,
    /// LM Studio, vLLM, Jan, LocalAI. The household supplies the address and brings their own models; we
    /// cannot download or delete anything there, and the picker says so.</summary>
    public const string OpenAiCompatible = "openai-compat";

    /// <summary>A model runtime shipped INSIDE the install (<c>res/</c>) rather than found on the machine —
    /// nothing to install, nothing to keep running. Nothing implements it yet; it is listed anyway, with
    /// that as its reason, so the option is visible before it is available.</summary>
    public const string BuiltIn = "builtin";
}

/// <summary>A backend a layer CANNOT run on, and why — stated rather than derived.
///
/// <para><b>Why this exists at all.</b> Leaving an impossible backend out of the list is the failure this
/// surface exists to end, one level up: a household looking at 语义 with a single button cannot discover
/// why Claude is not an option, and "there is no class for it" is an answer only the source tree gives.
/// The reasons are VENDOR facts — Anthropic ships no embeddings endpoint; Ollama refuses a chat model an
/// embedding call and an embedding model a chat call (verified 2026-08-21, both directions) — so they are
/// written down here, not computed from a capability table that would drift from them.</para>
///
/// <para>A declined backend is never bindable: it has no source, so there is nothing to bind. That is why
/// this is a separate list rather than a flag on <see cref="SourceStatus"/> — a shape that cannot be
/// selected should not be reachable through the type that selects things.</para></summary>
public sealed record DeclinedBackend(string Id, string Name, string Reason);

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
/// <param name="Endpoint">Where this backend talks, already resolved and loopback-checked by the source
/// that owns that address (<c>IMemorySource.Endpoint</c>) — <see cref="OllamaRuntime.ResolveBaseUrl"/> for
/// the Ollama arm, <c>OpenAiCompatibleSource.ResolveLocal</c> for a household-supplied one. ONE place
/// answers "where does this backend talk", which is what stops an install embedding against one host while
/// reporting another. Empty for a backend that is a process rather than a URL.</param>
public sealed record MemoryWiringContext(string Model, string Endpoint);
