using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Gatherlight.Server.Modules.Llm.Services;
using Gatherlight.Server.Modules.Scoring.Models;

namespace Gatherlight.Server.Modules.Scoring.Services;

/// <summary>
/// A single evaluation dimension (Mastra's scorer). Grades a conversation 0–1 with a reason.
/// Deterministic scorers compute in code; LLM scorers ask a cheap claude judge. Returning null means
/// "not applicable to this conversation" (e.g. a plan-quality scorer on a system-mode chat) — it's
/// skipped rather than scored 0.
/// </summary>
public interface IScorer
{
    string Id { get; }               // stable key, e.g. "scope-adherence"
    string Name { get; }             // human label
    string Description { get; }
    string Group { get; }            // "guardrails" | "quality"
    bool IsLlm { get; }
    Task<ScoreResult?> ScoreAsync(ScoreContext ctx, CancellationToken ct);
}

/// <summary>
/// Base for LLM-judged scorers (Mastra's judge step): builds a criterion prompt, runs a cheap
/// one-shot claude judge from a neutral cwd (no knowledge-base token cost), and parses a
/// <c>{ "score": 0..1, "reason": "…" }</c> verdict. Subclasses supply only the criterion + when it applies.
/// </summary>
public abstract class LlmScorerBase : IScorer
{
    private const string Preamble =
        "You are an impartial evaluation judge for a family-planning assistant. Grade the item below on the " +
        "single criterion given. Respond with ONLY a compact JSON object and nothing else: " +
        "{\"score\": <number 0..1>, \"reason\": \"<one short sentence>\"}. 1 = fully meets the criterion, 0 = fails it.\n\n";

    private readonly IClaudeCliRunner _runner;
    private readonly IAppConfigService _config;

    protected LlmScorerBase(IClaudeCliRunner runner, IAppConfigService config)
    {
        _runner = runner;
        _config = config;
    }

    public abstract string Id { get; }
    public abstract string Name { get; }
    public abstract string Description { get; }
    public abstract string Group { get; }
    public bool IsLlm => true;

    /// <summary>The criterion + the material to judge; null = not applicable (skip this conversation).</summary>
    protected abstract string? BuildCriterion(ScoreContext ctx);

    public async Task<ScoreResult?> ScoreAsync(ScoreContext ctx, CancellationToken ct)
    {
        var criterion = BuildCriterion(ctx);
        if (criterion is null) return null;

        var res = await _runner.RunAsync(new ClaudeRunOptions
        {
            Prompt = Preamble + "SCORING TASK\n" + criterion,
            Cwd = Path.GetTempPath(),   // neutral: no CLAUDE.md / knowledge-base load
            ReadOnly = true,
            Model = _config.Get("llm.model.scorer") ?? "haiku",
            Label = $"scorer:{Id}",
            OnEvent = _ => { },
        }, ct);

        return ParseVerdict(res.FinalText);
    }

    // Tolerant parse: pull the first {...} object and read score/reason. Unparseable → skip (null).
    private static ScoreResult? ParseVerdict(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            using var doc = JsonDocument.Parse(text[start..(end + 1)]);
            var root = doc.RootElement;
            if (!root.TryGetProperty("score", out var s)) return null;
            var score = s.ValueKind switch
            {
                JsonValueKind.Number => s.GetDouble(),
                JsonValueKind.String when double.TryParse(s.GetString(), out var d) => d,
                _ => double.NaN,
            };
            if (double.IsNaN(score)) return null;
            var reason = root.TryGetProperty("reason", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null;
            return new ScoreResult { Score = Math.Clamp(score, 0, 1), Reason = reason };
        }
        catch
        {
            return null;
        }
    }
}
