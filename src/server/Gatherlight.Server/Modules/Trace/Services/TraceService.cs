using System.Globalization;
using System.Text.Json;
using Gatherlight.Server.Modules.Chat.Services;
using Gatherlight.Server.Modules.Trace.Models;
using IConversationStore = Lyntai.Storage.IConversationStore;

namespace Gatherlight.Server.Modules.Trace.Services;

/// <summary>
/// Builds a structured run trace from the persisted conversation event stream (Lyntai's conversation store,
/// read through IConversationStore; Mastra's observability, mapped
/// to the two-gate flow): the phase timeline, each tool call with its duration, LLM runs with
/// tokens/cost, and errors — plus rolled-up totals. The raw prose lives in the transcript; this is
/// the operational skeleton for inspecting + tuning what the agent actually did.
/// </summary>
public interface ITraceService
{
    Task<RunTrace?> BuildAsync(string sessionId);
}

public sealed class TraceService : ITraceService
{
    private readonly IConversationStore _convo;
    public TraceService(IConversationStore convo) => _convo = convo;

    private sealed class EventRow
    {
        public int Seq { get; set; }
        public string Kind { get; set; } = "";
        public string PayloadJson { get; set; } = "";
        public string CreatedAt { get; set; } = "";
    }

    public async Task<RunTrace?> BuildAsync(string sessionId)
    {
        var thread = await _convo.GetThreadAsync(sessionId);
        if (thread is null) return null;
        var m = SessionMetadata.Parse(thread.Metadata);

        var events = (await _convo.GetMessagesAsync(sessionId))
            .Select(x => new EventRow
            {
                Seq = (int)x.Seq, Kind = x.Kind, PayloadJson = x.Payload, CreatedAt = x.CreatedAt.ToString("o"),
            })
            .ToList();

        var trace = new RunTrace
        {
            SessionId = sessionId,
            Mode = m.Mode ?? "plan",
            Phase = m.Phase ?? "",
            CommitSha = m.CommitSha,
        };
        if (events.Count == 0) return trace;

        // tool-result timestamps (seq-ascending) so each tool call can measure its own duration. Each
        // result is consumed by exactly one tool (pointer walks forward in lockstep) — a tool with no
        // result then gets 0 instead of borrowing a later tool's result and spanning multiple calls.
        var toolResults = events.Where(e => e.Kind == "tool-result")
            .Select(e => (e.Seq, At: Parse(e.CreatedAt))).ToList();
        var resultIdx = 0;

        foreach (var e in events)
        {
            switch (e.Kind)
            {
                case "phase":
                {
                    var phase = Prop(e.PayloadJson, "phase") ?? "";
                    trace.Steps.Add(new TraceStep { Seq = e.Seq, Kind = "phase", Label = phase, At = e.CreatedAt });
                    break;
                }
                case "tool":
                {
                    var (name, detail) = ToolFields(e.PayloadJson);
                    var start = Parse(e.CreatedAt);
                    // Skip results that precede this tool (belong to earlier tools), then take + consume
                    // the next one if any.
                    while (resultIdx < toolResults.Count && toolResults[resultIdx].Seq <= e.Seq) resultIdx++;
                    long dur = 0;
                    if (resultIdx < toolResults.Count)
                    {
                        var result = toolResults[resultIdx++];
                        dur = result.At != default && start != default ? (long)(result.At - start).TotalMilliseconds : 0;
                    }
                    trace.Steps.Add(new TraceStep { Seq = e.Seq, Kind = "tool", Label = name, Detail = detail, At = e.CreatedAt, DurationMs = Math.Max(0, dur) });
                    trace.ToolCalls++;
                    break;
                }
                case "usage":
                {
                    var u = UsageFields(e.PayloadJson);
                    trace.InputTokens += u.Input;
                    trace.OutputTokens += u.Output;
                    trace.CacheReadTokens += u.CacheRead;
                    trace.CostUsd += u.Cost;
                    trace.Steps.Add(new TraceStep
                    {
                        Seq = e.Seq, Kind = "usage", Label = "LLM 运行", At = e.CreatedAt,
                        InputTokens = u.Input, OutputTokens = u.Output, CacheReadTokens = u.CacheRead, CostUsd = u.Cost,
                    });
                    break;
                }
                case "error":
                    trace.Steps.Add(new TraceStep { Seq = e.Seq, Kind = "error", Label = "错误", Detail = Prop(e.PayloadJson, "text"), At = e.CreatedAt });
                    break;
            }
        }

        // Phase-span durations: each phase runs until the next phase step (or the last event).
        var lastAt = Parse(events[^1].CreatedAt);
        var firstAt = Parse(events[0].CreatedAt);
        var phaseSteps = trace.Steps.Where(s => s.Kind == "phase").ToList();
        for (var i = 0; i < phaseSteps.Count; i++)
        {
            var start = Parse(phaseSteps[i].At);
            var end = i + 1 < phaseSteps.Count ? Parse(phaseSteps[i + 1].At) : lastAt;
            if (start != default && end != default) phaseSteps[i].DurationMs = Math.Max(0, (long)(end - start).TotalMilliseconds);
        }
        if (firstAt != default && lastAt != default)
            trace.TotalDurationMs = Math.Max(0, (long)(lastAt - firstAt).TotalMilliseconds);
        trace.CostUsd = Math.Round(trace.CostUsd, 4);
        return trace;
    }

    private static DateTime Parse(string iso) =>
        DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var d) ? d : default;

    private static string? Prop(string json, string name)
    {
        try { using var doc = JsonDocument.Parse(json); return doc.RootElement.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null; }
        catch { return null; }
    }

    private static (string Name, string? Detail) ToolFields(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("tool", out var t) && t.ValueKind == JsonValueKind.Object)
            {
                var name = t.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "";
                var detail = t.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
                return (name, detail);
            }
        }
        catch { /* fall through */ }
        return ("tool", null);
    }

    private static (long Input, long Output, long CacheRead, double Cost) UsageFields(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object)
            {
                long L(string k) => d.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : 0;
                double C() => d.TryGetProperty("costUsd", out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
                return (L("inputTokens"), L("outputTokens"), L("cacheReadTokens"), C());
            }
        }
        catch { /* fall through */ }
        return (0, 0, 0, 0);
    }
}
