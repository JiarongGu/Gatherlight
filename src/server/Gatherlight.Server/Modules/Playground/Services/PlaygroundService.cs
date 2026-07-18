using System.Diagnostics;
using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Gatherlight.Server.Modules.Llm.Services;
using Gatherlight.Server.Modules.Scoring.Services;
using Gatherlight.Server.Modules.Tools.Services;

namespace Gatherlight.Server.Modules.Playground.Services;

/// <summary>One test case for the eval harness: a name + the user request to run through the planner.</summary>
public sealed class EvalScenario
{
    public string Name { get; set; } = "";
    public string Message { get; set; } = "";
}

public sealed class EvalResult
{
    public string Name { get; set; } = "";
    public string Message { get; set; } = "";
    public string PlanPreview { get; set; } = "";
    public long DurationMs { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public double CostUsd { get; set; }
    public Dictionary<string, double> Scores { get; set; } = new();
    public Dictionary<string, string> Reasons { get; set; } = new();
    public string? Error { get; set; }
}

public sealed class EvalRun
{
    public string Model { get; set; } = "";
    public List<EvalResult> Results { get; set; } = new();
    public Dictionary<string, double> Aggregate { get; set; } = new();   // per-scorer mean across scenarios
}

/// <summary>
/// The prompt/agent playground — Mastra's runEvals, mapped to Gatherlight. Runs a set of scenarios
/// through a DRY plan (the plan prompt, read-only, no session/commit), auto-scores each output with
/// the quality scorers WITHOUT persisting, and aggregates — a reproducible quality benchmark you run
/// (from the CLI) before + after tuning the cortex to see whether a prompt/model change actually
/// helps. Not a website surface; driven by <c>dev.mjs eval</c>.
/// </summary>
public interface IPlaygroundService
{
    Task<EvalRun> RunAsync(IReadOnlyList<EvalScenario> scenarios, string? model, CancellationToken ct = default);
}

public sealed class PlaygroundService : IPlaygroundService
{
    private readonly IClaudeCliRunner _runner;
    private readonly IPromptHarness _harness;
    private readonly IScoringService _scoring;
    private readonly IDataContext _data;
    private readonly IAppConfigService _appConfig;
    private readonly ChatEnvironmentService _env;
    private readonly IToolRegistry _tools;

    public PlaygroundService(
        IClaudeCliRunner runner, IPromptHarness harness, IScoringService scoring, IDataContext data,
        IAppConfigService appConfig, ChatEnvironmentService env, IToolRegistry tools)
    {
        _runner = runner;
        _harness = harness;
        _scoring = scoring;
        _data = data;
        _appConfig = appConfig;
        _env = env;
        _tools = tools;
    }

    public async Task<EvalRun> RunAsync(IReadOnlyList<EvalScenario> scenarios, string? model, CancellationToken ct = default)
    {
        var effectiveModel = model ?? _appConfig.Get("llm.model.chat");
        var run = new EvalRun { Model = effectiveModel ?? "(CLI default)" };

        foreach (var s in scenarios.Take(50))
        {
            ct.ThrowIfCancellationRequested();
            run.Results.Add(await RunOneAsync(s, effectiveModel, ct));
        }

        // aggregate = mean per scorer across scenarios that produced that score
        run.Aggregate = run.Results
            .SelectMany(r => r.Scores)
            .GroupBy(kv => kv.Key)
            .ToDictionary(g => g.Key, g => Math.Round(g.Average(kv => kv.Value), 3));
        return run;
    }

    private async Task<EvalResult> RunOneAsync(EvalScenario s, string? model, CancellationToken ct)
    {
        var result = new EvalResult { Name = s.Name, Message = s.Message };
        var sw = Stopwatch.StartNew();
        try
        {
            // Mirror the real plan phase's read-only run (cwd = data root → loads the knowledge base;
            // MCP tools available) so the eval reflects actual planner behaviour — just no gate/commit.
            var res = await _runner.RunAsync(new ClaudeRunOptions
            {
                Prompt = _harness.PlanPrompt(s.Message, threadContext: null, attachments: Array.Empty<string>()),
                Cwd = _data.RootPath,
                ReadOnly = true,
                Model = model,
                McpConfigPath = File.Exists(_env.McpConfigPath) ? _env.McpConfigPath : null,
                AllowedTools = _tools.McpAllowedToolNames() is { Length: > 0 } names ? names : null,
                Label = "playground",
                OnEvent = ev =>
                {
                    if (ev.Kind == "usage" && ev.Data is not null) AccumulateUsage(result, ev.Data);
                },
            }, ct);

            sw.Stop();
            result.DurationMs = sw.ElapsedMilliseconds;
            var plan = res.FinalText.Trim();
            result.PlanPreview = plan.Length <= 280 ? plan : plan[..280] + "…";

            var verdicts = await _scoring.EvaluateAsync(ScoringContext.Build(
                "playground", s.Message, plan, "playground", "plan", null, Array.Empty<string>()), ct);
            foreach (var v in verdicts)
            {
                result.Scores[v.ScorerId] = Math.Round(v.Score, 3);
                if (v.Reason is not null) result.Reasons[v.ScorerId] = v.Reason;
            }
        }
        catch (Exception ex)
        {
            sw.Stop();
            result.DurationMs = sw.ElapsedMilliseconds;
            result.Error = ex.Message;
        }
        return result;
    }

    private static void AccumulateUsage(EvalResult r, object data)
    {
        // The usage event's Data is an anonymous object with inputTokens/outputTokens/costUsd.
        try
        {
            var json = System.Text.Json.JsonSerializer.Serialize(data, AgentEvent.WireJson);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var d = doc.RootElement;
            long L(string k) => d.TryGetProperty(k, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.Number ? v.GetInt64() : 0;
            r.InputTokens += L("inputTokens");
            r.OutputTokens += L("outputTokens");
            if (d.TryGetProperty("costUsd", out var c) && c.ValueKind == System.Text.Json.JsonValueKind.Number) r.CostUsd += c.GetDouble();
        }
        catch { /* usage is best-effort */ }
    }
}
