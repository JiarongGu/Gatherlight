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
/// <para><b>A WORKAROUND FOR A LYNTAI GAP — Lyntai <c>docs/task-archive.md</c> Part 284 / D176, closed the same
/// day it was filed.</b> <see cref="IModelRoutingStore.GetModelOverrideAsync"/> is RETIRED: a live override is
/// now a ROUTE, provider AND model together — <c>GetRouteAsync</c>, value <c>provider:model[, …]</c> — because
/// the model-only override this class works around let a key written for one binding reach a provider it was
/// never written for. D176: a route naming a provider THIS CONTAINER has not registered is ignored, with a
/// warning, and the given candidates serve — which is exactly the two situations this class exists for. After a
/// FALLBACK, <c>GatherlightApp</c> registers the FALLBACK-RESOLVED source (the CLI; see <c>ResolveJudge</c>), so
/// a stale route still naming the old runtime is never a registered provider this session; between a REBIND and
/// its restart, the newly-bound provider is equally unregistered until the restart that wires it. So — provided
/// the binding endpoint writes the route as <c>provider:model</c> rather than a bare model, which it has to on
/// the bump anyway — D176's own per-call check already does this class's job for both scenarios above.
/// (<c>claude-cli</c> is registered unconditionally, so a route naming it is never held back this way — correct,
/// since the CLI needs no restart to become servable.)</para>
///
/// <para><b>On the bump, this class stops COMPILING</b> — there is no <c>GetModelOverrideAsync</c> left to
/// override. So does <c>GatherlightApp.cs</c>'s <c>ModelKeyPrefix</c> use (~173, ~190 — renamed to
/// <c>RouteKeyPrefix</c>), and every <c>llm.model.&lt;consumer&gt;</c> key has to become a route —
/// <c>llm.route.&lt;consumer&gt;</c> = <c>provider:model[, …]</c> — across cortex's chat/extract/scorer keys AND
/// the memory binding's own writer (<c>MemoryRecallController.cs</c> ~550, which sets <c>llm.model.memory</c>
/// directly), with a migration for what is already stored: an old bare-model value under the retired prefix
/// reads as inert under the new one (D176's own rule for its <c>lyntai.model.</c> predecessor).
/// <c>MemoryService.cs</c> ~154 (the memory bundle's <c>SetModel</c> import, keyed on the <c>llm.model.</c>
/// prefix) and <c>BackupService.cs</c> ~242 (the backup's delete of <c>llm.model.memory</c>) touch the same keys
/// and need the same rename. Once the route write carries the provider: delete this class and its registration
/// in <c>GatherlightApp</c>, have the binding endpoint write the route directly, and confirm <c>e2e-p52</c>
/// case 4 — which fails TODAY with either half of this class's own fix removed; case 4b is a POSITIVE control,
/// catching a store that withholds UNCONDITIONALLY — still passes on the route mechanism alone before deleting
/// this class's own logic.</para>
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
