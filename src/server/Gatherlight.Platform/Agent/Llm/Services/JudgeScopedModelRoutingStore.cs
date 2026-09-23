using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Kernel.Services;
using Lyntai.Inference;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// Lyntai's live model routing, except that the memory judge's override (<c>llm.model.memory</c>) is
/// consulted only while it names a model for the client that is actually annotating.
///
/// <para><b>Why the key can describe a judge that is not running.</b> The binding endpoint writes that key
/// together with settings.json, and it outranks <c>DefaultModelByConsumer["memory"]</c> — the model the
/// running wiring was built with. So a key written for one binding is read by a different one in two
/// situations: after a FALLBACK (a chat GGUF was bound, then the runtime was deleted; <c>ResolveJudge</c>
/// falls back to the CLI, and the CLI was asked for the GGUF's id), and between binding another client and
/// the restart that wires it. Both memory policies are fail-open, so either one is zero enrichment and no
/// error.</para>
///
/// <para><b>Compared by annotation CLIENT, not by source id.</b> The client decides which backend a model
/// name is sent to, so it is the thing the key has to agree with: one source can annotate through two
/// clients (llama.cpp's named client for a chat model, the default CLI client for a reranker), and two
/// sources can share one (the CLI arm and a reranker both annotate on the default client, where the key a
/// reranker binding writes — the CLI's model — is exactly right even after its runtime vanished).</para>
///
/// <para>Withholding the override is not a new state: the router then resolves the model the running wiring
/// was built with. The policies' own <c>Model</c> stays null, so nothing is pinned at registration.</para>
///
/// <para>Registered BEFORE <c>AddLiveModelRouting()</c>, whose <c>TryAddSingleton</c> then stands down.</para>
///
/// <para><b>A WORKAROUND FOR A LYNTAI GAP, and the Lyntai half is not filed yet.</b> The live override is keyed
/// by CONSUMER alone (<see cref="IModelRoutingStore.GetModelOverrideAsync"/> takes nothing else), so the library
/// cannot know which client or provider a model name was written for. What it would need: a live override
/// scoped to the client (or provider) it names, written with that scope and consulted only for it. When a
/// release has that, delete this class and its registration in <c>GatherlightApp</c>, have the binding endpoint
/// write the scoped key, and keep <c>e2e-p52</c> case 4 green. Until the request is in Lyntai's
/// <c>TASKS.md</c>, a release could close the gap silently and this would keep running beside it
/// (dev-conventions: a workaround is recorded on both sides).</para>
/// </summary>
public sealed class JudgeScopedModelRoutingStore : IModelRoutingStore
{
    private readonly IModelRoutingStore _inner;
    private readonly ServerConfigService _config;
    private readonly IPlatformContext _platform;
    private readonly string? _runningAnnotationClient;

    /// <param name="runningAnnotationClient">The client the RUNNING judge annotates through —
    /// <c>JudgeWiring.AnnotationClient</c> as the container was built (null = the default client).</param>
    public JudgeScopedModelRoutingStore(IModelRoutingStore inner, ServerConfigService config,
        IPlatformContext platform, string? runningAnnotationClient)
    {
        _inner = inner;
        _config = config;
        _platform = platform;
        _runningAnnotationClient = runningAnnotationClient;
    }

    public Task<string?> GetModelOverrideAsync(string consumer, CancellationToken ct = default) =>
        string.Equals(consumer, ProviderConsumers.Memory, StringComparison.OrdinalIgnoreCase)
        && !SavedBindingMatchesRunning()
            ? Task.FromResult<string?>(null)
            : _inner.GetModelOverrideAsync(consumer, ct);

    /// <summary>Would the SAVED binding annotate through the client that is running? Asked of the saved
    /// source's own wiring, so the rule "a reranker tags on the CLI" stays written once, in the source.</summary>
    private bool SavedBindingMatchesRunning()
    {
        var c = _config.Current.Memory;
        // Nothing bound since the source model existed: the default runs, and only it could have written a key.
        if (MemorySources.SavedJudgeSource(c) is not { } savedId) return true;

        // A retired or unknown backend has no client at all, so nothing written for it fits the running one.
        var saved = MemorySources.FindJudge(savedId);
        var model = !string.IsNullOrWhiteSpace(c.JudgeModel) ? c.JudgeModel
            : saved?.Id == MemorySources.DefaultJudgeSource ? MemorySources.DefaultJudgeModel : null;
        if (saved is null || model is null) return false;

        var settings = new MemorySourceSettings(c, _platform.ResourcesPath);
        var wiring = saved.Wiring(new MemoryWiringContext(model, saved.Endpoint(settings) ?? "", settings));
        return string.Equals(wiring.AnnotationClient, _runningAnnotationClient, StringComparison.Ordinal);
    }
}
