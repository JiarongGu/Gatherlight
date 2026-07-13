using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services.Tools;

/// <summary>
/// Transition wrappers for the remaining Node puppeteer verifiers (tools/puppeteer in the code
/// repo) — the battle-tested scraper logic stays as-is while gaining both surfaces (HTTP + MCP).
/// Query-batch tools bridge their `--file` interface via a scratch file under {data}/cache/.
/// Each ports to C#/Playwright per docs/ROADMAP.md phase 7; delete the wrapper with the leaf.
/// </summary>
public abstract class PuppeteerLeafTool : NodeLeafTool
{
    private readonly string _leafDir;
    protected readonly IDataContext Data;

    protected PuppeteerLeafTool(IHostEnvironment env, IDataContext data)
    {
        Data = data;
        var dir = new DirectoryInfo(env.ContentRootPath);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "tools", "puppeteer")))
            dir = dir.Parent!;
        _leafDir = dir is not null ? Path.Combine(dir.FullName, "tools", "puppeteer") : "";
    }

    protected override string LeafDirectory => _leafDir;

    /// <summary>Parse + persist a `queries` argument (JSON array) to a scratch file for --file.</summary>
    protected string WriteQueriesFile(JsonElement args)
    {
        var raw = args.GetProperty("queries").GetString() ?? "";
        JsonDocument parsed;
        try { parsed = JsonDocument.Parse(raw); }
        catch (JsonException) { throw new ToolException(400, "queries 必须是合法 JSON"); }
        using (parsed)
        {
            if (parsed.RootElement.ValueKind != JsonValueKind.Array)
                throw new ToolException(400, "queries 必须是 JSON 数组");
        }
        var path = Path.Combine(Data.CachePath, $"tool-input-{Name}-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, raw);
        return path;
    }
}

/// <summary>Base for the four query-batch verifiers (identical calling convention).</summary>
public abstract class QueryBatchLeafTool : PuppeteerLeafTool
{
    protected QueryBatchLeafTool(IHostEnvironment env, IDataContext data) : base(env, data) { }

    protected abstract string Entry { get; } // src/<entry>.ts

    public override string InputSchema => ToolSchema.Of(b => b
        .Str("queries", "JSON 数组(与对应 .claude/skills 文档的输入格式一致)", required: true));

    protected override IEnumerable<string> BuildArgv(JsonElement args)
    {
        yield return "tsx";
        yield return Entry;
        yield return "--file";
        yield return WriteQueriesFile(args);
    }
}

public sealed class HotelInfoTool : QueryBatchLeafTool
{
    public HotelInfoTool(IHostEnvironment env, IDataContext data) : base(env, data) { }
    public override string Name => "hotel_info";
    public override string Description =>
        "批量核验酒店地址/电话/入退房时间(多来源交叉:官方站 + 订房平台)。写入计划前核验 — 模型记忆的邮编/地址常出错。";
    protected override string Entry => "src/hotel-info.ts";
}

public sealed class RestaurantInfoTool : QueryBatchLeafTool
{
    public RestaurantInfoTool(IHostEnvironment env, IDataContext data) : base(env, data) { }
    public override string Name => "restaurant_info";
    public override string Description =>
        "批量核验餐厅:验证声称的目录页 URL 是否对应该店,坏链自动搜索可信替代(Tabelog/TableCheck/Michelin 个店页)。模型记忆的餐厅目录 ID 系统性不可靠 — 必须逐条核验。";
    protected override string Entry => "src/restaurant-info.ts";
}

public sealed class FlightPricesTool : PuppeteerLeafTool
{
    public FlightPricesTool(IHostEnvironment env, IDataContext data) : base(env, data) { }
    public override string Name => "flight_prices";
    public override string Description =>
        "多日期机票比价(往返城市对,可附加多组日期)。返回各日期组合的最低价快照 — 引用时带抓取日期。";
    public override string InputSchema => ToolSchema.Of(b => b
        .Str("origin", "出发地 IATA,如 SYD", required: true)
        .Str("dest", "目的地 IATA,如 KIX", required: true)
        .Str("depart", "去程 YYYY-MM-DD", required: true)
        .Str("return", "回程 YYYY-MM-DD", required: true)
        .Str("also", "附加日期组,格式 D1:D2 逗号分隔(可选)")
        .Bool("nonStop", "只看直飞(可选)"));

    protected override IEnumerable<string> BuildArgv(JsonElement args)
    {
        yield return "tsx";
        yield return "src/flight-prices.ts";
        yield return args.GetProperty("origin").GetString()!;
        yield return args.GetProperty("dest").GetString()!;
        yield return args.GetProperty("depart").GetString()!;
        yield return args.GetProperty("return").GetString()!;
        if (args.TryGetProperty("also", out var also) && also.GetString() is { Length: > 0 } a)
        {
            foreach (var pair in a.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            {
                yield return "--also";
                yield return pair;
            }
        }
        if (args.TryGetProperty("nonStop", out var ns) && ns.ValueKind == JsonValueKind.True)
            yield return "--non-stop";
    }
}

public sealed class HotelPricesTool : QueryBatchLeafTool
{
    public HotelPricesTool(IHostEnvironment env, IDataContext data) : base(env, data) { }
    public override string Name => "hotel_prices";
    public override string Description =>
        "批量酒店房价查询(按城市/酒店 + 日期区间)。返回价格快照 — 引用时带抓取日期。";
    protected override string Entry => "src/hotel-prices.ts";
}
