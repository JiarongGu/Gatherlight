using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// The live ROUTES Lyntai's text router reads per call (its D176, 3.3.0): <c>llm.route.&lt;consumer&gt;</c> in
/// <c>app_config</c>, holding <c>provider:model</c>. ONE place that writes and reads them, because the value
/// is a small grammar with a trap in it.
///
/// <para><b>Only two consumers are routed: <see cref="Scorer"/> and <see cref="Memory"/></b> — the only ones
/// Lyntai's router resolves. <c>chat</c>/<c>extract</c>/<c>validate</c> stay <c>llm.model.&lt;consumer&gt;</c>:
/// the app reads each ITSELF and hands it to the agent CLI's <c>--model</c>, so a route there would either be
/// read by nothing or pass <c>provider:model</c> straight to <c>--model</c>.</para>
///
/// <para><b>Every write names a MODEL; a blank one DELETES the key.</b> A bare <c>provider</c> entry means
/// "that backend's default model" — never <c>DefaultModelByConsumer</c>, which belongs to the candidates the
/// route REPLACES (Lyntai <c>IModelRoutingStore</c>'s own contract). So writing <c>claude-cli</c> to "clear" the
/// scorer would run it on the CLI's default instead of <c>haiku</c>, silently. And the namespace is our own,
/// never <c>llm.model.</c>: a bare model there (<c>haiku</c>) would be read as a PROVIDER id and live routing
/// would stop for that consumer.</para>
///
/// <para><b>What a route buys over the model-only key it replaced.</b> A route names the provider as well as
/// the model, and the router ignores (with a warning) one naming a provider IT does not hold. So a key written
/// for one 判断 binding is not read by another — after a fallback, or between a rebind and its restart —
/// which an app-side routing store did by hand, per call, until the Lyntai 3.4 bump deleted it.</para>
///
/// <para>Our namespace gets NO warn-once from Lyntai (its check covers only <c>lyntai.model.</c>), so a key
/// left under the old name is silent: <c>LiveRouteMigrationStep</c> moves them. Lyntai <c>docs/task-archive.md</c>
/// Part 310's item "Warn about leftover keys under a model-key prefix of the app's own" — closed there as Part 308,
/// <c>LyntaiOptions.ModelOnlyKeyPrefixes</c>, committed after 3.4.0 and NOT released — does not fit us when it ships:
/// its check warns when ANY key remains under a listed namespace, and <see cref="ModelKeyPrefix"/> keeps the current
/// <c>chat</c>/<c>extract</c>/<c>validate</c> keys for good, so listing it would warn at every start about keys meant
/// to be there. Leave the option at its default; the migration step's own log stays the record.</para>
/// </summary>
public static class LiveRoutes
{
    /// <summary>What <c>LyntaiOptions.RouteKeyPrefix</c> is set to.</summary>
    public const string KeyPrefix = "llm.route.";

    /// <summary>The namespace of a BARE model the app reads ITSELF — <c>chat</c>, <c>extract</c>, <c>validate</c>,
    /// each handed to the agent CLI's <c>--model</c> (cortex's unrouted rows) — and, before the routes, of
    /// <see cref="Scorer"/> and <see cref="Memory"/> too. So it is CURRENT, not legacy: the startup migration and a
    /// memory bundle's import read the two routed consumers' old keys under it, and cortex reads and writes the
    /// other three there every day. Removing it would break three rows, silently.</summary>
    public const string ModelKeyPrefix = "llm.model.";

    /// <summary>The LLM-judge scorers' consumer tag (<c>BuiltInScorers</c>). Our own tag, not Lyntai's
    /// <c>scoring</c>: a tag is a KEY, so a second spelling would open a second, unrouted bucket.</summary>
    public const string Scorer = "scorer";

    /// <summary>The memory judges' consumer — Lyntai's own tag.</summary>
    public const string Memory = Lyntai.Inference.ProviderConsumers.Memory;

    public static string Key(string consumer) => KeyPrefix + consumer;

    /// <summary>The bare-model key of <paramref name="consumer"/> (see <see cref="ModelKeyPrefix"/>).</summary>
    public static string ModelKey(string consumer) => ModelKeyPrefix + consumer;

    /// <summary><paramref name="provider"/> serving <paramref name="model"/>, in the spec Lyntai parses.</summary>
    public static string Format(string provider, string model) => $"{provider}:{model}";

    /// <summary>Why <paramref name="model"/> cannot be a route's model, or null when it can.
    ///
    /// <para><b>A comma is refused</b>: a route is a comma-separated FALLBACK LIST, so <c>haiku, llamacpp:x</c> would
    /// be stored as two entries — the second a backend nobody chose. <b>A colon is not</b>: Lyntai splits every
    /// entry at its FIRST colon, so the provider is already fixed by the time a model's own colon is read, and real
    /// model ids carry one (a Bedrock id's <c>…-v1:0</c>, an Ollama-style <c>name:tag</c>).</para></summary>
    public static string? WhyNotAModel(string? model) =>
        model is not null && model.Contains(',')
            ? $"模型名不能含逗号:「{model.Trim()}」—— 这一项存成一条路由,逗号会把它拆成好几个后端"
            : null;

    /// <summary>Write <paramref name="consumer"/>'s route — or DELETE it when <paramref name="model"/> is blank,
    /// because a bare provider would mean that backend's default, not the consumer's. Throws on a model
    /// <see cref="WhyNotAModel"/> refuses: every caller asks it first, so reaching here with one is a defect, and
    /// storing it would route to a backend nobody chose.</summary>
    public static void Set(IAppConfigService config, string consumer, string provider, string? model)
    {
        var m = model?.Trim();
        if (WhyNotAModel(m) is { } why) throw new ArgumentException(why, nameof(model));
        if (string.IsNullOrEmpty(m)) config.Delete(Key(consumer));
        else config.Set(Key(consumer), Format(provider, m));
    }

    /// <summary>The provider each entry of <paramref name="route"/> names (its part before the first colon),
    /// blank entries skipped — as Lyntai reads them.</summary>
    public static IReadOnlyList<string> Providers(string? route) =>
        string.IsNullOrWhiteSpace(route) ? []
        : route.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(e => (e.IndexOf(':') is var at && at >= 0 ? e[..at] : e).Trim())
            .Where(p => p.Length > 0)
            .ToArray();

    /// <summary>The route's PROVIDER and MODEL when it is exactly one <c>provider:model</c> entry — what every
    /// writer here produces — else null (none stored, a fallback list, or an entry naming no model).
    /// Split at the FIRST colon, as Lyntai splits every candidate spec, so a model id may contain one.</summary>
    public static (string Provider, string Model)? Single(string? route)
    {
        if (string.IsNullOrWhiteSpace(route) || route.Contains(',')) return null;
        var at = route.IndexOf(':');
        if (at <= 0) return null;
        var provider = route[..at].Trim();
        var model = route[(at + 1)..].Trim();
        return provider.Length == 0 || model.Length == 0 ? null : (provider, model);
    }
}
