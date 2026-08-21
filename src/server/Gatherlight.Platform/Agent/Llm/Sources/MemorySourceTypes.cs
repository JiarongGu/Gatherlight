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
    /// nothing to install, nothing to keep running.</summary>
    public const string BuiltIn = "builtin";

    /// <summary>The order every layer lists them in — FIXED, and deliberately not "usable ones first".
    ///
    /// <para>Sorting by status looked more actionable and cost more than it bought: the same four labels
    /// appeared in different positions on 判断 and 语义, so a household could never learn where a backend
    /// sits. Position is a landmark; whether an option is usable is carried by how it is DRAWN (muted, and
    /// with its reason on selection), which is a job styling does better than ordering.</para>
    ///
    /// <para>Cheapest first, in the sense of what the household has to have: the account they already use,
    /// then a daemon, then a daemon they must configure, then a download.</para></summary>
    private static readonly string[] Ordered = { ClaudeCli, Ollama, OpenAiCompatible, BuiltIn };

    public static IReadOnlyList<string> Order => Ordered;

    /// <summary>Where an id sits in <see cref="Order"/>; anything unlisted sorts LAST rather than throwing,
    /// so a backend added without touching this line still appears — just at the end.</summary>
    public static int Rank(string id)
    {
        var i = Array.IndexOf(Ordered, id);
        return i < 0 ? int.MaxValue : i;
    }
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

/// <summary>The facts a source needs to answer the two STARTUP questions — where it talks, and whether it
/// is configured enough to be wired.
///
/// <para>Separate from <see cref="MemorySourceContext"/> because those questions are asked from inside
/// <c>AddLyntai(b =&gt; …)</c>, while the container is being built: there is no <c>IOllamaRuntime</c> to
/// hand over yet. Passing a context with nulls in it would compile and then quietly depend on nobody
/// calling the wrong member; two types make the difference structural.</para>
///
/// <para><see cref="ResourcesPath"/> is here because a backend's readiness is not always a config value —
/// the built-in embedder's is "are 197 MB of weights on disk", which is a filesystem fact.</para></summary>
public sealed record MemorySourceSettings(MemoryConfig Config, string ResourcesPath);

/// <summary>What a source needs to ANSWER questions at runtime.
///
/// <para>Passed per call rather than injected, so a source can be a stateless instance in a static
/// catalog — which is what lets ONE list serve <c>GatherlightApp</c> before the container exists and the
/// console after it. Two lists for one set is the drift this arrangement is built to avoid.</para></summary>
public sealed record MemorySourceContext(
    IOllamaRuntime Ollama,
    IClaudeCliRuntime Claude,
    MemorySourceSettings Settings)
{
    public MemoryConfig Config => Settings.Config;
}

/// <summary>What a source needs to REGISTER itself at startup. No DI and no container — only the two facts
/// a backend registration turns on.</summary>
/// <param name="Model">The model this layer is bound to.</param>
/// <param name="Endpoint">Where this backend talks, already resolved and loopback-checked by the source
/// that owns that address (<c>IMemorySource.Endpoint</c>) — <see cref="OllamaRuntime.ResolveBaseUrl"/> for
/// the Ollama arm, <c>OpenAiCompatibleSource.ResolveLocal</c> for a household-supplied one. ONE place
/// answers "where does this backend talk", which is what stops an install embedding against one host while
/// reporting another. Empty for a backend that is a process rather than a URL.</param>
/// <param name="Settings">The same startup facts <see cref="IMemorySource.IsConfigured"/> was asked about,
/// carried through so a backend that needs more than a URL — the built-in embedder needs the resources
/// path — does not force a new parameter onto every source that does not.</param>
public sealed record MemoryWiringContext(string Model, string Endpoint, MemorySourceSettings Settings);
