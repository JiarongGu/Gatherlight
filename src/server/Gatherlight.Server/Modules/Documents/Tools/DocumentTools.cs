using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Documents.Services;
using Gatherlight.Server.Modules.Tools.Models;
using Gatherlight.Server.Modules.Tools.Services.Tools;

namespace Gatherlight.Server.Modules.Documents.Tools;

/// <summary>Shared path resolution for document tools — inputs/outputs are data-folder-relative,
/// resolved to absolute and traversal-guarded.</summary>
public abstract class DocumentToolBase : IGatherlightTool
{
    protected readonly IDataContext Data;
    protected DocumentToolBase(IDataContext data) => Data = data;

    public abstract string Name { get; }
    public abstract string Description { get; }
    public abstract string InputSchema { get; }
    public abstract Task<string> RunAsync(JsonElement args, CancellationToken ct);

    protected string ResolveIn(JsonElement args, string key)
    {
        var rel = args.GetProperty(key).GetString() ?? "";
        var abs = Data.ResolveDataPath(rel) ?? throw new ToolException(400, $"{key} 路径越界:{rel}");
        if (!File.Exists(abs)) throw new ToolException(400, $"{key} 文件不存在:{rel}");
        return abs;
    }

    protected string ResolveOut(JsonElement args, string key)
    {
        var rel = args.GetProperty(key).GetString() ?? "";
        return Data.ResolveDataPath(rel) ?? throw new ToolException(400, $"{key} 路径越界:{rel}");
    }

    protected static string Json(JsonNode node) =>
        node.ToJsonString(new JsonSerializerOptions { WriteIndented = true });

    /// <summary>Locate a Node leaf sub-project (tools/&lt;name&gt;) by walking up from the content root.</summary>
    protected static string ResolveLeafDir(IHostEnvironment env, string leaf)
    {
        var dir = new DirectoryInfo(env.ContentRootPath);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "tools", leaf)))
            dir = dir.Parent!;
        return dir is not null ? Path.Combine(dir.FullName, "tools", leaf) : "";
    }
}

// ---- PDF -------------------------------------------------------------------------------------

public sealed class PdfInspectTool : DocumentToolBase
{
    private readonly string _leafDir;
    public PdfInspectTool(IDataContext data, IHostEnvironment env) : base(data)
        => _leafDir = ResolveLeafDir(env, "pdf-form");

    public override string Name => "pdf_inspect";
    public override string Description =>
        "检查 PDF:页数、尺寸、AcroForm 可填字段(名称/类型/当前值)、文档元数据。填表前先用它拿到字段名。";
    public override string InputSchema => ToolSchema.Of(b => b.Str("path", "PDF 的数据目录相对路径", required: true));
    public override Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!Directory.Exists(_leafDir)) throw new ToolException(500, $"工具目录不存在:{_leafDir}");
        return new FixedNodeLeaf(_leafDir, new[] { "tsx", "src/inspect.ts", ResolveIn(args, "path") }).RunAsync(args, ct);
    }
}

public sealed class PdfExtractTextTool(IDataContext data, IPdfProcessor pdf) : DocumentToolBase(data)
{
    public override string Name => "pdf_extract_text";
    public override string Description =>
        "从 PDF 提取纯文本(零 token,不调用模型)。适合读取文本型 PDF;扫描件请用 image_* / extract。";
    public override string InputSchema => ToolSchema.Of(b => b
        .Str("path", "PDF 的数据目录相对路径", required: true)
        .Int("maxPages", "最多提取页数(默认 200)"));
    public override Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var max = args.TryGetProperty("maxPages", out var m) && m.TryGetInt32(out var n) ? Math.Clamp(n, 1, 2000) : 200;
        var textStr = pdf.ExtractText(ResolveIn(args, "path"), max);
        return Task.FromResult(Json(new JsonObject { ["text"] = textStr, ["chars"] = textStr.Length }));
    }
}

public sealed class PdfFillTool : DocumentToolBase
{
    private readonly string _leafDir;
    public PdfFillTool(IDataContext data, IHostEnvironment env) : base(data)
        => _leafDir = ResolveLeafDir(env, "pdf-form");

    public override string Name => "pdf_fill";
    public override string Description =>
        "用 name→value 字段映射填写任意 PDF AcroForm 表单,可选 flatten(烧入,不可再编辑),可选 fontPath 嵌入字体处理 CJK。先用 pdf_inspect 拿字段名。签证行程表只是它的一个用例。";
    public override string InputSchema => ToolSchema.Of(b => b
        .Str("templatePath", "空白表单 PDF 的数据目录相对路径", required: true)
        .StrMap("values", "字段名 → 值 的映射(字段名来自 pdf_inspect)", required: true)
        .Str("outPath", "输出 PDF 的数据目录相对路径", required: true)
        .Bool("flatten", "是否 flatten(默认 false)")
        .Str("fontPath", "CJK 字体 .ttf 的数据目录相对路径(可选,处理中日韩文本)"));

    public override async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!Directory.Exists(_leafDir)) throw new ToolException(500, $"工具目录不存在:{_leafDir}");
        var tmpl = ResolveIn(args, "templatePath");
        var outAbs = ResolveOut(args, "outPath");
        var flatten = args.TryGetProperty("flatten", out var f) && f.ValueKind == JsonValueKind.True;

        // Persist the field map to a scratch file for the leaf's --data.
        Directory.CreateDirectory(Data.CachePath);
        var valuesAbs = Path.Combine(Data.CachePath, $"pdf-fill-{Guid.NewGuid():N}.json");
        await File.WriteAllTextAsync(valuesAbs, args.GetProperty("values").GetRawText(), ct);

        var argv = new List<string> { "tsx", "src/fill.ts", "--in", tmpl, "--data", valuesAbs, "--out", outAbs };
        if (flatten) argv.Add("--flatten");
        if (args.TryGetProperty("fontPath", out var fp) && fp.GetString() is { Length: > 0 })
        {
            argv.Add("--font");
            argv.Add(ResolveIn(args, "fontPath"));
        }
        try
        {
            return await new FixedNodeLeaf(_leafDir, argv.ToArray()).RunAsync(args, ct);
        }
        finally
        {
            try { File.Delete(valuesAbs); } catch { /* best effort */ }
        }
    }
}

public sealed class PdfMergeTool : DocumentToolBase
{
    private readonly string _leafDir;
    public PdfMergeTool(IDataContext data, IHostEnvironment env) : base(data)
        => _leafDir = ResolveLeafDir(env, "pdf-form");

    public override string Name => "pdf_merge";
    public override string Description => "把多个 PDF 按顺序合并成一个。";
    public override string InputSchema => ToolSchema.Of(b => b
        .StrArray("paths", "要合并的 PDF 数据目录相对路径(有序)", required: true)
        .Str("outPath", "输出 PDF 的数据目录相对路径", required: true));
    public override Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        if (!Directory.Exists(_leafDir)) throw new ToolException(500, $"工具目录不存在:{_leafDir}");
        var argv = new List<string> { "tsx", "src/merge.ts", "--out", ResolveOut(args, "outPath") };
        var count = 0;
        foreach (var p in args.GetProperty("paths").EnumerateArray())
        {
            var rel = p.GetString() ?? "";
            var abs = Data.ResolveDataPath(rel) ?? throw new ToolException(400, $"路径越界:{rel}");
            if (!File.Exists(abs)) throw new ToolException(400, $"文件不存在:{rel}");
            argv.Add(abs);
            count++;
        }
        if (count < 2) throw new ToolException(400, "至少需要 2 个 PDF");
        return new FixedNodeLeaf(_leafDir, argv.ToArray()).RunAsync(args, ct);
    }
}

// ---- Image -----------------------------------------------------------------------------------

public sealed class ImageInfoTool(IDataContext data, IImageProcessor img) : DocumentToolBase(data)
{
    public override string Name => "image_info";
    public override string Description => "读取图片的格式、宽、高、位深(零 token)。";
    public override string InputSchema => ToolSchema.Of(b => b.Str("path", "图片的数据目录相对路径", required: true));
    public override Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var i = img.Info(ResolveIn(args, "path"));
        return Task.FromResult(Json(new JsonObject
        {
            ["format"] = i.Format, ["width"] = i.Width, ["height"] = i.Height, ["bitsPerPixel"] = i.BitsPerPixel,
        }));
    }
}

public sealed class ImageResizeTool(IDataContext data, IImageProcessor img) : DocumentToolBase(data)
{
    public override string Name => "image_resize";
    public override string Description => "把图片缩放到不超过 maxWidth×maxHeight(保持比例,不放大,自动按 EXIF 摆正)。";
    public override string InputSchema => ToolSchema.Of(b => b
        .Str("path", "输入图片的数据目录相对路径", required: true)
        .Str("outPath", "输出图片的数据目录相对路径(格式由扩展名决定)", required: true)
        .Int("maxWidth", "最大宽度像素", required: true)
        .Int("maxHeight", "最大高度像素", required: true));
    public override Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var (w, h) = img.Resize(ResolveIn(args, "path"), ResolveOut(args, "outPath"),
            args.GetProperty("maxWidth").GetInt32(), args.GetProperty("maxHeight").GetInt32());
        return Task.FromResult(Json(new JsonObject { ["ok"] = true, ["width"] = w, ["height"] = h, ["outPath"] = args.GetProperty("outPath").GetString() }));
    }
}

public sealed class ImageConvertTool(IDataContext data, IImageProcessor img) : DocumentToolBase(data)
{
    public override string Name => "image_convert";
    public override string Description => "把图片转成 png / jpeg / webp(自动按 EXIF 摆正)。";
    public override string InputSchema => ToolSchema.Of(b => b
        .Str("path", "输入图片的数据目录相对路径", required: true)
        .Str("outPath", "输出图片的数据目录相对路径", required: true)
        .Str("format", "目标格式(省略则用扩展名):png / jpeg / webp", options: new[] { "png", "jpeg", "webp" })
        .Int("quality", "jpeg/webp 质量 1-100(默认 82)"));
    public override Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var fmt = args.TryGetProperty("format", out var f) ? f.GetString() : null;
        var q = args.TryGetProperty("quality", out var qq) && qq.TryGetInt32(out var qv) ? qv : 82;
        try
        {
            img.Convert(ResolveIn(args, "path"), ResolveOut(args, "outPath"), fmt, q);
        }
        catch (ArgumentException ex) { throw new ToolException(400, ex.Message); }
        return Task.FromResult(Json(new JsonObject { ["ok"] = true, ["outPath"] = args.GetProperty("outPath").GetString() }));
    }
}
