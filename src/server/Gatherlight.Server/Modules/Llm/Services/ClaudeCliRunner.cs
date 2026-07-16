using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Llm.Models;

namespace Gatherlight.Server.Modules.Llm.Services;

public sealed record ClaudeRunOptions
{
    /// <summary>Full prompt text (harness already prepended) — sent via stdin so the argv
    /// stays static (no dynamic user content ever reaches a shell/argv).</summary>
    public required string Prompt { get; init; }
    /// <summary>cwd for claude — the DATA root, so the planner knowledge base auto-loads.</summary>
    public required string Cwd { get; init; }
    /// <summary>true = plan/validation (edits denied via tool flags).</summary>
    public required bool ReadOnly { get; init; }
    public string? ResumeSessionId { get; init; }
    /// <summary>--settings (scope-guard) for the execute phase.</summary>
    public string? SettingsPath { get; init; }
    public string? Model { get; init; }
    public string? McpConfigPath { get; init; }
    public string[]? AllowedTools { get; init; }
    public EditTracker? Tracker { get; init; }
    /// <summary>Short attribution tag for logs (e.g. "chat:plan", "scorer:relevancy", "job:jab12").
    /// Every spawn + outcome line is prefixed with it so the file log is greppable per consumer.</summary>
    public string? Label { get; init; }
    public required Action<AgentEvent> OnEvent { get; init; }
}

public sealed record ClaudeRunResult(string? SessionId, string FinalText, int ExitCode)
{
    /// <summary>The CLI's final `result` message reported an error (is_error=true) — e.g. it hit the
    /// turn limit or the API errored. <see cref="FinalText"/> is typically empty in that case.</summary>
    public bool IsError { get; init; }
    /// <summary>The `result` message subtype: "success", "error_max_turns", "error_during_execution", …
    /// The one signal that tells an empty output apart from a turn-limit / execution error.</summary>
    public string? ResultSubtype { get; init; }
    /// <summary>Tail of the CLI's stderr — surfaced when a run produced no usable output so an
    /// empty-output failure is diagnosable instead of silent.</summary>
    public string? StderrTail { get; init; }
}

/// <summary>
/// Spawns the local (already-logged-in) claude CLI, streams its stream-json output and
/// translates each line into normalized AgentEvents. Spawn hygiene per the family pattern:
/// resolve the real executable via where.exe once (never a shell — cmd.exe would break on
/// newlines and metacharacters in arguments), ArgumentList for every arg, BOM-less UTF-8 both
/// directions, Kill(entireProcessTree) on abort. GATHERLIGHT_CLAUDE_CMD overrides for stubs.
/// </summary>
public interface IClaudeCliRunner
{
    Task<ClaudeRunResult> RunAsync(ClaudeRunOptions opts, CancellationToken ct = default);
}

public sealed partial class ClaudeCliRunner : IClaudeCliRunner
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    private static string? _resolvedClaudePath;
    private static readonly object ResolveLock = new();

    private readonly ILogger<ClaudeCliRunner> _log;

    public ClaudeCliRunner(ILogger<ClaudeCliRunner> log) => _log = log;

    /// <summary>Build the static argv (no dynamic user content — that goes through stdin).</summary>
    internal static List<string> BuildArgs(ClaudeRunOptions opts)
    {
        var args = new List<string>
        {
            "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        };
        // Interactive / flow-control tools have no UI in this headless flow — calling them would
        // hang the run. Forks belong in the plan, decided at the human approval gate.
        var disallowed = new List<string> { "AskUserQuestion", "ExitPlanMode", "EnterPlanMode" };
        if (opts.ReadOnly)
        {
            // MultiEdit was dropped from the CLI's tool set — passing it here made every read-only spawn
            // emit "Permission deny rule \"MultiEdit\" matches no known tool". Edit/Write/NotebookEdit are
            // the current write tools; denying them keeps the plan phase read-only.
            disallowed.AddRange(new[] { "Edit", "Write", "NotebookEdit" });
        }
        else
        {
            // Execute: auto-accept edits so the headless run never stalls on a prompt
            // (settings.chat.json also sets this; explicit flag is belt-and-suspenders).
            args.Add("--permission-mode");
            args.Add("acceptEdits");
        }
        args.Add("--disallowedTools");
        args.AddRange(disallowed);
        if (opts.AllowedTools is { Length: > 0 })
        {
            args.Add("--allowedTools");
            args.AddRange(opts.AllowedTools);
        }
        if (opts.McpConfigPath is not null)
        {
            args.Add("--mcp-config");
            args.Add(opts.McpConfigPath);
        }
        if (opts.Model is not null)
        {
            args.Add("--model");
            args.Add(opts.Model);
        }
        if (opts.ResumeSessionId is not null)
        {
            args.Add("--resume");
            args.Add(opts.ResumeSessionId);
        }
        if (opts.SettingsPath is not null)
        {
            args.Add("--settings");
            args.Add(opts.SettingsPath);
        }
        return args;
    }

    public async Task<ClaudeRunResult> RunAsync(ClaudeRunOptions opts, CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo
        {
            WorkingDirectory = opts.Cwd,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardInputEncoding = Utf8NoBom,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        // GATHERLIGHT_CLAUDE_CMD overrides for tests (e.g. "node devtools/scripts/claude-stub.mjs");
        // it may carry its own leading arg. Everything still goes through ArgumentList — no shell.
        var overrideCmd = Environment.GetEnvironmentVariable("GATHERLIGHT_CLAUDE_CMD");
        if (!string.IsNullOrWhiteSpace(overrideCmd))
        {
            var parts = overrideCmd.Split(' ', 2, StringSplitOptions.TrimEntries);
            psi.FileName = parts[0];
            if (parts.Length > 1) psi.ArgumentList.Add(parts[1]);
        }
        else
        {
            psi.FileName = ResolveClaudePath();
        }
        var claudeArgs = BuildArgs(opts);
        foreach (var a in claudeArgs) psi.ArgumentList.Add(a);

        var label = opts.Label ?? "claude";
        var sw = Stopwatch.StartNew();
        // The one line that makes every LLM call traceable: which consumer, which exe/model/cwd, which
        // flags, prompt size (NOT content — that may hold family data and rides in over stdin). If a run
        // fails to spawn or returns empty, this is the context you need.
        _log.LogInformation(
            "[{Label}] claude spawn: exe={Exe} cwd={Cwd} readOnly={RO} model={Model} mcp={Mcp} settings={Set} resume={Res} allowedTools={Tools} promptChars={Len} args=[{Args}]",
            label, psi.FileName, opts.Cwd, opts.ReadOnly, opts.Model ?? "(cli-default)",
            opts.McpConfigPath is not null, opts.SettingsPath is not null, opts.ResumeSessionId is not null,
            opts.AllowedTools?.Length ?? 0, opts.Prompt.Length, string.Join(' ', claudeArgs));

        using var proc = new Process { StartInfo = psi };
        try
        {
            if (!proc.Start())
                throw new InvalidOperationException("Process.Start returned false");
        }
        catch (Exception ex)
        {
            // A throw here (exe not found, permission denied) previously left ONLY the spawn line in the
            // log — now the failure is explicit so a broken LLM task is never silent.
            _log.LogError(ex, "[{Label}] claude spawn FAILED (exe={Exe}): {Msg}", label, psi.FileName, ex.Message);
            throw;
        }

        string? sessionId = null;
        var finalText = "";
        string? resultSubtype = null;
        var isError = false;
        // The model the CLI actually ran (from assistant messages, which precede the terminal 'result').
        // Used to price the run from ModelPricing rather than trusting the CLI's total_cost_usd; falls
        // back to the requested model when the stream doesn't name one.
        string? runModel = null;
        // Bounded rolling tail of stderr — kept so an empty-output run can report WHY (auth, rate
        // limit, CLI error) instead of a silent generic "no content".
        var stderrTail = new List<string>();

        // Prompt over stdin → keeps argv free of dynamic content. Write it on a BACKGROUND task,
        // concurrently with draining stdout/stderr below: a large prompt (the router inlines KB docs)
        // can exceed the OS stdin pipe buffer, and if we blocked here writing it while the child was
        // blocked writing stdout that nobody is reading yet, both deadlock. Start the readers first.
        var stderrTask = PumpStderrAsync(proc, opts, stderrTail, ct);
        var stdinTask = Task.Run(async () =>
        {
            try { await proc.StandardInput.WriteAsync(opts.Prompt.AsMemory(), ct); }
            finally { try { proc.StandardInput.Close(); } catch { /* child already gone */ } }
        }, ct);
        try
        {
            while (await proc.StandardOutput.ReadLineAsync(ct) is { } line)
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0) continue;
                try
                {
                    using var doc = JsonDocument.Parse(trimmed);
                    runModel ??= ExtractModel(doc.RootElement);
                    var (sid, text, subtype, isErr) = HandleMessage(doc.RootElement, opts, runModel ?? opts.Model);
                    if (sid is not null) sessionId = sid;
                    if (text is not null) finalText = text;
                    if (subtype is not null) resultSubtype = subtype;
                    if (isErr is not null) isError = isErr.Value;
                }
                catch (JsonException)
                {
                    // non-JSON log line
                }
            }
            await proc.WaitForExitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            _log.LogInformation("[{Label}] claude aborted after {Ms}ms", label, sw.ElapsedMilliseconds);
            opts.OnEvent(new AgentEvent { Kind = "notice", Text = "⛔ 正在停止 claude…" });
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            throw;
        }
        catch (Exception ex)
        {
            // Mid-stream failure (broken pipe, CLI crash, reader error): log the outcome as a FAILURE —
            // the counterpart to the spawn line — so no failed LLM task is ever missing from the log.
            _log.LogError(ex, "[{Label}] claude FAILED after {Ms}ms: {Msg}", label, sw.ElapsedMilliseconds, ex.Message);
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            throw;
        }
        finally
        {
            try { await stdinTask; } catch { /* broken pipe if the child exited before reading stdin */ }
            try { await stderrTask; } catch { /* pump ended with the process */ }
        }

        var tail = stderrTail.Count > 0 ? string.Join("\n", stderrTail.TakeLast(15)) : null;
        if (tail is { Length: > 2000 }) tail = tail[^2000..];

        // Outcome — the counterpart to the spawn line. A no-output / error run is a WARNING carrying
        // exit code + subtype + stderr tail (the whole point: an empty plan is never silent again).
        if (isError || finalText.Length == 0)
            _log.LogWarning(
                "[{Label}] claude produced no usable output: exit={Exit} isError={Err} subtype={Sub} in {Ms}ms · stderrTail={Tail}",
                label, proc.ExitCode, isError, resultSubtype ?? "(none)", sw.ElapsedMilliseconds, tail ?? "(none)");
        else
            _log.LogInformation(
                "[{Label}] claude done: exit={Exit} outChars={Out} session={Sid} subtype={Sub} in {Ms}ms",
                label, proc.ExitCode, finalText.Length, sessionId ?? "(none)", resultSubtype ?? "(none)", sw.ElapsedMilliseconds);

        return new ClaudeRunResult(sessionId, finalText, proc.ExitCode)
        {
            IsError = isError,
            ResultSubtype = resultSubtype,
            StderrTail = tail,
        };
    }

    private static async Task PumpStderrAsync(Process proc, ClaudeRunOptions opts, List<string> tail, CancellationToken ct)
    {
        while (await proc.StandardError.ReadLineAsync(ct) is { } line)
        {
            var text = line.Trim();
            if (text.Length == 0) continue;
            // Keep a bounded tail for post-mortem diagnosis of an empty/failed run.
            tail.Add(text);
            if (tail.Count > 40) tail.RemoveAt(0);
            // CLI logs go to stderr; surface only as a low-key notice if it looks like an error.
            if (StderrErrorRegex().IsMatch(text))
                opts.OnEvent(new AgentEvent { Kind = "notice", Text = $"[claude] {Truncate(text, 400)}" });
        }
    }

    /// <summary>Translate one stream-json object into events; returns sessionId/finalText and, for the
    /// terminal `result` message, its subtype + is_error so an empty run can be diagnosed.</summary>
    private static (string? SessionId, string? FinalText, string? ResultSubtype, bool? IsError) HandleMessage(JsonElement msg, ClaudeRunOptions opts, string? runModel)
    {
        string? sessionId = null;
        string? finalText = null;
        string? resultSubtype = null;
        bool? isError = null;
        var type = msg.TryGetProperty("type", out var t) ? t.GetString() : null;

        switch (type)
        {
            case "system":
                if (msg.TryGetProperty("subtype", out var st) && st.GetString() == "init"
                    && msg.TryGetProperty("session_id", out var sid) && sid.GetString() is { } id)
                {
                    sessionId = id;
                    opts.OnEvent(new AgentEvent { Kind = "system", SessionId = id });
                }
                break;

            // Partial token streaming (with --include-partial-messages).
            case "stream_event":
                if (msg.TryGetProperty("event", out var ev)
                    && ev.TryGetProperty("type", out var evType) && evType.GetString() == "content_block_delta"
                    && ev.TryGetProperty("delta", out var delta)
                    && delta.TryGetProperty("type", out var dType))
                {
                    switch (dType.GetString())
                    {
                        case "text_delta" when delta.TryGetProperty("text", out var dt) && dt.GetString() is { Length: > 0 } dtext:
                            opts.OnEvent(new AgentEvent { Kind = "text-delta", Text = dtext });
                            break;
                        case "thinking_delta" when delta.TryGetProperty("thinking", out var th) && th.GetString() is { Length: > 0 } ttext:
                            opts.OnEvent(new AgentEvent { Kind = "thinking", Text = ttext });
                            break;
                    }
                }
                break;

            case "assistant":
                // Live token feedback: each assistant turn carries its own usage. Emit it as an
                // ephemeral 'usage-live' tick so the chat UI shows tokens climbing DURING a long
                // plan/research run — the authoritative per-run total still arrives via 'usage' at the
                // 'result' message. A DISTINCT kind means Trace/Playground (which aggregate 'usage')
                // ignore these, and the client resets the live counter when the 'usage' total commits,
                // so run totals are never doubled (even on SSE replay).
                if (msg.TryGetProperty("message", out var am) && am.TryGetProperty("usage", out var au)
                    && au.ValueKind == JsonValueKind.Object)
                {
                    opts.OnEvent(new AgentEvent
                    {
                        Kind = "usage-live",
                        Data = new
                        {
                            inputTokens = Int64OrZero(au, "input_tokens"),
                            outputTokens = Int64OrZero(au, "output_tokens"),
                            cacheReadTokens = Int64OrZero(au, "cache_read_input_tokens"),
                        },
                    });
                }
                foreach (var block in ContentBlocks(msg))
                {
                    var bType = block.TryGetProperty("type", out var bt) ? bt.GetString() : null;
                    if (bType == "tool_use")
                    {
                        var name = block.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                        JsonElement input = default;
                        var hasInput = block.TryGetProperty("input", out input);
                        var filePath = hasInput ? FirstString(input, "file_path", "notebook_path", "path") : null;
                        opts.Tracker?.Record(name, filePath);
                        opts.OnEvent(new AgentEvent
                        {
                            Kind = "tool",
                            Tool = new ToolInfo(name, hasInput ? ToolDetail(name, input) : null),
                        });
                    }
                    else if (bType == "text" && block.TryGetProperty("text", out var txt)
                             && txt.GetString() is { Length: > 0 } text)
                    {
                        // Full text block — used when partial streaming isn't available.
                        opts.OnEvent(new AgentEvent { Kind = "text", Text = text });
                        finalText = text;
                    }
                }
                break;

            case "user":
                foreach (var block in ContentBlocks(msg))
                {
                    if (block.TryGetProperty("type", out var bt2) && bt2.GetString() == "tool_result")
                        opts.OnEvent(new AgentEvent { Kind = "tool-result" });
                }
                break;

            case "result":
                if (msg.TryGetProperty("subtype", out var rsub) && rsub.ValueKind == JsonValueKind.String)
                    resultSubtype = rsub.GetString();
                if (msg.TryGetProperty("result", out var res) && res.ValueKind == JsonValueKind.String
                    && res.GetString() is { } r && r.Trim().Length > 0)
                {
                    finalText = r;
                }
                if (msg.TryGetProperty("is_error", out var isErr))
                {
                    isError = isErr.ValueKind == JsonValueKind.True;
                    if (isError.Value)
                        opts.OnEvent(new AgentEvent
                        {
                            Kind = "error",
                            Text = finalText ?? "claude reported an error",
                        });
                }
                // Per-run usage/cost — the UI accumulates these per session (one event per CLI run).
                // Cost is computed from ModelPricing on the ACTUAL model + token counts, NOT the CLI's
                // total_cost_usd (which is opaque and not tied to our routing) — chat + Trace read this.
                if (msg.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
                {
                    var inTok = Int64OrZero(usage, "input_tokens");
                    var outTok = Int64OrZero(usage, "output_tokens");
                    var cacheRead = Int64OrZero(usage, "cache_read_input_tokens");
                    var cacheCreate = Int64OrZero(usage, "cache_creation_input_tokens");
                    opts.OnEvent(new AgentEvent
                    {
                        Kind = "usage",
                        Data = new
                        {
                            inputTokens = inTok,
                            outputTokens = outTok,
                            cacheReadTokens = cacheRead,
                            cacheCreationTokens = cacheCreate,
                            costUsd = ModelPricing.CostUsd(runModel, inTok, outTok, cacheRead, cacheCreate),
                        },
                    });
                }
                break;
        }
        return (sessionId, finalText, resultSubtype, isError);
    }

    private static IEnumerable<JsonElement> ContentBlocks(JsonElement msg)
    {
        if (msg.TryGetProperty("message", out var m) && m.TryGetProperty("content", out var c)
            && c.ValueKind == JsonValueKind.Array)
        {
            foreach (var b in c.EnumerateArray()) yield return b;
        }
    }

    private static string? FirstString(JsonElement obj, params string[] keys)
    {
        if (obj.ValueKind != JsonValueKind.Object) return null;
        foreach (var k in keys)
            if (obj.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String)
                return v.GetString();
        return null;
    }

    private static string? ToolDetail(string name, JsonElement input) => name switch
    {
        "Read" or "Edit" or "Write" or "MultiEdit" => FirstString(input, "file_path"),
        "Grep" or "Glob" => FirstString(input, "pattern"),
        "Bash" => Truncate(FirstString(input, "command"), 80),
        "Skill" => FirstString(input, "skill", "command"),
        "WebSearch" => FirstString(input, "query"),
        "WebFetch" => FirstString(input, "url"),
        _ => null,
    };

    private static string? Truncate(string? s, int n) => s is null || s.Length <= n ? s : s[..n];

    private static long Int64OrZero(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : 0;

    /// <summary>The model id carried on an `assistant` message (<c>message.model</c>), or null. This is
    /// the authoritative model the run used — captured for pricing (the CLI honors <c>--model</c>, but a
    /// null request means the CLI default, which only the stream names).</summary>
    private static string? ExtractModel(JsonElement msg) =>
        msg.TryGetProperty("type", out var t) && t.GetString() == "assistant"
        && msg.TryGetProperty("message", out var m)
        && m.TryGetProperty("model", out var md) && md.ValueKind == JsonValueKind.String
            ? md.GetString()
            : null;

    /// <summary>Resolve the real `claude` executable once and cache it. On Windows `claude` is
    /// usually a `.cmd` shim on PATH; starting the resolved path directly means .NET (not a shell)
    /// owns argument quoting (.NET 8+ applies cmd-shim-safe escaping per the CVE-2024-0057 fix).</summary>
    private static string ResolveClaudePath()
    {
        var cached = Volatile.Read(ref _resolvedClaudePath);
        if (cached is not null) return cached.Length == 0 ? "claude" : cached;
        lock (ResolveLock)
        {
            if (_resolvedClaudePath is not null)
                return _resolvedClaudePath.Length == 0 ? "claude" : _resolvedClaudePath;
            var resolved = "";
            try
            {
                var probe = OperatingSystem.IsWindows()
                    ? new ProcessStartInfo("where.exe", "claude")
                    : new ProcessStartInfo("/usr/bin/which", "claude");
                probe.UseShellExecute = false;
                probe.RedirectStandardOutput = true;
                probe.RedirectStandardError = true;
                probe.CreateNoWindow = true;
                using var p = Process.Start(probe);
                if (p is not null)
                {
                    var stdout = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);
                    if (p.ExitCode == 0)
                    {
                        // `where` lists all matches; the FIRST can be the extensionless bash shim
                        // (e.g. C:\nvm\nodejs\claude) which Windows cannot execute — prefer an
                        // actual executable extension.
                        var lines = stdout.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
                        var best = lines.FirstOrDefault(l =>
                                l.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
                                || l.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                                || l.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
                            ?? (OperatingSystem.IsWindows() ? null : lines.FirstOrDefault());
                        if (best is not null && File.Exists(best)) resolved = best;
                    }
                }
            }
            catch { /* probe failure → PATH lookup by CreateProcess */ }
            Volatile.Write(ref _resolvedClaudePath, resolved);
            return resolved.Length == 0 ? "claude" : resolved;
        }
    }

    [GeneratedRegex("error|fatal|denied|not found", RegexOptions.IgnoreCase)]
    private static partial Regex StderrErrorRegex();
}
