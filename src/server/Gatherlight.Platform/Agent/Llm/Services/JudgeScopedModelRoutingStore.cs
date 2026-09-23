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
/// never written for. D176: a route naming a provider THIS ROUTER does not hold is ignored, with a warning, and
/// the given candidates serve — <c>TextRouter.LiveRouteAsync</c> checks its OWN <c>_byId</c>, built from the
/// providers THAT router was constructed with, never every provider the container knows. That is exactly the
/// two situations this class exists for: after a FALLBACK, <c>GatherlightApp</c> registers the
/// FALLBACK-RESOLVED source (the CLI; see <c>ResolveJudge</c>), so a stale route still naming the old runtime
/// names a provider no router built this session holds; between a REBIND and its restart, the newly-bound
/// provider is equally unheld until the restart that wires it.</para>
///
/// <para><b>The reverse direction holds too, and it is worth stating precisely rather than waving at
/// "<c>claude-cli</c> is always registered" — which is true of the DEFAULT client's router and false of the one
/// this judge actually calls through.</b> A chat-GGUF judge's annotation runs on its OWN named client,
/// <c>memory-llamacpp</c> (<c>LlamaCppSource.ClientId</c>), whose router is narrowed to exactly
/// <c>llamacpp</c> (<c>UseProviders(ProviderId)</c>) — Lyntai builds one <c>TextRouter</c> PER named client,
/// holding only its declared ids, and only the DEFAULT client's router holds every registered provider. So
/// while that GGUF is running and the household rebinds to the CLI WITHOUT restarting, a stale
/// <c>claude-cli:…</c> route is checked against <c>memory-llamacpp</c>'s router — which does not hold
/// <c>claude-cli</c> either — so it too is held back, and the RUNNING GGUF keeps annotating. That is the
/// correct, SAFE outcome (no silent mid-session jump to a backend before the restart that actually wires it),
/// and it is what makes the redundancy argument hold in BOTH directions, not only the one where the target is
/// unheld.</para>
///
/// <para><b>Two caveats.</b> The argument depends on the judge's chat provider id, <c>llamacpp</c>, staying
/// distinct from the embedder's (<c>llamacpp-embed</c>) and the reranker's (<c>llamacpp-rerank</c>) —
/// <c>LlamaCppSource.Register</c> gives each its OWN provider id (Lyntai D133: one host serving several routes
/// is several registrations), so a stale route naming one is never mistaken for a live registration of
/// another; collapsing the ids would reopen this class's own bug from a different angle. And the held-back
/// path LOGS a warning on every call while the stale route stands — this class's own withholding returns null
/// before the inner store is even asked, so today that case is completely silent. Replacing it trades silence
/// for a warning per call, not for a worse outcome.</para>
///
/// <para><b>On the bump, this class stops COMPILING</b> — there is no <c>GetModelOverrideAsync</c> left to
/// override. So does <c>GatherlightApp.cs</c>'s <c>ModelKeyPrefix</c> use (~173, ~190 — renamed to
/// <c>RouteKeyPrefix</c>). Only the TWO consumers Lyntai's router actually resolves move to a route,
/// <c>llm.route.scorer</c> and <c>llm.route.memory</c> — <c>scorer</c> (<c>BuiltInScorers.cs</c> ~203, "no
/// explicit Model = Lyntai routes") and <c>memory</c> (this class) are the only consumers that ever reach
/// <c>IModelRoutingStore</c>. <c>llm.model.chat</c>/<c>extract</c>/<c>validate</c> must NOT become routes: the
/// app reads each ITSELF and feeds <c>ClaudeAgentOptions.Model</c> — the agent CLI's <c>--model</c> — directly,
/// never through Lyntai routing (<c>chat</c>: <c>ChatSessionService.cs</c> ~497, <c>UnattendedRunService.cs</c>
/// ~112, <c>PlaygroundService.cs</c> ~78, <c>ZhikuMigrator.cs</c> ~166; <c>extract</c>: <c>ExtractTool.cs</c>
/// ~65; <c>validate</c>: <c>ClaudeValidateService.cs</c> ~55) — migrating them would leave the reader finding
/// nothing (a silent fallback to a default model) or hand <c>provider:model</c> straight to <c>--model</c>.
/// A migration moves what is already stored for <c>scorer</c>/<c>memory</c> only, and
/// <c>MemoryService.cs</c>'s export/import (~154, the memory bundle's <c>SetModel</c> import over
/// <c>_cortex.Models()</c>'s tunable-consumer list) has to SPLIT the same way — <c>chat</c>/<c>extract</c>/
/// <c>validate</c> keep <c>llm.model.&lt;consumer&gt;</c> in the bundle, <c>scorer</c> alone becomes
/// <c>llm.route.scorer</c> (<c>memory</c> already never travels in it — <c>ExportAsync</c>'s own comment says
/// why). D176's own warn-once for a leftover key covers only ITS <c>lyntai.model.</c> prefix
/// (<c>IModelRoutingStore.cs</c> ~37-47, a Lyntai-namespaced constant, not our configured one) — our
/// <c>llm.model.</c> namespace gets no such warning, so this migration has no safety net if a key is missed.
/// <c>MemoryRecallController.cs</c> ~550 (which sets <c>llm.model.memory</c> directly) and
/// <c>BackupService.cs</c> ~242 (the backup's delete of <c>llm.model.memory</c>) both move to
/// <c>llm.route.memory</c>. Once the route write carries the provider: delete this class and its registration
/// in <c>GatherlightApp</c>, have the binding endpoint write the route directly, and confirm <c>e2e-p52</c>
/// case 4 — which fails TODAY with either half of today's fix removed (this class, and
/// <c>MemorySources.ResolveJudgeModel</c>'s saved-source rule) — still passes on the route mechanism alone;
/// case 4b is a POSITIVE control, catching a store that withholds UNCONDITIONALLY, and stays green either
/// way.</para>
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
