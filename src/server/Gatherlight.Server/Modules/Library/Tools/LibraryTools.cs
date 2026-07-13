using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Library.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Library.Tools;

/// <summary>
/// Agent-facing writes/reads for the knowledge library. This replaces the old "hand-write
/// JAPAN_ATTRACTIONS.md" pattern: verified reference entities live in the DB (queryable, reusable
/// across trips) instead of a markdown blob. The browse gallery reads them via /api/library.
/// </summary>
public sealed class LibraryUpsertTool : IGatherlightTool
{
    private readonly ILibraryRepository _repo;
    public LibraryUpsertTool(ILibraryRepository repo) => _repo = repo;

    public string Name => "library_upsert";
    public string Description =>
        "把一条已核验的参考实体存入知识库(景点/餐厅/酒店/体验),供跨行程复用。写入前应已用 wiki_info / scrape 等核验过 —— 名称、坐标、官网、图片、来源都尽量填全。同 kind+key 覆盖更新。取代手写 ATTRACTIONS.md 的旧做法。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("kind", "类型:attraction / restaurant / hotel / experience / other", required: true,
            options: new[] { "attraction", "restaurant", "hotel", "experience", "other" })
        .Str("key", "稳定 slug(kind 内唯一),如 kinkaku-ji", required: true)
        .Str("name", "显示名(建议英文/通用名)", required: true)
        .Str("nameLocal", "本地语言名,如 金閣寺")
        .Str("region", "地区,如 Kyoto, Japan")
        .Str("summary", "一两句简介")
        .Str("url", "官网 URL")
        .Str("imageUrl", "代表图片 URL")
        .Num("lat", "纬度")
        .Num("lng", "经度")
        .Str("tags", "逗号分隔标签,如 temple,unesco,garden")
        .Str("source", "来源,如 wikipedia / tabelog")
        .Num("confidence", "0-1 置信度(默认 0.7;实测核验过用 0.9+)")
        .Str("verifiedAt", "核验时间 ISO8601(默认当前时间)"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var item = await _repo.UpsertAsync(new LibraryUpsert(
            Req(args, "kind"), Req(args, "key"), Req(args, "name"),
            Opt(args, "nameLocal"), Opt(args, "region"), Opt(args, "summary"),
            Opt(args, "url"), Opt(args, "imageUrl"), Dbl(args, "lat"), Dbl(args, "lng"),
            Opt(args, "tags"), Opt(args, "source"), Dbl(args, "confidence"),
            Opt(args, "verifiedAt") ?? DateTime.UtcNow.ToString("o")));
        return new JsonObject
        {
            ["ok"] = true, ["id"] = item.Id, ["kind"] = item.Kind, ["key"] = item.Key,
            ["confidence"] = Math.Round(item.Confidence, 3),
        }.ToJsonString();
    }

    internal static string Req(JsonElement a, string k) =>
        a.TryGetProperty(k, out var v) && v.GetString() is { Length: > 0 } s ? s
            : throw new ToolException(400, $"{k} 必填");
    internal static string? Opt(JsonElement a, string k) =>
        a.TryGetProperty(k, out var v) && v.GetString() is { Length: > 0 } s ? s : null;
    internal static double? Dbl(JsonElement a, string k) =>
        a.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
}

public sealed class LibrarySearchTool : IGatherlightTool
{
    private readonly ILibraryRepository _repo;
    public LibrarySearchTool(ILibraryRepository repo) => _repo = repo;

    public string Name => "library_search";
    public string Description =>
        "检索知识库里已存的参考实体(按名称/简介/标签模糊匹配,可按类型或地区过滤,置信度排序)。规划前先查 —— 命中就无需重复核验/调研。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("query", "检索词(匹配名称/简介/标签)")
        .Str("kind", "限定类型(可选)")
        .Str("region", "限定地区(可选)")
        .Int("limit", "最多返回条数(默认 20)"));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var items = await _repo.QueryAsync(
            LibraryUpsertTool.Opt(args, "kind"), LibraryUpsertTool.Opt(args, "region"),
            LibraryUpsertTool.Opt(args, "query"),
            args.TryGetProperty("limit", out var l) && l.TryGetInt32(out var n) ? n : 20);
        var arr = new JsonArray();
        foreach (var it in items)
            arr.Add(new JsonObject
            {
                ["kind"] = it.Kind, ["key"] = it.Key, ["name"] = it.Name, ["nameLocal"] = it.NameLocal,
                ["region"] = it.Region, ["summary"] = it.Summary, ["url"] = it.Url,
                ["lat"] = it.Lat, ["lng"] = it.Lng, ["tags"] = it.Tags, ["source"] = it.Source,
                ["confidence"] = Math.Round(it.Confidence, 3), ["verifiedAt"] = it.VerifiedAt,
            });
        return new JsonObject { ["count"] = items.Count, ["items"] = arr }
            .ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }
}

public sealed class LibraryDeleteTool : IGatherlightTool
{
    private readonly ILibraryRepository _repo;
    public LibraryDeleteTool(ILibraryRepository repo) => _repo = repo;

    public string Name => "library_delete";
    public string Description => "从知识库删除一条参考实体(按 kind + key)。仅在实体已关闭/搬迁/确认有误时使用。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("kind", "类型", required: true)
        .Str("key", "slug", required: true));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var removed = await _repo.DeleteAsync(LibraryUpsertTool.Req(args, "kind"), LibraryUpsertTool.Req(args, "key"));
        return new JsonObject { ["ok"] = removed, ["removed"] = removed }.ToJsonString();
    }
}
