using System.Globalization;
using Gatherlight.Server.Platform.Agent.Ui.Data;

namespace Gatherlight.Server.Product.Planner.PlanIndex.Services;

/// <summary>
/// Records as a bindable query — the source that makes a page stop lying. A dashboard bound to this
/// shows what is in <c>plans/</c> when the page is OPENED, not what was there when the agent wrote
/// the page. Planner, not Platform: it knows a record has a category like "trips".
/// </summary>
public sealed class RecordsUiSource : UiDataSource
{
    private readonly IPlanIndexService _index;

    public RecordsUiSource(IPlanIndexService index) => _index = index;

    public override string Id => "records";

    public override string Description =>
        "计划记录,最近更新在前 · records from the plan index, most recently updated first";

    public override IReadOnlyList<string> Columns => ["标题 · Title", "更新 · Updated", "路径 · Path"];

    public override IReadOnlyDictionary<string, UiParamSpec> Params => P(
        ("kind", new UiParamSpec(UiParamKind.String)),   // a record category: trips · daily · weekly · budgets · packing
        ("limit", new UiParamSpec(UiParamKind.Number)));

    public override Task<UiData> FetchAsync(UiBindArgs args, CancellationToken ct)
    {
        var kind = args.Str("kind");
        var limit = args.Int("limit", 20);

        // Everything that matches, then Limited decides — so "there was more" is knowable.
        var found = _index.List()
            .Where(e => kind is null || string.Equals(e.Category, kind, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(e => e.UpdatedAt, StringComparer.Ordinal)
            .Select(e => (IReadOnlyList<string>)new[] { e.Title, Day(e.UpdatedAt), e.Path })
            .ToList();

        return Task.FromResult(Limited(found, limit));
    }

    /// <summary>Just the date. A page is read by a household, and the seconds of an index timestamp
    /// are noise in a table someone is scanning on a phone.</summary>
    private static string Day(string updatedAt) =>
        updatedAt.Length >= 10 ? updatedAt[..10] : updatedAt;
}

/// <summary>
/// One plan's money, from the zero-LLM budget scan. Deliberately excludes the figures the scan
/// flagged as not-counted ("不计入预算", rejected options): a readout that silently added them back
/// would contradict what the author of the plan wrote, in the household's own currency. The scan
/// itself stays the honest one — it never fabricates a net total, and neither does this.
/// </summary>
public sealed class BudgetUiSource : UiDataSource
{
    private readonly IBudgetService _budget;

    public BudgetUiSource(IBudgetService budget) => _budget = budget;

    public override string Id => "budget";

    public override string Description =>
        "某个计划里的金额条目(已排除标记为不计入的行)· money lines from one plan, excluding those its author marked as not counted";

    public override IReadOnlyList<string> Columns => ["条目 · Item", "金额 · Amount", "货币 · Currency"];

    public override IReadOnlyDictionary<string, UiParamSpec> Params => P(
        ("path", new UiParamSpec(UiParamKind.String, Required: true)));

    public override Task<UiData> FetchAsync(UiBindArgs args, CancellationToken ct)
    {
        var summary = _budget.Scan(args.Str("path") ?? "");
        if (summary is null) return Task.FromResult(UiData.Empty);

        var rows = summary.AllFigures
            .Where(f => !f.Excluded)
            .Select(f => (IReadOnlyList<string>)new[]
            {
                f.Context,
                // Invariant, unseparated — a Chart binding parses column 1 as a number.
                f.Amount.ToString(CultureInfo.InvariantCulture),
                f.Currency,
            })
            .ToList();

        return Task.FromResult(Capped(rows));
    }
}
