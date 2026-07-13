using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services.Tools;

/// <summary>
/// Fill a Japanese-visa "Travel Itinerary" AcroForm PDF (or similar table PDF) from structured
/// JSON — transition wrapper over the Node tools/pdf-form leaf (pdf-lib + fontkit handle the CJK
/// font embedding + flatten). Paths are data-folder-relative; resolved to absolute for the leaf.
/// A C# PDFsharp port is a queued spike (ROADMAP phase 7) — kept as a leaf until proven.
/// </summary>
public sealed class FillItineraryTool : IGatherlightTool
{
    private readonly IDataContext _data;
    private readonly string _leafDir;

    public FillItineraryTool(IHostEnvironment env, IDataContext data)
    {
        _data = data;
        var dir = new DirectoryInfo(env.ContentRootPath);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "tools", "pdf-form")))
            dir = dir.Parent!;
        _leafDir = dir is not null ? Path.Combine(dir.FullName, "tools", "pdf-form") : "";
    }

    public string Name => "fill_itinerary";

    public string Description =>
        "用结构化 JSON 填写日本签证「Travel Itinerary」AcroForm 表格 PDF,输出扁平化可打印 PDF。所有路径为数据目录相对路径(如 plans/visa/<slug>/...)。";

    public string InputSchema => ToolSchema.Of(b => b
        .Str("templatePath", "空白表单 PDF 的数据目录相对路径", required: true)
        .Str("dataPath", "填写数据 JSON 的数据目录相对路径(applicationDate + rows)", required: true)
        .Str("outPath", "输出 PDF 的数据目录相对路径", required: true));

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!Directory.Exists(_leafDir)) throw new ToolException(500, $"工具目录不存在:{_leafDir}");
        var tmpl = Resolve(args, "templatePath", mustExist: true);
        var data = Resolve(args, "dataPath", mustExist: true);
        var outAbs = Resolve(args, "outPath", mustExist: false);
        Directory.CreateDirectory(Path.GetDirectoryName(outAbs)!);

        var leaf = new InlineLeaf(_leafDir, new[]
        {
            "tsx", "src/fill-itinerary.ts", "--in", tmpl, "--data", data, "--out", outAbs,
        });
        return await leaf.RunAsync(args, ct);
    }

    private string Resolve(JsonElement args, string key, bool mustExist)
    {
        var rel = args.GetProperty(key).GetString() ?? "";
        var abs = _data.ResolveDataPath(rel) ?? throw new ToolException(400, $"{key} 路径越界:{rel}");
        if (mustExist && !File.Exists(abs)) throw new ToolException(400, $"{key} 文件不存在:{rel}");
        return abs;
    }

    /// <summary>NodeLeafTool with a fixed argv (the tool already resolved everything).</summary>
    private sealed class InlineLeaf : NodeLeafTool
    {
        private readonly string _dir;
        private readonly string[] _argv;
        public InlineLeaf(string dir, string[] argv) { _dir = dir; _argv = argv; }
        public override string Name => "fill_itinerary";
        public override string Description => "";
        public override string InputSchema => "{}";
        protected override string LeafDirectory => _dir;
        protected override IEnumerable<string> BuildArgv(JsonElement args) => _argv;
    }
}
