using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.PlanIndex.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.PlanIndex.Tools;

/// <summary>
/// Deterministic (zero-token) budget figures scan the agent can call instead of re-reading a whole
/// budget file: returns author-declared caps/totals, every currency mention with context, and
/// per-currency counts. Honest by design — it never sums ambiguous prose into a fake net total.
/// </summary>
public sealed class BudgetScanTool : IGatherlightTool
{
    private readonly IBudgetService _budget;

    public BudgetScanTool(IBudgetService budget) => _budget = budget;

    public string Name => "budget_scan";

    public string Description =>
        "扫描某个计划文件里的所有金额(零 token,不调用模型):返回作者声明的上限/合计行、每处货币金额及其上下文、按币种计数。诚实设计 — 不会把含糊的正文加总成假的净额。用于快速核对预算,免去通读整个文件。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("path", "计划文件的数据目录相对路径(如 plans/budgets/2026-08-kyoto.md)", required: true));

    public Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var path = args.GetProperty("path").GetString() ?? "";
        var s = _budget.Scan(path);
        if (s is null) throw new ToolException(404, $"未在 {path} 找到金额,或文件不存在。");

        var declared = new JsonArray();
        foreach (var f in s.DeclaredTotals)
            declared.Add(new JsonObject { ["currency"] = f.Currency, ["amount"] = f.Amount, ["context"] = f.Context });
        var counts = new JsonObject();
        foreach (var (ccy, n) in s.MentionCounts) counts[ccy] = n;

        var result = new JsonObject
        {
            ["declaredTotals"] = declared,
            ["mentionCounts"] = counts,
            ["totalMentions"] = s.AllFigures.Count,
            ["note"] = "declaredTotals = 作者标注的上限/合计行;mentionCounts = 每币种金额出现次数(含 per-person / 对比 / 备选)。这是扫描,不是净额合计。",
        };
        return Task.FromResult(result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }
}
