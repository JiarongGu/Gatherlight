using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Keeps the two live ROUTES Lyntai's router reads (<c>llm.route.&lt;consumer&gt;</c> = <c>provider:model</c>,
/// its D176 since 3.3; <see cref="LiveRoutes"/>) honest at every start. Two jobs, both logged.
///
/// <para><b>1. Move what an install stored before the routes</b> — <c>llm.model.scorer</c> and
/// <c>llm.model.memory</c>, a bare model each. After the rename nothing reads them, so a household's scorer model
/// would go back to haiku without a word, and Lyntai's own warn-once for a stale key covers only ITS
/// <c>lyntai.model.</c> namespace, never ours. The scorer is mechanical: it only ever ran on the Claude CLI (the
/// default client), so <c>X</c> becomes <c>claude-cli:X</c>. The judge's key is DERIVED from the binding it was
/// written for: the binding endpoint wrote it beside settings.json's <c>judgeSource</c>/<c>judgeModel</c>, and that
/// pair decides where annotation runs, so the provider is the SAVED binding's
/// <see cref="IMemoryJudgeSource.AnnotationProvider"/>, asked of the same catalog the wiring uses, and the model is
/// the stored value, unchanged — which reproduces exactly what the retired app-side store did with the key. With
/// nothing saved the default (the CLI) was running and read it, so it becomes <c>claude-cli:X</c>. Two cases have no
/// provider to derive, and in both the key was never read: a saved source this build has no backend for (a retired
/// <c>ollama</c>), and a non-default source saved with no model. Those are DROPPED — at Warning, because a stored
/// choice goes with them — and binding 判断 again writes a route. A route already present is KEPT and the old key
/// beside it dropped, at Warning too: the route is what this build reads (not necessarily the newer of the two — a
/// downgrade and an upgrade can leave either one older).</para>
///
/// <para><b>2. Drop the judge's route when it names a provider the RUNNING judge does not annotate through.</b> At
/// a start, the restart has already applied any rebind, so such a route can only be one a FALLBACK left behind (a
/// chat GGUF bound, its runtime gone, so 判断 runs on the CLI) — or one step 1 just derived for that binding. No
/// router this process builds holds that provider, so Lyntai would ignore it with a Warning on EVERY annotation and
/// every recall's verification, for as long as the fallback lasts (forever, for a household that removed llama.cpp
/// on purpose), and the fact index's back-fill adds one per fact. Deleting it loses nothing: once the saved binding
/// resolves again, <c>DefaultModelByConsumer["memory"]</c> carries its annotation model, which is the model the bind
/// wrote into the route. Logged at Information — nothing is lost, and the fallback's own startup warning
/// (<c>LlamaWarmStep</c>) is the household's news. The running judge is <see cref="MemoryJudgeWiring"/>, registered
/// where the container resolves it. A rebind WITHOUT a restart still gets the router's per-call warning, which is
/// transient and says something true: that choice waits for the restart.</para>
///
/// <para><b>Idempotent</b>: each old key is deleted once handled and a stale route once dropped, so the next start
/// finds nothing. Best-effort: a failure leaves the keys for the next start to retry, and the runner logs it.
/// <b>Ordered right after the database migration</b>, before anything can make a model call — the fact index's
/// startup back-fill annotates under the <c>memory</c> consumer.</para>
/// </summary>
public sealed class LiveRouteMigrationStep : IMigrationStep
{
    private readonly IAppConfigService _config;
    private readonly ServerConfigService _settings;
    private readonly MemoryJudgeWiring _running;
    private readonly ILogger<LiveRouteMigrationStep> _log;

    public LiveRouteMigrationStep(IAppConfigService config, ServerConfigService settings, MemoryJudgeWiring running,
        ILogger<LiveRouteMigrationStep> log)
    {
        _config = config;
        _settings = settings;
        _running = running;
        _log = log;
    }

    public string Id => "live-routes";
    public string Title => "模型路由迁移 · Live routes";
    public bool Essential => false;

    public Task RunAsync(CancellationToken ct)
    {
        Move(LiveRoutes.Scorer, () => (Lyntai.Providers.ClaudeCli.ClaudeCliProvider.ProviderId,
            "the scorers run on the Claude CLI"));
        Move(LiveRoutes.Memory, JudgeProvider);
        DropStaleJudgeRoute();
        return Task.CompletedTask;
    }

    /// <summary>Move <paramref name="consumer"/>'s bare-model key to its route, with the provider
    /// <paramref name="provider"/> derives — or drop it when that returns a null provider, with the reason.</summary>
    private void Move(string consumer, Func<(string? Provider, string Why)> provider)
    {
        var oldKey = LiveRoutes.ModelKey(consumer);
        var model = _config.Get(oldKey)?.Trim();
        if (model is null) return;

        var routeKey = LiveRoutes.Key(consumer);
        if (_config.Get(routeKey) is { } existing)
        {
            _log.LogWarning("live routes: dropped {Old} = {Model} — {Route} is already set ({Existing}); kept, because the route is what this build reads",
                oldKey, model, routeKey, existing);
        }
        else if (model.Length == 0)
        {
            _log.LogInformation("live routes: dropped {Old}, which was blank", oldKey);
        }
        else if (LiveRoutes.WhyNotAModel(model) is not null)
        {
            _log.LogWarning("live routes: dropped {Old} = {Model} — a comma would make its route a fallback list naming a backend nobody chose",
                oldKey, model);
        }
        else
        {
            var (p, why) = provider();
            if (p is not null)
            {
                LiveRoutes.Set(_config, consumer, p, model);
                _log.LogInformation("live routes: {Old} = {Model} → {Route} = {Value} ({Why})",
                    oldKey, model, routeKey, LiveRoutes.Format(p, model), why);
            }
            else
                _log.LogWarning("live routes: dropped {Old} = {Model} — {Why}; nothing read it, and binding 判断 again writes {Route}",
                    oldKey, model, why, routeKey);
        }
        _config.Delete(oldKey);
    }

    /// <summary>The provider the judge's key was written for — see the class summary. Mirrors the rule the
    /// retired store applied per call: nothing saved means the default ran; a saved source with no backend or no
    /// model was never read.</summary>
    private (string? Provider, string Why) JudgeProvider()
    {
        var c = _settings.Current.Memory;
        if (MemorySources.SavedJudgeSource(c) is not { } savedId)
        {
            var cli = MemorySources.FindJudge(MemorySources.DefaultJudgeSource)!;
            return (cli.AnnotationProvider(MemorySources.DefaultJudgeModel),
                "no 判断 binding is saved, so the default judge (the Claude CLI) was reading it");
        }
        var saved = MemorySources.FindJudge(savedId);
        if (saved is null)
            return (null, $"the saved 判断 backend '{savedId}' has no implementation in this build");
        var model = !string.IsNullOrWhiteSpace(c.JudgeModel) ? c.JudgeModel
            : saved.Id == MemorySources.DefaultJudgeSource ? MemorySources.DefaultJudgeModel : null;
        return model is null
            ? (null, $"the saved 判断 backend '{saved.Id}' has no model saved")
            : (saved.AnnotationProvider(model), $"the saved 判断 binding, {saved.Id} · {model}, annotates there");
    }

    /// <summary>Job 2 of the class summary: a judge route naming no provider the RUNNING judge annotates through is
    /// a fallback's leftover, read by no router in this process.</summary>
    private void DropStaleJudgeRoute()
    {
        var routeKey = LiveRoutes.Key(LiveRoutes.Memory);
        if (_config.Get(routeKey) is not { } route) return;
        var running = MemorySources.FindJudge(_running.Transport);
        if (running is null) return;   // the container resolved a source this catalog lacks: nothing to compare with
        var provider = running.AnnotationProvider(_running.Model ?? MemorySources.DefaultJudgeModel);
        if (LiveRoutes.Providers(route).Any(p => string.Equals(p, provider, StringComparison.OrdinalIgnoreCase)))
            return;
        _config.Delete(routeKey);
        _log.LogInformation("live routes: dropped {Route} = {Value} — 判断 is running on {Source} · {Model}, which annotates "
            + "through {Provider}, so no router here would read it (the saved binding fell back); nothing is lost — "
            + "when that binding runs again its model is the judge's default", routeKey, route, running.Id,
            _running.Model, provider);
    }
}
