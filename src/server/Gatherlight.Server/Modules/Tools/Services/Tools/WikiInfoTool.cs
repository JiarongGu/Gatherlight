using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services.Tools;

/// <summary>
/// Batch-verified attraction/place info straight from the Wikipedia REST API (+ Wikidata for the
/// official website). First C#-native port of a Node leaf — the puppeteer version was a headless
/// browser for what is a plain JSON API. Used when building reference libraries so facts come
/// from a live source instead of model recall (tool-first rule).
/// </summary>
public sealed class WikiInfoTool : IGatherlightTool
{
    private readonly IHttpClientFactory _http;

    public WikiInfoTool(IHttpClientFactory http) => _http = http;

    public string Name => "wiki_info";

    public string Description =>
        "批量获取维基百科条目的已验证信息(摘要、图片、坐标、页面链接、官网)。用于构建景点/场所参考资料 — 事实来自实时来源而非模型记忆。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("titles", "维基百科条目标题,多个用逗号分隔(如 \"Kinkaku-ji, Fushimi Inari-taisha\")", required: true)
        .Str("lang", "维基百科语言版本(默认 en;中文条目用 zh)"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var titles = (args.GetProperty("titles").GetString() ?? "")
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (titles.Length == 0) throw new ToolException(400, "titles 不能为空");
        if (titles.Length > 20) throw new ToolException(400, "一次最多 20 个条目");
        var lang = args.TryGetProperty("lang", out var l) && l.GetString() is { Length: > 0 } lv ? lv : "en";

        var client = _http.CreateClient();
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Gatherlight/1.0 (family planner; wiki-info tool)");

        var results = new JsonArray();
        foreach (var title in titles)
        {
            ct.ThrowIfCancellationRequested();
            results.Add(await FetchOneAsync(client, lang, title, ct));
        }
        return new JsonObject
        {
            ["fetchedAt"] = DateTime.UtcNow.ToString("o"),
            ["source"] = $"{lang}.wikipedia.org REST API + Wikidata",
            ["entries"] = results,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    private static async Task<JsonNode> FetchOneAsync(HttpClient client, string lang, string title, CancellationToken ct)
    {
        try
        {
            var url = $"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{Uri.EscapeDataString(title.Replace(' ', '_'))}";
            using var res = await client.GetAsync(url, ct);
            if (!res.IsSuccessStatusCode)
                return new JsonObject { ["title"] = title, ["error"] = $"not found ({(int)res.StatusCode})" };
            var doc = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct))!;

            var entry = new JsonObject
            {
                ["title"] = doc["title"]?.GetValue<string>() ?? title,
                ["summary"] = doc["extract"]?.GetValue<string>(),
                ["thumbnailUrl"] = doc["thumbnail"]?["source"]?.GetValue<string>(),
                ["pageUrl"] = doc["content_urls"]?["desktop"]?["page"]?.GetValue<string>(),
            };
            if (doc["coordinates"] is JsonObject coords)
            {
                entry["lat"] = coords["lat"]?.DeepClone();
                entry["lon"] = coords["lon"]?.DeepClone();
            }
            // Official website via the linked Wikidata item (claim P856).
            if (doc["wikibase_item"]?.GetValue<string>() is { Length: > 0 } qid)
                entry["officialSite"] = await FetchOfficialSiteAsync(client, qid, ct);
            return entry;
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            return new JsonObject { ["title"] = title, ["error"] = ex.Message };
        }
    }

    private static async Task<string?> FetchOfficialSiteAsync(HttpClient client, string qid, CancellationToken ct)
    {
        try
        {
            var url = $"https://www.wikidata.org/w/api.php?action=wbgetclaims&entity={qid}&property=P856&format=json";
            using var res = await client.GetAsync(url, ct);
            if (!res.IsSuccessStatusCode) return null;
            var doc = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
            return doc?["claims"]?["P856"]?[0]?["mainsnak"]?["datavalue"]?["value"]?.GetValue<string>();
        }
        catch (OperationCanceledException) { throw; }
        catch { return null; }
    }
}
