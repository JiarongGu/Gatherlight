using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai.Prompts;

namespace Gatherlight.Server.Platform.Ops.Cortex.Services;

/// <summary>A prompt template as the console sees it: default + live override + effective body.</summary>
public sealed record PromptView(
    string Name, string Label, string Description, string Group,
    IReadOnlyList<string> Placeholders,
    string Default, string? Override, string Effective, bool Overridden);

/// <summary>A model-routing knob: which claude model a given consumer spawns with.</summary>
public sealed record ModelView(
    string Consumer, string Label, string Description,
    string? Default, string? Override, string? Effective, bool Overridden,
    IReadOnlyList<string> Suggestions);

/// <summary>Result of a prompt override write — surfaces the placeholder contract to the caller.</summary>
public sealed record PromptSetResult(bool Found, IReadOnlyList<string> MissingPlaceholders);

/// <summary>
/// The cortex tuning surface — reads/writes the runtime knobs that shape every LLM call: the
/// prompt template overrides (<c>cortex.prompt.{name}</c>) and per-consumer models
/// (<c>llm.model.{consumer}</c>, or a live route <c>llm.route.{consumer}</c> for the one consumer here Lyntai's
/// router resolves — see <see cref="LiveRoutes"/>), all stored in <c>app_config</c>. This is the write side of the
/// LLM-ops loop whose read side is the Eval observability views: rate conversations → inspect the
/// tuning dataset → adjust the prompts/models here.
/// </summary>
public interface ICortexConfigService
{
    IReadOnlyList<PromptView> Prompts();
    IReadOnlyList<ModelView> Models();
    PromptSetResult SetPrompt(string name, string value);
    bool ResetPrompt(string name);
    bool SetModel(string consumer, string? value);
    bool ResetModel(string consumer);

    /// <summary>The <c>app_config</c> key each settable consumer's model is STORED under — what a memory bundle
    /// carries, so a model travels only if a row here can set it.</summary>
    IReadOnlyList<string> ModelKeys();

    /// <summary>Set a consumer's model from a key and value as ANOTHER install stored them — a memory bundle's.
    /// False when no row here can take it. See the implementation for which shapes are accepted.</summary>
    bool SetModelFromKey(string key, string value);
}

public sealed class CortexConfigService : ICortexConfigService
{
    // Consumers whose model is chosen HERE. Keep in sync with the llm.model.{consumer} lookups (and the
    // llm.route.{consumer} one Lyntai's router makes for a routed row) AND with
    // GatherlightApp's DefaultModelByConsumer — a consumer routed there and settable NOWHERE is routable in
    // principle and unreachable in practice, which `memory` was for a while, with a code comment promising
    // a live override the product gave no way to set.
    //
    // `memory` is routed but deliberately ABSENT from this list now. 记忆检索 binds it together with its
    // BACKEND, and this row was a second place to set one value — worse, the one that won. A household who
    // set 记忆判断 to haiku here and later moved the judge to a local model had the router asking OLLAMA for
    // a model called "haiku"; both memory policies are fail-open, so the symptom was no calls and no error.
    // One decision, one control. The rule this bends is recorded in .claude/rules/dev-conventions.md.
    //
    // WHERE EACH ROW IS STORED is decided by WHO READS it. `scorer` is the one row Lyntai's router resolves, so
    // it is a live ROUTE (`llm.route.scorer = claude-cli:<model>`, Lyntai D176): provider and model together,
    // the provider always the CLI's, because the scorers run on the default client. The other three are read by
    // the app itself and handed to the agent CLI's --model, so they stay a bare `llm.model.<consumer>` — a route
    // there would reach --model as `claude-cli:opus`. `Routed` is that decision, stated per row.
    private static readonly (string Consumer, string Label, string Description, string? Default, bool Routed)[] ModelCatalog =
    {
        ("chat", "对话智能体 · Planner chat",
            "两道闸的交互式规划智能体(cwd = 数据文件夹,加载智库)。留空则用 claude CLI 默认模型。", null, false),
        ("extract", "文件提取 · Extract",
            "一次性文件提取工具(中性 cwd,廉价调用)。默认 sonnet。", "sonnet", false),
        (LiveRoutes.Scorer, "自动评分 · Scorer",
            "自动评分的 LLM 评判(切题 / 事实可靠等维度,中性 cwd,廉价调用)。默认 haiku。", "haiku", true),
        ("validate", "智库校验 · Validate",
            "两道闸提交前的只读复核:检查 .claude/ 改动的一致性与索引完整性。留空则用 claude CLI 默认模型。", null, false),
    };

    /// <summary>The provider a routed row's model runs on: the scorers are on the default client, whose only
    /// candidate is the Claude CLI.</summary>
    private const string RoutedProvider = Lyntai.Providers.ClaudeCli.ClaudeCliProvider.ProviderId;

    // Ordered from cheapest to most capable; "" = fall back to the CLI/consumer default.
    private static readonly string[] ModelSuggestions = { "", "haiku", "sonnet", "opus" };

    private readonly IAppConfigService _config;
    private readonly IPromptRegistry _registry;

    public CortexConfigService(IAppConfigService config, IPromptRegistry registry)
    {
        _config = config;
        _registry = registry;
    }

    public IReadOnlyList<PromptView> Prompts() => PromptHarness.Catalog.Select(d =>
    {
        var ov = _config.Get($"cortex.prompt.{d.Name}");
        return new PromptView(
            d.Name, d.Label, d.Description, d.Group, d.Placeholders,
            d.Default, ov, ov ?? d.Default, ov is not null);
    }).ToArray();

    public IReadOnlyList<ModelView> Models() => ModelCatalog.Select(m =>
    {
        var ov = Override(m.Consumer, m.Routed);
        return new ModelView(
            m.Consumer, m.Label, m.Description, m.Default, ov,
            ov ?? m.Default, ov is not null, ModelSuggestions);
    }).ToArray();

    /// <summary>The model a row is overridden to, or null. For a routed row that is the MODEL half of its route —
    /// or, for a route this panel did not write (a fallback list, a bare provider, another backend), the route
    /// as stored: showing the default beside a route that overrides it would say the scorers run on a model
    /// they do not.</summary>
    private string? Override(string consumer, bool routed)
    {
        if (!routed) return _config.Get(LiveRoutes.ModelKey(consumer));
        var route = _config.Get(LiveRoutes.Key(consumer));
        return LiveRoutes.Single(route) is { } one && one.Provider == RoutedProvider ? one.Model : route;
    }

    public PromptSetResult SetPrompt(string name, string value)
    {
        var desc = PromptHarness.Catalog.FirstOrDefault(d => d.Name == name);
        if (desc is null) return new PromptSetResult(false, Array.Empty<string>());

        // Guard the placeholder contract via Lyntai's registry: an override that drops {userMessage}/{diff}/…
        // would silently strip the dynamic content the render splices in. Rejecting up front (with the exact
        // missing tokens) is IPromptRegistry.ValidateOverride's job — the cortex logic belongs to Lyntai.
        var missing = _registry.ValidateOverride(desc.Default, value);
        if (missing.Count > 0) return new PromptSetResult(true, missing);

        // No-op if the value equals the built-in default — clear the override instead of storing a copy.
        if (value == desc.Default) _config.Delete($"cortex.prompt.{name}");
        else _config.Set($"cortex.prompt.{name}", value);
        return new PromptSetResult(true, Array.Empty<string>());
    }

    public bool ResetPrompt(string name)
    {
        if (PromptHarness.Catalog.All(d => d.Name != name)) return false;
        _config.Delete($"cortex.prompt.{name}");
        return true;
    }

    /// <summary>A blank value CLEARS the row — for a routed one that DELETES the route, never writes a bare
    /// provider, which would run the consumer on the CLI's own default rather than this row's (LiveRoutes).</summary>
    public bool SetModel(string consumer, string? value)
    {
        if (Row(consumer) is not { } row) return false;
        var v = value?.Trim();
        if (row.Routed) LiveRoutes.Set(_config, consumer, RoutedProvider, v);
        else if (string.IsNullOrEmpty(v)) _config.Delete(LiveRoutes.ModelKey(consumer));
        else _config.Set(LiveRoutes.ModelKey(consumer), v);
        return true;
    }

    public bool ResetModel(string consumer)
    {
        if (Row(consumer) is not { } row) return false;
        _config.Delete(StoredKey(row.Consumer, row.Routed));
        return true;
    }

    public IReadOnlyList<string> ModelKeys() => ModelCatalog.Select(m => StoredKey(m.Consumer, m.Routed)).ToArray();

    /// <summary>Two shapes, both through <see cref="SetModel"/> so a bundle can set nothing the panel could not:
    /// <c>llm.model.&lt;consumer&gt;</c> = a bare model, for EVERY row — what every bundle carried before the routes,
    /// <c>scorer</c> included, which therefore lands as its route — and, for a routed row, its route as stored
    /// (<c>llm.route.scorer</c> = <c>claude-cli:&lt;model&gt;</c>). A route this panel could not have written (another
    /// provider, a fallback list, no model) is refused. Keys are matched ORDINALLY, as the catalog is.</summary>
    public bool SetModelFromKey(string key, string value)
    {
        if (key.StartsWith(LiveRoutes.ModelKeyPrefix, StringComparison.Ordinal))
            return SetModel(key[LiveRoutes.ModelKeyPrefix.Length..], value);
        if (!key.StartsWith(LiveRoutes.KeyPrefix, StringComparison.Ordinal)) return false;
        var consumer = key[LiveRoutes.KeyPrefix.Length..];
        return Row(consumer) is { Routed: true }
            && LiveRoutes.Single(value) is { } one && one.Provider == RoutedProvider
            && SetModel(consumer, one.Model);
    }

    private static (string Consumer, bool Routed)? Row(string consumer)
    {
        foreach (var m in ModelCatalog)
            if (m.Consumer == consumer) return (m.Consumer, m.Routed);
        return null;
    }

    private static string StoredKey(string consumer, bool routed) =>
        routed ? LiveRoutes.Key(consumer) : LiveRoutes.ModelKey(consumer);
}
