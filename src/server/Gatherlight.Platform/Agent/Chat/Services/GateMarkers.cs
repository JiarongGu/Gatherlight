using System.Text.Json;
using System.Text.RegularExpressions;
using Gatherlight.Server.Platform.Capabilities.McpClient.Models;
using Gatherlight.Server.Platform.Capabilities.McpClient.Services;

namespace Gatherlight.Server.Platform.Agent.Chat.Services;

/// <summary>
/// Recognises the GATE MARKERS an agent leaves in its final text — <c>NEEDS_INPUT</c>,
/// <c>TOOL_DRAFT</c>, <c>CAPABILITY_BLOCKED</c>, <c>MCP_ADD</c>, <c>LOGIN_REQUIRED</c>.
///
/// A gate is a marker between turns, not a mid-run suspension, so recognising one is pure text work:
/// no session, no services, no state. That is why it lives here rather than on
/// <see cref="ChatSessionService"/> — the next marker gets added to a file about parsing markers,
/// instead of to the class that also drives runs, holds sessions and builds cards. A class you can
/// keep appending to is one that keeps being appended to.
/// </summary>
internal static class GateMarkers
{
    // The execute prompt tells the agent to end its final message with a `NEEDS_INPUT: <question>` line
    // (plus optional `OPTION: <label>` lines) when it genuinely needs a human decision — instead of
    // guessing, or (as seen in the field) inventing a non-existent "confirm in the UI" step. Detecting
    // it lets us pause the flow for a reply, offering the agent's own choices as clickable options.
    private static readonly Regex NeedsInputRe = new(
        @"^[ \t>*_-]*NEEDS_INPUT:[ \t]*(?<q>.*)$",
        RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex OptionRe = new(
        @"^[ \t>*_-]*OPTION:[ \t]*(?<o>.+?)[ \t]*$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    internal static bool TryExtractNeedsInput(string? finalText, out string question, out List<string> options)
    {
        question = "";
        options = new List<string>();
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = NeedsInputRe.Match(finalText);
        if (!m.Success) return false;
        // The marker line's own text is the question head; after it, `OPTION:` lines are the choices and
        // any other non-empty line extends the question text shown in the UI.
        var questionLines = new List<string>();
        var head = m.Groups["q"].Value.Trim();
        if (head.Length > 0) questionLines.Add(head);
        foreach (var raw in finalText[(m.Index + m.Value.Length)..].Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;
            var om = OptionRe.Match(line);
            if (om.Success) options.Add(om.Groups["o"].Value.Trim());
            else questionLines.Add(line);
        }
        question = string.Join("\n", questionLines);
        return true;
    }

    // The execute prompt tells the agent: to propose a new reusable tool, write
    // `.claude/tool-drafts/<id>/tool.json` (+ its entry script), then end the final message with a
    // TOOL_DRAFT marker and STOP — never call the tool itself, it does not exist until a human
    // approves it (IDraftStore.Promote is the only thing that makes it real).
    private static readonly Regex ToolDraftRe = new(
        @"^[ \t>*_-]*TOOL_DRAFT:[ \t]*(?<id>.+?)[ \t]*$",
        RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

    internal static bool TryExtractToolDraft(string? finalText, out string draftId)
    {
        draftId = "";
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = ToolDraftRe.Match(finalText);
        if (!m.Success) return false;
        draftId = m.Groups["id"].Value.Trim();
        return draftId.Length > 0;
    }

    // ToolRegistry's refusal message (Denied/NotEnabled) tells the agent to stop and end its final
    // message with a CAPABILITY_BLOCKED marker instead of working around the refusal. Whatever the
    // agent wrote BEFORE the marker line is its own explanation — carried as agentReason, kept
    // strictly separate from the runtime's denial record.
    private static readonly Regex CapabilityBlockedRe = new(
        @"^[ \t>*_-]*CAPABILITY_BLOCKED:[ \t]*(?<id>.+?)[ \t]*$",
        RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

    internal static bool TryExtractCapabilityBlocked(string? finalText, out string id, out string agentReason)
    {
        id = "";
        agentReason = "";
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = CapabilityBlockedRe.Match(finalText);
        if (!m.Success) return false;
        id = m.Groups["id"].Value.Trim();
        if (id.Length == 0) return false;
        agentReason = finalText[..m.Index].Trim();
        return true;
    }

    // The (system-mode) execute prompt tells the agent: to add an external MCP server, end its final
    // message with `MCP_ADD:` followed by a JSON object (name, transport, command/args | url,
    // needsCredentials[]) — never try to register it itself (it's sandboxed out). We parse the block,
    // strip any secrets (the human enters those at the gate), and park for confirmation.
    private static readonly Regex McpAddRe = new(
        @"^[ \t>*_-]*MCP_ADD:",
        RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

    internal static bool TryExtractMcpAdd(string? finalText, out McpProposal proposal)
    {
        proposal = null!;
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = McpAddRe.Match(finalText);
        if (!m.Success) return false;
        var json = ExtractFirstJsonObject(finalText, m.Index + m.Length);
        if (json is null) return false;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            string? Str(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            string[] Arr(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Array
                ? v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToArray()
                : Array.Empty<string>();
            Dictionary<string, string> Obj(string k)
            {
                var map = new Dictionary<string, string>(StringComparer.Ordinal);
                if (r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Object)
                    foreach (var p in v.EnumerateObject())
                        if (p.Value.ValueKind == JsonValueKind.String) map[p.Name] = p.Value.GetString()!;
                return map;
            }

            var transport = Str("transport") == McpTransportKind.Http ? McpTransportKind.Http : McpTransportKind.Stdio;
            var draft = new McpAddRequest(
                Name: Str("name"),
                Transport: transport,
                Command: Str("command"),
                Args: Arr("args"),
                Env: Obj("env"),
                Url: Str("url"),
                Headers: Obj("headers"),
                Secrets: null,               // secrets NEVER come from the agent — human enters at the gate
                LoginKind: Str("loginKind"),
                LoginTool: Str("loginTool"),
                LoginCheckTool: Str("loginCheckTool"),
                Enabled: true);
            proposal = new McpProposal(draft, Arr("needsCredentials"));
            return true;
        }
        catch { return false; }
    }

    /// <summary>First balanced <c>{...}</c> block at/after <paramref name="from"/>, string-aware.</summary>
    private static string? ExtractFirstJsonObject(string text, int from)
    {
        var start = text.IndexOf('{', Math.Clamp(from, 0, text.Length));
        if (start < 0) return null;
        int depth = 0;
        bool inStr = false, esc = false;
        for (var i = start; i < text.Length; i++)
        {
            var c = text[i];
            if (inStr)
            {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
            }
            else if (c == '"') inStr = true;
            else if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return text.Substring(start, i - start + 1);
        }
        return null;
    }

    // The execute prompt tells the agent: when a server needs an interactive login before you can use
    // it, end your message with `LOGIN_REQUIRED: <server id or name>` — the app shows the QR/URL and
    // resumes you once the human has logged in.
    private static readonly Regex LoginRequiredRe = new(
        @"^[ \t>*_-]*LOGIN_REQUIRED:[ \t]*(?<s>.+?)[ \t]*$",
        RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

    internal static bool TryExtractLoginRequired(string? finalText, out string serverRef)
    {
        serverRef = "";
        if (string.IsNullOrWhiteSpace(finalText)) return false;
        var m = LoginRequiredRe.Match(finalText);
        if (!m.Success) return false;
        serverRef = m.Groups["s"].Value.Trim();
        return serverRef.Length > 0;
    }
}
