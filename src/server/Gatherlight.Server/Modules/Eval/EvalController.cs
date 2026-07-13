using System.Text;
using System.Text.Json;
using Gatherlight.Server.Modules.Eval.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Eval;

public sealed record FeedbackRequest(int Rating, string? Note);

/// <summary>
/// LLM-ops surface: the planner posts a per-conversation ranking (1–5 + optional note) here, and
/// the management console reads the observability views (conversation list, aggregate stats,
/// transcript, and a JSONL eval/tuning dataset export) — the "full resolution" for tuning cortex.
/// </summary>
[ApiController]
public sealed class EvalController : ControllerBase
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);

    private readonly IFeedbackStore _store;
    public EvalController(IFeedbackStore store) => _store = store;

    /// <summary>Rate a conversation (from the planner chat). Upsert — re-rating replaces.</summary>
    [HttpPost("api/chat/{id}/feedback")]
    public async Task<IActionResult> Rate(string id, [FromBody] FeedbackRequest req)
    {
        if (req is null || req.Rating is < 1 or > 5) return BadRequest(new { error = "rating must be 1–5" });
        await _store.RateAsync(id, req.Rating, string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim());
        return Ok(new { ok = true });
    }

    [HttpGet("api/manage/conversations")]
    public async Task<IActionResult> Conversations([FromQuery] int? limit)
        => Ok(new { conversations = await _store.ConversationsAsync(limit ?? 100) });

    [HttpGet("api/manage/stats")]
    public async Task<IActionResult> Stats() => Ok(await _store.StatsAsync());

    [HttpGet("api/manage/conversation/{id}")]
    public async Task<IActionResult> Transcript(string id)
    {
        var t = await _store.TranscriptAsync(id);
        return t is null ? NotFound(new { error = "not found" }) : Ok(t);
    }

    /// <summary>Download the rated conversations as a JSONL tuning/eval dataset.</summary>
    [HttpGet("api/manage/eval/export")]
    public async Task<IActionResult> EvalExport()
    {
        var records = await _store.EvalExportAsync();
        var sb = new StringBuilder();
        foreach (var r in records) sb.Append(JsonSerializer.Serialize(r, Wire)).Append('\n');
        var bytes = Encoding.UTF8.GetBytes(sb.ToString());
        return File(bytes, "application/x-ndjson", $"gatherlight-eval-{DateTime.UtcNow:yyyyMMdd-HHmmss}.jsonl");
    }
}
