using System.Diagnostics;
using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Lyntai.Agents;
using Lyntai.Providers.ClaudeCli;

namespace Gatherlight.Server.Modules.Llm.Services;

/// <summary>
/// Thin app-side adapter over Lyntai's <see cref="IAgentSession"/>. Runs one session through Lyntai's
/// result-door fold (<see cref="AgentSessionExtensions.RunAsync"/>) and, per streamed event, bridges to the
/// app-owned concerns Lyntai deliberately leaves to the consumer: maps to the app's <see cref="AgentEvent"/>
/// (the SSE wire shape), records written files into an <see cref="EditTracker"/> (via Lyntai's
/// <see cref="ClaudeToolCalls.FilePathOf"/>), and prices per-run usage via <see cref="ModelPricing"/>. Adds a
/// spawn + outcome log line per consumer. The CLI-agent loop, streaming, resume, and terminal folding all
/// live in Lyntai; this only glues them to the app. Returns Lyntai's <see cref="AgentSessionResult"/>.
/// </summary>
public interface IAgentRunner
{
    Task<AgentSessionResult> RunAsync(ClaudeAgentOptions options, string label,
        Action<AgentEvent>? onEvent = null, EditTracker? tracker = null, CancellationToken ct = default);
}

public sealed class AgentRunner : IAgentRunner
{
    private readonly IAgentSession _session;
    private readonly ILogger<AgentRunner> _log;

    public AgentRunner(IAgentSession session, ILogger<AgentRunner> log)
    {
        _session = session;
        _log = log;
    }

    public async Task<AgentSessionResult> RunAsync(ClaudeAgentOptions options, string label,
        Action<AgentEvent>? onEvent = null, EditTracker? tracker = null, CancellationToken ct = default)
    {
        var emit = onEvent ?? (_ => { });
        var sw = Stopwatch.StartNew();
        // The one line that makes every LLM call traceable — consumer, cwd, model, policy, flags, prompt
        // SIZE (never content: it may hold family data + rides over stdin). Mirrors the retired runner's
        // spawn line so an instant/empty run stays diagnosable (see the claude-spawn-logging note).
        _log.LogInformation(
            "[{Label}] agent spawn: cwd={Cwd} policy={Policy} model={Model} mcp={Mcp} settings={Set} resume={Res} allowedTools={Tools} promptChars={Len}",
            label, options.WorkingDirectory, options.ToolPolicy, options.Model ?? "(cli-default)",
            !string.IsNullOrEmpty(options.McpConfigPath), !string.IsNullOrEmpty(options.SettingsPath),
            !string.IsNullOrEmpty(options.ResumeToken), options.AllowedTools.Count, options.Prompt.Length);

        AgentSessionResult result;
        try
        {
            // Lyntai's fold owns the stream loop + terminal handling; we only bridge each event to the app.
            result = await _session.RunAsync(options, onEvent: e => Map(e, emit, tracker, options), ct);
        }
        catch (OperationCanceledException)
        {
            _log.LogInformation("[{Label}] agent aborted after {Ms}ms", label, sw.ElapsedMilliseconds);
            emit(new AgentEvent { Kind = "notice", Text = "⛔ 正在停止 claude…" });
            throw;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "[{Label}] agent FAILED after {Ms}ms: {Msg}", label, sw.ElapsedMilliseconds, ex.Message);
            throw;
        }

        if (result.IsError || string.IsNullOrEmpty(result.FinalText))
            _log.LogWarning("[{Label}] agent produced no usable output: isError={Err} subtype={Sub} in {Ms}ms · diag={Diag}",
                label, result.IsError, result.Subtype ?? "(none)", sw.ElapsedMilliseconds, result.Diagnostic ?? "(none)");
        else
            _log.LogInformation("[{Label}] agent done: outChars={Out} session={Sid} subtype={Sub} in {Ms}ms",
                label, result.FinalText.Length, result.SessionId ?? "(none)", result.Subtype ?? "(none)", sw.ElapsedMilliseconds);

        return result;
    }

    // Bridge one Lyntai stream event to app-owned concerns: SSE wire + edit-tracking + pricing. Fires in
    // order, before Lyntai's fold captures the terminal result.
    private static void Map(AgentStreamEvent e, Action<AgentEvent> emit, EditTracker? tracker, ClaudeAgentOptions options)
    {
        switch (e)
        {
            case SessionStarted s:
                emit(new AgentEvent { Kind = "system", SessionId = s.SessionId });
                break;
            case TextDelta t:
                emit(new AgentEvent { Kind = "text-delta", Text = t.Text });
                break;
            case Thinking th:
                emit(new AgentEvent { Kind = "thinking", Text = th.Text });
                break;
            case ToolCall tc:
                tracker?.Record(tc.Name, ClaudeToolCalls.FilePathOf(tc));
                emit(new AgentEvent { Kind = "tool", Tool = new ToolInfo(tc.Name, ToolDetail(tc)) });
                break;
            case ToolResult:
                emit(new AgentEvent { Kind = "tool-result" });
                break;
            case UsageLive u:
                emit(new AgentEvent
                {
                    Kind = "usage-live",
                    Data = new { inputTokens = u.Input, outputTokens = u.Output, cacheReadTokens = u.CacheRead },
                });
                break;
            case UsageFinal u:
                emit(new AgentEvent
                {
                    Kind = "usage",
                    Data = new
                    {
                        inputTokens = u.Input,
                        outputTokens = u.Output,
                        cacheReadTokens = u.CacheRead,
                        cacheCreationTokens = u.CacheCreate,
                        costUsd = ModelPricing.CostUsd(u.Model ?? options.Model, u.Input, u.Output, u.CacheRead, u.CacheCreate),
                    },
                });
                break;
            case SessionEnded end when end.IsError:
                emit(new AgentEvent { Kind = "error", Text = string.IsNullOrEmpty(end.FinalText) ? "claude reported an error" : end.FinalText });
                break;
        }
    }

    // UI detail string for the 'tool' event (app presentation — not a Lyntai concern). File-path tools use
    // Lyntai's ClaudeToolCalls.FilePathOf; the rest read their own arg from the tool-call JSON.
    private static string? ToolDetail(ToolCall call)
    {
        if (call.Name is "Read" or "Edit" or "Write" or "MultiEdit" or "NotebookEdit")
            return ClaudeToolCalls.FilePathOf(call);
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(call.ArgumentsJson) ? "{}" : call.ArgumentsJson);
            var input = doc.RootElement;
            if (input.ValueKind != JsonValueKind.Object) return null;
            string? Get(string k) => input.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            return call.Name switch
            {
                "Grep" or "Glob" => Get("pattern"),
                "Bash" => Trunc(Get("command"), 80),
                "Skill" => Get("skill") ?? Get("command"),
                "WebSearch" => Get("query"),
                "WebFetch" => Get("url"),
                _ => null,
            };
        }
        catch { return null; }
    }

    private static string? Trunc(string? s, int n) => s is null || s.Length <= n ? s : s[..n];
}
