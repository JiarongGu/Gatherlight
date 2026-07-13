using PigDocument = UglyToad.PdfPig.PdfDocument;

namespace Gatherlight.Server.Modules.Documents.Services;

/// <summary>
/// PDF text extraction via PdfPig (MIT) — its strength. Structural PDF work (inspect fields /
/// fill AcroForm / merge) reliably belongs to pdf-lib: it handles real-world + CJK documents
/// where PDFsharp's appearance/import paths throw. Those live in Node leaves (tools/pdf-form)
/// wired through the pdf_* tools; this service is just the extraction side.
/// </summary>
public interface IPdfProcessor
{
    /// <summary>Plain text per page, joined. <paramref name="maxPages"/> caps very large PDFs.</summary>
    string ExtractText(string absPath, int maxPages = 200);
}

public sealed class PdfProcessor : IPdfProcessor
{
    public string ExtractText(string absPath, int maxPages = 200)
    {
        using var doc = PigDocument.Open(absPath);
        var sb = new System.Text.StringBuilder();
        var n = Math.Min(doc.NumberOfPages, maxPages);
        for (var i = 1; i <= n; i++)
            sb.Append(doc.GetPage(i).Text).Append('\n');
        if (doc.NumberOfPages > maxPages)
            sb.Append($"\n[... {doc.NumberOfPages - maxPages} more pages truncated ...]");
        return sb.ToString().Trim();
    }
}
