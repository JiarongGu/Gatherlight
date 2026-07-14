using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Core.Services;
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

    private sealed record Args(
        string? Kind, string? Key, string? Name, string? NameLocal, string? Region, string? Summary,
        string? Url, string? ImageUrl, double? Lat, double? Lng, string? Tags, string? Source,
        double? Confidence, string? VerifiedAt);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var item = await _repo.UpsertAsync(new LibraryUpsert(
            ToolArgs.Req(a.Kind, "kind"), ToolArgs.Req(a.Key, "key"), ToolArgs.Req(a.Name, "name"),
            a.NameLocal, a.Region, a.Summary, a.Url, a.ImageUrl, a.Lat, a.Lng, a.Tags, a.Source,
            a.Confidence, a.VerifiedAt ?? DateTime.UtcNow.ToString("o")));
        return new JsonObject
        {
            ["ok"] = true, ["id"] = item.Id, ["kind"] = item.Kind, ["key"] = item.Key,
            ["confidence"] = Math.Round(item.Confidence, 3),
        }.ToJsonString();
    }
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

    private sealed record Args(string? Query, string? Kind, string? Region, int? Limit);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var items = await _repo.QueryAsync(a.Kind, a.Region, a.Query, a.Limit ?? 20);
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

/// <summary>One-time migration: import an old markdown reference library (## region / ### entry /
/// bullet fields — the JAPAN_ATTRACTIONS.md pattern) into the DB library. Deterministic + zero
/// token; pulls only durable reference facts (name/summary/coords/url/image/type), never the
/// trip/family planning lines. Idempotent (upsert by kind+key), so re-running is safe.</summary>
public sealed class LibraryImportTool : IGatherlightTool
{
    private readonly ILibraryRepository _repo;
    private readonly IDataContext _data;
    public LibraryImportTool(ILibraryRepository repo, IDataContext data)
    {
        _repo = repo;
        _data = data;
    }

    public string Name => "library_import";
    public string Description =>
        "把旧的 Markdown 参考库(## 地区 / ### 条目 / 字段 的格式,如 JAPAN_ATTRACTIONS.md)一次性导入到数据库知识库。确定性解析,零 token;只提取可复用的参考事实(名称/简介/坐标/官网/图片/类型),不含行程或家庭规划信息。按 kind+key 幂等 upsert,可安全重跑。";
    public string InputSchema => ToolSchema.Of(b => b
        .Str("path", "参考库 Markdown 的数据目录相对路径", required: true)
        .Str("kind", "默认条目类型(攻略里未识别出的用它),默认 attraction",
            options: new[] { "attraction", "restaurant", "hotel", "experience", "other" })
        .Str("region", "覆盖地区(可选;默认用 ## 标题作地区)"));

    private sealed record Args(string? Path, string? Kind, string? Region);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var rel = ToolArgs.Req(a.Path, "path");
        var abs = _data.ResolveDataPath(rel) ?? throw new ToolException(400, $"路径越界:{rel}");
        if (!File.Exists(abs)) throw new ToolException(400, $"文件不存在:{rel}");

        var md = await File.ReadAllTextAsync(abs, ct);
        var items = MarkdownLibraryImporter.Parse(md, a.Kind ?? "attraction", a.Region);

        var byKind = new Dictionary<string, int>();
        foreach (var it in items)
        {
            await _repo.UpsertAsync(it);
            byKind[it.Kind] = byKind.GetValueOrDefault(it.Kind) + 1;
        }

        var breakdown = new JsonObject();
        foreach (var (k, n) in byKind.OrderByDescending(p => p.Value)) breakdown[k] = n;
        return new JsonObject
        {
            ["ok"] = true,
            ["imported"] = items.Count,
            ["byKind"] = breakdown,
            ["sample"] = new JsonArray(items.Take(5).Select(i => (JsonNode)$"{i.Kind}:{i.Key}").ToArray()),
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
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

    private sealed record Args(string? Kind, string? Key);

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var a = ToolArgs.Parse<Args>(args);
        var removed = await _repo.DeleteAsync(ToolArgs.Req(a.Kind, "kind"), ToolArgs.Req(a.Key, "key"));
        return new JsonObject { ["ok"] = removed, ["removed"] = removed }.ToJsonString();
    }
}
