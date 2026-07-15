using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
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
    public required Action<AgentEvent> OnEvent { get; init; }
}

public sealed record ClaudeRunResult(string? SessionId, string FinalText, int ExitCode);

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
            disallowed.AddRange(new[] { "Edit", "Write", "MultiEdit", "NotebookEdit" });
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
        foreach (var a in BuildArgs(opts)) psi.ArgumentList.Add(a);

        using var proc = new Process { StartInfo = psi };
        if (!proc.Start()) throw new InvalidOperationException("failed to spawn claude");

        string? sessionId = null;
        var finalText = "";

        // Prompt over stdin → keeps argv free of dynamic content. Write it on a BACKGROUND task,
        // concurrently with draining stdout/stderr below: a large prompt (the router inlines KB docs)
        // can exceed the OS stdin pipe buffer, and if we blocked here writing it while the child was
        // blocked writing stdout that nobody is reading yet, both deadlock. Start the readers first.
        var stderrTask = PumpStderrAsync(proc, opts, ct);
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
                    var (sid, text) = HandleMessage(doc.RootElement, opts);
                    if (sid is not null) sessionId = sid;
                    if (text is not null) finalText = text;
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
            opts.OnEvent(new AgentEvent { Kind = "notice", Text = "⛔ 正在停止 claude…" });
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            throw;
        }
        finally
        {
            try { await stdinTask; } catch { /* broken pipe if the child exited before reading stdin */ }
            try { await stderrTask; } catch { /* pump ended with the process */ }
        }

        return new ClaudeRunResult(sessionId, finalText, proc.ExitCode);
    }

    private static async Task PumpStderrAsync(Process proc, ClaudeRunOptions opts, CancellationToken ct)
    {
        while (await proc.StandardError.ReadLineAsync(ct) is { } line)
        {
            var text = line.Trim();
            // CLI logs go to stderr; surface only as a low-key notice if it looks like an error.
            if (text.Length > 0 && StderrErrorRegex().IsMatch(text))
                opts.OnEvent(new AgentEvent { Kind = "notice", Text = $"[claude] {Truncate(text, 400)}" });
        }
    }

    /// <summary>Translate one stream-json object into events; returns sessionId/finalText if present.</summary>
    private static (string? SessionId, string? FinalText) HandleMessage(JsonElement msg, ClaudeRunOptions opts)
    {
        string? sessionId = null;
        string? finalText = null;
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
                if (msg.TryGetProperty("result", out var res) && res.ValueKind == JsonValueKind.String
                    && res.GetString() is { } r && r.Trim().Length > 0)
                {
                    finalText = r;
                }
                if (msg.TryGetProperty("is_error", out var isErr) && isErr.ValueKind == JsonValueKind.True)
                {
                    opts.OnEvent(new AgentEvent
                    {
                        Kind = "error",
                        Text = finalText ?? "claude reported an error",
                    });
                }
                // Per-run usage/cost — the UI accumulates these per session (one event per CLI run).
                if (msg.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
                {
                    opts.OnEvent(new AgentEvent
                    {
                        Kind = "usage",
                        Data = new
                        {
                            inputTokens = Int64OrZero(usage, "input_tokens"),
                            outputTokens = Int64OrZero(usage, "output_tokens"),
                            cacheReadTokens = Int64OrZero(usage, "cache_read_input_tokens"),
                            cacheCreationTokens = Int64OrZero(usage, "cache_creation_input_tokens"),
                            costUsd = msg.TryGetProperty("total_cost_usd", out var cost)
                                && cost.ValueKind == JsonValueKind.Number ? cost.GetDouble() : 0d,
                        },
                    });
                }
                break;
        }
        return (sessionId, finalText);
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
