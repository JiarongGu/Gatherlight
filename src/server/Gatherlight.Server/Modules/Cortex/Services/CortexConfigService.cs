using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Llm.Services;

namespace Gatherlight.Server.Modules.Cortex.Services;

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
/// prompt template overrides (<c>cortex.prompt.{name}</c>) and per-consumer model routing
/// (<c>llm.model.{consumer}</c>), all stored in <c>app_config</c>. This is the write side of the
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
}

public sealed class CortexConfigService : ICortexConfigService
{
    // Consumers that resolve their model from app_config at spawn time. Keep in sync with the
    // llm.model.{consumer} lookups: ChatSessionService (chat), ExtractTool (extract).
    private static readonly (string Consumer, string Label, string Description, string? Default)[] ModelCatalog =
    {
        ("chat", "对话智能体 · Planner chat",
            "两道闸的交互式规划智能体(cwd = 数据文件夹,加载智库)。留空则用 claude CLI 默认模型。", null),
        ("extract", "文件提取 · Extract",
            "一次性文件提取工具(中性 cwd,廉价调用)。默认 sonnet。", "sonnet"),
        ("scorer", "自动评分 · Scorer",
            "自动评分的 LLM 评判(切题 / 事实可靠等维度,中性 cwd,廉价调用)。默认 haiku。", "haiku"),
    };

    // Ordered from cheapest to most capable; "" = fall back to the CLI/consumer default.
    private static readonly string[] ModelSuggestions = { "", "haiku", "sonnet", "opus" };

    private readonly IAppConfigService _config;

    public CortexConfigService(IAppConfigService config) => _config = config;

    public IReadOnlyList<PromptView> Prompts() => PromptHarness.Catalog.Select(d =>
    {
        var ov = _config.Get($"cortex.prompt.{d.Name}");
        return new PromptView(
            d.Name, d.Label, d.Description, d.Group, d.Placeholders,
            d.Default, ov, ov ?? d.Default, ov is not null);
    }).ToArray();

    public IReadOnlyList<ModelView> Models() => ModelCatalog.Select(m =>
    {
        var ov = _config.Get($"llm.model.{m.Consumer}");
        return new ModelView(
            m.Consumer, m.Label, m.Description, m.Default, ov,
            ov ?? m.Default, ov is not null, ModelSuggestions);
    }).ToArray();

    public PromptSetResult SetPrompt(string name, string value)
    {
        var desc = PromptHarness.Catalog.FirstOrDefault(d => d.Name == name);
        if (desc is null) return new PromptSetResult(false, Array.Empty<string>());

        // Guard the placeholder contract: an override that drops {userMessage}/{diff}/… would
        // silently strip the dynamic content that Render splices in, breaking the agent quietly.
        var missing = desc.Placeholders.Where(p => !value.Contains("{" + p + "}")).ToArray();
        if (missing.Length > 0) return new PromptSetResult(true, missing);

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

    public bool SetModel(string consumer, string? value)
    {
        if (ModelCatalog.All(m => m.Consumer != consumer)) return false;
        var v = value?.Trim();
        if (string.IsNullOrEmpty(v)) _config.Delete($"llm.model.{consumer}");
        else _config.Set($"llm.model.{consumer}", v);
        return true;
    }

    public bool ResetModel(string consumer)
    {
        if (ModelCatalog.All(m => m.Consumer != consumer)) return false;
        _config.Delete($"llm.model.{consumer}");
        return true;
    }
}
