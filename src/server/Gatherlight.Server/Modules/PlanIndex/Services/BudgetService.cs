using System.Globalization;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.PlanIndex.Services;

public sealed record BudgetFigure(string Currency, decimal Amount, bool Excluded, string Context);

/// <summary>
/// A zero-LLM budget scan. Budget markdown is deliberately free-form (comparison tables, rejected
/// options, per-person vs total, "不计入预算" markers), so a naive sum-of-all-numbers would be
/// wrong — it would double-count "711.25 × 3 = 2,133.75" and add rejected options. This service is
/// deliberately HONEST about that: it extracts every currency amount with context, flags
/// excluded/option lines, and separately surfaces the lines the AUTHOR declared as caps/totals. It
/// never fabricates a net total from ambiguous prose.
/// </summary>
public sealed record BudgetSummary(
    List<BudgetFigure> DeclaredTotals,           // lines the author labeled cap/total/命中 etc.
    Dictionary<string, int> MentionCounts,       // per-currency count of all figures found
    List<BudgetFigure> AllFigures);              // every currency mention, in document order

public interface IBudgetService
{
    /// <summary>Null if the plan mentions no money.</summary>
    BudgetSummary? Scan(string relPath);
}

public sealed partial class BudgetService : IBudgetService
{
    // ISO codes the planner actually uses (money-format rule mandates ISO, not symbols).
    private static readonly HashSet<string> Currencies = new(StringComparer.Ordinal)
    {
        "AUD", "USD", "JPY", "EUR", "GBP", "CNY", "RMB", "HKD", "SGD", "KRW", "TWD", "NZD", "CAD", "CHF", "THB",
    };

    private readonly IDataContext _data;

    public BudgetService(IDataContext data) => _data = data;

    public BudgetSummary? Scan(string relPath)
    {
        var abs = _data.ResolveDataPath(relPath);
        if (abs is null || !File.Exists(abs)) return null;

        var all = new List<BudgetFigure>();
        var declared = new List<BudgetFigure>();
        foreach (var rawLine in File.ReadLines(abs))
        {
            var line = rawLine.TrimEnd();
            var excluded = ExcludedRegex().IsMatch(line);
            var isDeclared = TotalKeywordRegex().IsMatch(line);
            foreach (Match m in MoneyRegex().Matches(line))
            {
                var ccy = m.Groups["ccy"].Value;
                if (!Currencies.Contains(ccy)) continue;
                if (!decimal.TryParse(m.Groups["amt"].Value.Replace(",", ""),
                        NumberStyles.Number, CultureInfo.InvariantCulture, out var amt)) continue;
                var fig = new BudgetFigure(ccy, amt, excluded, Context(line));
                all.Add(fig);
                if (isDeclared && !excluded) declared.Add(fig);
            }
        }
        if (all.Count == 0) return null;

        var counts = all.GroupBy(f => f.Currency).ToDictionary(g => g.Key, g => g.Count());
        return new BudgetSummary(declared, counts, all);
    }

    private static string Context(string line)
    {
        var s = line.Trim().Trim('|').Trim().Replace("**", "");
        return s.Length > 160 ? s[..159] + "…" : s;
    }

    // <CCY> <amount> — ISO code then a number (optional thousands separators + decimals).
    [GeneratedRegex(@"\b(?<ccy>[A-Z]{3})\s*(?<amt>\d[\d,]*(?:\.\d+)?)\b")]
    private static partial Regex MoneyRegex();

    // Author declared this line a cap/total.
    [GeneratedRegex(@"total|cap|budget|合计|总额|总计|机票总|命中|target|软上限|预算", RegexOptions.IgnoreCase)]
    private static partial Regex TotalKeywordRegex();

    // Rejected option / not counted toward the budget.
    [GeneratedRegex(@"不计入|拒选|拒因|rejected|备选|❌")]
    private static partial Regex ExcludedRegex();
}
