using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Agent.Llm.Sources;
using Gatherlight.Server.Platform.Hosting.Migration.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Hosting.Migration.Steps;

/// <summary>
/// Moves the two model keys Lyntai's router used to read — <c>llm.model.scorer</c> and <c>llm.model.memory</c>, a
/// bare model each — to the live ROUTES it reads since 3.3 (D176): <c>llm.route.&lt;consumer&gt;</c> =
/// <c>provider:model</c> (<see cref="LiveRoutes"/>).
///
/// <para><b>Why a step at all: nothing else would ever say the keys were left behind.</b> After the rename
/// nothing reads <c>llm.model.scorer</c>, so a household's scorer model goes back to haiku without a word — and
/// Lyntai's own warn-once for a stale key covers only ITS <c>lyntai.model.</c> namespace, never ours. So this step
/// logs every key it moves or drops.</para>
///
/// <para><b>The scorer is mechanical</b>: it only ever ran on the Claude CLI (the default client), so
/// <c>X</c> becomes <c>claude-cli:X</c>.</para>
///
/// <para><b>The judge's key is DERIVED, from the binding it was written for.</b> Its provider is not a
/// constant: the binding endpoint wrote the key beside settings.json's <c>judgeSource</c>/<c>judgeModel</c>, and
/// that pair decides where annotation runs — the CLI, or llama.cpp for a chat GGUF. So the provider is the SAVED
/// binding's <see cref="IMemoryJudgeSource.AnnotationProvider"/>, asked of the same catalog the wiring uses, and
/// the model is the stored value, unchanged. That reproduces exactly what the retiring app-side store did with
/// the key: it passed it through while the saved binding annotated through the running client, and withheld it
/// otherwise — and a route naming the saved binding's provider is read by precisely the routers that hold that
/// provider. Two cases have no provider to derive, and in both the key was never read: a saved source this build
/// has no backend for (a retired <c>ollama</c>), and a non-default source saved with no model. Those are DROPPED
/// — logged, and the next bind writes a route. With nothing saved at all the default (the CLI) was running and
/// read the key, so it becomes <c>claude-cli:X</c>.</para>
///
/// <para><b>Idempotent, and a route already there wins.</b> Each old key is deleted once handled, so a second
/// start finds nothing; a route that exists already was written by this build and is newer than the key beside
/// it. Best-effort: a failure leaves the old keys in place for the next start to retry, and the runner logs
/// it.</para>
///
/// <para><b>Ordered right after the database migration</b>, before anything can make a model call — the fact
/// index's startup back-fill annotates under the <c>memory</c> consumer.</para>
/// </summary>
public sealed class LiveRouteMigrationStep : IMigrationStep
{
    private readonly IAppConfigService _config;
    private readonly ServerConfigService _settings;
    private readonly ILogger<LiveRouteMigrationStep> _log;

    public LiveRouteMigrationStep(IAppConfigService config, ServerConfigService settings,
        ILogger<LiveRouteMigrationStep> log)
    {
        _config = config;
        _settings = settings;
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
        return Task.CompletedTask;
    }

    /// <summary>Move <paramref name="consumer"/>'s bare-model key to its route, with the provider
    /// <paramref name="provider"/> derives — or drop it when that returns a null provider, with the reason.</summary>
    private void Move(string consumer, Func<(string? Provider, string Why)> provider)
    {
        var oldKey = LiveRoutes.LegacyKey(consumer);
        var model = _config.Get(oldKey)?.Trim();
        if (model is null) return;

        var routeKey = LiveRoutes.Key(consumer);
        if (_config.Get(routeKey) is { } existing)
        {
            _log.LogInformation("live routes: dropped {Old} = {Model} — {Route} is already set ({Existing}) and is newer",
                oldKey, model, routeKey, existing);
        }
        else if (model.Length == 0)
        {
            _log.LogInformation("live routes: dropped {Old}, which was blank", oldKey);
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
                _log.LogInformation("live routes: dropped {Old} = {Model} — {Why}; nothing read it, and binding 判断 again writes {Route}",
                    oldKey, model, why, routeKey);
        }
        _config.Delete(oldKey);
    }

    /// <summary>The provider the judge's key was written for — see the class summary. Mirrors the rule the
    /// retiring store applied per call: nothing saved means the default ran; a saved source with no backend or no
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
}
