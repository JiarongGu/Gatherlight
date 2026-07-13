using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Scrapers.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Scrapers.Tools;

/// <summary>
/// C#/Playwright port of the visa/passport policy checker. Routes a passport × destination to the
/// official MOFA pages, scrapes them, and extracts visa-required, visa types, max stay, passport
/// validity, and e-visa availability with deterministic detectors. Built after the fabricated
/// "China passport visa-free to Japan 30 days" claim (Japan grants no such exemption). Japan is
/// the supported destination today; the router extends per destination.
/// </summary>
public sealed partial class PolicyCheckScraperTool : IGatherlightTool
{
    private readonly IPlaywrightScraper _scraper;

    public PolicyCheckScraperTool(IPlaywrightScraper scraper) => _scraper = scraper;

    public string Name => "policy_check";
    public string Description =>
        "核验签证/护照政策(护照国 × 目的地国):抓取官方来源(目前日本 MOFA),提取是否需签证、签证类型、最长停留、护照有效期规则、是否 eVISA。写入计划前必须核验 — 模型记忆的签证政策会静默过期/编造。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("passportCountry", "护照国(如 China / Australia / USA)", required: true)
        .Str("destinationCountry", "目的地国(目前仅支持 Japan)", required: true));

    private sealed record UrlRule(Regex Passport, (string Path, string Tag)[] Urls);

    private static readonly Dictionary<string, UrlRule[]> Router = new(StringComparer.OrdinalIgnoreCase)
    {
        ["japan"] = new[]
        {
            new UrlRule(ChinaRegex(), new[]
            {
                ("/ca/fna/page23e_000539.html", "mofa-china-en"),
                ("/j_info/visit/visa/topics/china.html", "mofa-china-jp"),
            }),
            new UrlRule(ExemptRegex(), new[] { ("/j_info/visit/visa/short/novisa.html", "mofa-visa-exemption") }),
            new UrlRule(AnyRegex(), new[]
            {
                ("/j_info/visit/visa/short/other_visa.html", "mofa-short-general"),
                ("/j_info/visit/visa/visaonline.html", "mofa-evisa"),
            }),
        },
    };

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var passport = args.GetProperty("passportCountry").GetString()?.Trim() ?? "";
        var dest = args.GetProperty("destinationCountry").GetString()?.Trim() ?? "";
        if (passport.Length == 0 || dest.Length == 0) throw new ToolException(400, "passportCountry 和 destinationCountry 必填");

        var sources = new JsonArray();
        if (!Router.TryGetValue(dest, out var rules))
        {
            return Result(passport, dest, null, "", "", null, null, null, sources,
                $"destination \"{dest}\" 尚未加入路由(目前仅 Japan)");
        }

        var urls = rules.Where(r => r.Passport.IsMatch(passport)).SelectMany(r => r.Urls)
            .DistinctBy(u => u.Path).ToList();
        var allText = new System.Text.StringBuilder();
        foreach (var (pathPart, tag) in urls)
        {
            var url = ScraperBases.Mofa + pathPart;
            var page = await _scraper.FetchAsync(url, timeoutMs: 30_000, ct: ct);
            if (page.Text.Length < 200) continue;
            sources.Add(new JsonObject { ["url"] = url, ["title"] = tag });
            allText.Append('\n').Append(page.Text);
        }

        var text = allText.ToString();
        if (text.Length < 200)
            return Result(passport, dest, null, "", "", null, null, null, sources, "未获取到 MOFA 文本(来源可能拦截抓取)");

        return Result(passport, dest,
            DetectVisaRequired(text), string.Join(", ", DetectVisaTypes(text)),
            DetectPassportValidity(text) ?? "", DetectMaxStay(text), DetectEvisa(text), null, sources,
            $"sources={sources.Count}");
    }

    private static string Result(string passport, string dest, bool? visaRequired, string visaTypes,
        string passportValidity, int? maxStay, bool? evisa, int? leadTime, JsonArray sources, string notes) =>
        new JsonObject
        {
            ["query"] = new JsonObject { ["passportCountry"] = passport, ["destinationCountry"] = dest },
            ["visaRequired"] = visaRequired,
            ["visaTypes"] = visaTypes.Length > 0 ? visaTypes : null,
            ["maxStayDays"] = maxStay,
            ["passportValidityRule"] = passportValidity.Length > 0 ? passportValidity : null,
            ["applicationLeadTimeDays"] = leadTime,
            ["evisaAvailable"] = evisa,
            ["officialSources"] = sources,
            ["notes"] = notes,
            ["scrapedAt"] = DateTime.UtcNow.ToString("o"),
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });

    // ---- detectors (deterministic, tested) ----
    internal static bool? DetectVisaRequired(string t)
    {
        if (VisaRequiredCues().IsMatch(t) || NotExemptCues().IsMatch(t)) return true;
        if (VisaFreeCues().IsMatch(t)) return false;
        return null;
    }

    internal static List<string> DetectVisaTypes(string t)
    {
        var types = new List<string>();
        if (Regex.IsMatch(t, "group tour", RegexOptions.IgnoreCase)) types.Add("Group Tour");
        if (Regex.IsMatch(t, "individual.*tourist|tourist.*individual|single[- ]entry", RegexOptions.IgnoreCase)) types.Add("Individual Tourist (single-entry)");
        if (Regex.IsMatch(t, "multiple[- ]entry", RegexOptions.IgnoreCase)) types.Add("Multiple-entry");
        if (Regex.IsMatch(t, "business visa|business purpose", RegexOptions.IgnoreCase)) types.Add("Business");
        if (Regex.IsMatch(t, "transit", RegexOptions.IgnoreCase)) types.Add("Transit");
        return types;
    }

    internal static int? DetectMaxStay(string t)
    {
        var days = MaxStayRegex().Matches(t).Select(m => int.TryParse(m.Groups[1].Value, out var d) ? d : 0)
            .Where(d => d > 0 && d < 365).ToList();
        return days.Count > 0 ? days.Max() : null;
    }

    internal static string? DetectPassportValidity(string t)
    {
        var m = PassportValidityRegex().Match(t);
        return m.Success ? Regex.Replace(m.Value, @"\s+", " ").Trim()[..Math.Min(200, m.Value.Trim().Length)] : null;
    }

    internal static bool? DetectEvisa(string t) =>
        Regex.IsMatch(t, "eVISA|electronic visa|online visa application", RegexOptions.IgnoreCase) ? true : null;

    [GeneratedRegex("china", RegexOptions.IgnoreCase)] private static partial Regex ChinaRegex();
    [GeneratedRegex("australia|usa|united states|uk|united kingdom|canada", RegexOptions.IgnoreCase)] private static partial Regex ExemptRegex();
    [GeneratedRegex(".")] private static partial Regex AnyRegex();
    [GeneratedRegex(@"visa exemption|no visa|visa-free|short[ -]term stay.*not.*require|免签", RegexOptions.IgnoreCase)] private static partial Regex VisaFreeCues();
    [GeneratedRegex(@"must apply for a visa|need a visa|visa.*required|need.*to apply|短期签证.*办理|need.*tourist visa", RegexOptions.IgnoreCase)] private static partial Regex VisaRequiredCues();
    [GeneratedRegex(@"not.*visa.*exempt|not.*on.*list", RegexOptions.IgnoreCase)] private static partial Regex NotExemptCues();
    [GeneratedRegex(@"(?:up to|maximum of|allowed for|period of stay[^\d]{0,40})(\d{1,3})\s*days?", RegexOptions.IgnoreCase)] private static partial Regex MaxStayRegex();
    [GeneratedRegex(@"passport[\s\S]{0,80}?(?:valid|validity)[\s\S]{0,80}?(\d+)\s*(?:months?|days?)", RegexOptions.IgnoreCase)] private static partial Regex PassportValidityRegex();
}
