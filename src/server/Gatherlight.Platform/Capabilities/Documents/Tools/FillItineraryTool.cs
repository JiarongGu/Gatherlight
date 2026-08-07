using System.Text.Json;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;
using Gatherlight.Server.Platform.Capabilities.Tools.Services.Tools;

namespace Gatherlight.Server.Platform.Capabilities.Documents.Tools;

/// <summary>
/// Fill a "Travel Itinerary" AcroForm PDF — a dated table of rows plus a signature-header date —
/// from structured JSON. The visa-shaped convenience over <c>pdf_fill</c>: a thin wrapper over the
/// Node tools/pdf-form leaf (pdf-lib + fontkit handle CJK font embedding + flatten), with paths
/// data-folder-relative and traversal-guarded by <see cref="DocumentToolBase"/>.
///
/// WHICH FIELDS the form has lives in a **form map** under the site's knowledge base, not in this
/// code — so a form that renames a field or grows a row is a file the household's agent can edit
/// and have reviewed at the diff gate, instead of a Gatherlight release. The machinery stays
/// compiled and shipped: making the whole tool a sandboxed Script capability was considered and
/// rejected, because a grant's filesystem vocabulary is site-relative while the pdf-form leaf lives
/// in the install's <c>res/</c> — it would have meant vendoring pdf-lib + fontkit into every
/// household's data folder, where they would stop being updated with the app.
/// </summary>
public sealed class FillItineraryTool : DocumentToolBase
{
    /// <summary>The map shipped by the site template. Overridable per call, so a second form is a
    /// second file rather than a second tool.</summary>
    public const string DefaultFormMap = ".claude/forms/japan-visa-itinerary.json";

    private readonly string _leafDir;
    public FillItineraryTool(ISiteContext site, IPlatformContext platform) : base(site, platform) => _leafDir = ResolveLeafDir("pdf-form");

    public override string Name => "fill_itinerary";

    public override string Description =>
        $"用结构化 JSON 填写「Travel Itinerary」AcroForm 表格 PDF(默认日本签证表),输出扁平化可打印 PDF。表单字段名来自表单映射文件(默认 {DefaultFormMap}),可直接编辑以适配改版或别的表格。所有路径为数据目录相对路径(如 plans/visa/<slug>/...)。";

    public override string InputSchema => ToolSchema.Of(b => b
        .Str("templatePath", "空白表单 PDF 的数据目录相对路径", required: true)
        .Str("dataPath", "填写数据 JSON 的数据目录相对路径(applicationDate + rows)", required: true)
        .Str("outPath", "输出 PDF 的数据目录相对路径", required: true)
        .Str($"formMap", $"表单映射 JSON 的数据目录相对路径(默认 {DefaultFormMap})"));

    public override async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var tmpl = ResolveIn(args, "templatePath");
        var data = ResolveIn(args, "dataPath");
        var outAbs = ResolveOut(args, "outPath");

        // Resolved through the SAME guard as every other path here — a form map is a file the agent
        // can name, so it gets no weaker treatment than the PDF it describes.
        var mapRel = args.ValueKind == JsonValueKind.Object
            && args.TryGetProperty("formMap", out var m)
            && m.ValueKind == JsonValueKind.String
            && m.GetString() is { Length: > 0 } supplied
                ? supplied
                : DefaultFormMap;
        var mapAbs = Site.ResolveSitePath(mapRel)
            ?? throw new ToolException(400, $"表单映射路径超出数据目录:{mapRel}");
        if (!File.Exists(mapAbs))
            throw new ToolException(400,
                $"找不到表单映射文件 {mapRel}。它描述表单的字段名,随知识库模板一起安装;" +
                "可先用 pdf_inspect 查看空白表单的实际字段名,再据此新建一个映射文件。");

        Directory.CreateDirectory(Path.GetDirectoryName(outAbs)!);

        return await new FixedNodeLeaf(_leafDir, "fill-itinerary",
            ["--in", tmpl, "--data", data, "--map", mapAbs, "--out", outAbs], Platform.ResourcesPath).RunAsync(args, ct);
    }
}
