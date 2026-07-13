using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Tools.Models;
using Gatherlight.Server.Modules.Tools.Services.Tools;

namespace Gatherlight.Server.Modules.Documents.Tools;

/// <summary>
/// Fill a Japanese-visa "Travel Itinerary" AcroForm PDF (or similar table PDF) from structured
/// JSON — the visa-specific convenience over <c>pdf_fill</c>. A thin wrapper over the Node
/// tools/pdf-form leaf (pdf-lib + fontkit handle the CJK font embedding + flatten); paths are
/// data-folder-relative, resolved + traversal-guarded by <see cref="DocumentToolBase"/>.
/// </summary>
public sealed class FillItineraryTool : DocumentToolBase
{
    private readonly string _leafDir;
    public FillItineraryTool(IDataContext data, IHostEnvironment env) : base(data)
        => _leafDir = ResolveLeafDir(env, "pdf-form");

    public override string Name => "fill_itinerary";

    public override string Description =>
        "用结构化 JSON 填写日本签证「Travel Itinerary」AcroForm 表格 PDF,输出扁平化可打印 PDF。所有路径为数据目录相对路径(如 plans/visa/<slug>/...)。";

    public override string InputSchema => ToolSchema.Of(b => b
        .Str("templatePath", "空白表单 PDF 的数据目录相对路径", required: true)
        .Str("dataPath", "填写数据 JSON 的数据目录相对路径(applicationDate + rows)", required: true)
        .Str("outPath", "输出 PDF 的数据目录相对路径", required: true));

    public override async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!Directory.Exists(_leafDir)) throw new ToolException(500, $"工具目录不存在:{_leafDir}");
        var tmpl = ResolveIn(args, "templatePath");
        var data = ResolveIn(args, "dataPath");
        var outAbs = ResolveOut(args, "outPath");
        Directory.CreateDirectory(Path.GetDirectoryName(outAbs)!);

        return await new FixedNodeLeaf(_leafDir, new[]
        {
            "tsx", "src/fill-itinerary.ts", "--in", tmpl, "--data", data, "--out", outAbs,
        }).RunAsync(args, ct);
    }
}
