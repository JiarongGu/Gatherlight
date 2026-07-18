using Gatherlight.Server.Modules.Scoring.Services;
using Microsoft.AspNetCore.Mvc;

namespace Gatherlight.Server.Modules.Scoring;

/// <summary>
/// Automated-scoring surface for the management console: list the scorers, read a conversation's
/// scores, (re-)run scorers for one conversation or across the backlog, and read per-scorer
/// aggregates. Conversations are auto-scored on commit; these endpoints drive manual + batch runs.
/// Scoring runs on Lyntai's framework; this controller projects Lyntai's shapes to the console wire format.
/// </summary>
[ApiController]
public sealed class ScoreController : ControllerBase
{
    private readonly IScoringService _scoring;
    public ScoreController(IScoringService scoring) => _scoring = scoring;

    [HttpGet("api/manage/scores/scorers")]
    public IActionResult Scorers() => Ok(new
    {
        scorers = _scoring.Scorers.Select(s => new { s.Id, s.Name, s.Description, s.Group, s.IsLlm }),
    });

    [HttpGet("api/manage/scores/aggregate")]
    public async Task<IActionResult> Aggregate() => Ok(new
    {
        scorers = (await _scoring.AggregateAsync()).Select(a => new { scorerId = a.ScorerId, avgScore = a.AverageScore, count = a.Count }),
    });

    [HttpGet("api/manage/scores/{id}")]
    public async Task<IActionResult> Get(string id) => Ok(new { scores = Project(await _scoring.GetAsync(id)) });

    [HttpPost("api/manage/scores/run/{id}")]
    public async Task<IActionResult> Run(string id)
    {
        var n = await _scoring.ScoreSessionAsync(id);
        return Ok(new { ok = true, scored = n, scores = Project(await _scoring.GetAsync(id)) });
    }

    [HttpPost("api/manage/scores/run-all")]
    public IActionResult RunAll()
    {
        // Batch scoring runs cheap-LLM judges over the backlog — do it in the background.
        _ = _scoring.ScoreAllAsync();
        return Ok(new { ok = true, started = true });
    }

    private static IEnumerable<object> Project(IReadOnlyList<Lyntai.Cortex.ScoredResult> scores) =>
        scores.Select(s => new { scorerId = s.ScorerId, score = s.Score, reason = s.Reason, isLlm = s.IsLlm });
}
