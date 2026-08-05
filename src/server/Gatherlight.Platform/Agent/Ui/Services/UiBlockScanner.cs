using System.Text;
using Gatherlight.Server.Platform.Agent.Llm.Models;
using Gatherlight.Server.Platform.Agent.Ui.Models;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

/// <summary>
/// Splits one agent turn into ordered segments: prose, and ```ui fences. Sits between the agent's
/// streaming text and the SSE emit, so the raw fence text NEVER reaches the transcript as prose —
/// the user sees a placeholder while a block streams, then the rendered tree.
///
/// One instance per run; not thread-safe (the emit path is already serialized).
/// </summary>
public sealed class UiBlockScanner
{
    private const string Open = "```ui";
    private const string Close = "```";

    private readonly IUiTreeValidator _validator;
    private readonly StringBuilder _buf = new();
    private int _segment;
    private bool _inFence;
    private bool _announced;   // partial already emitted for the current fence

    public UiBlockScanner(IUiTreeValidator validator) => _validator = validator;

    /// <summary>Pass an event through, expanding a text-delta into prose deltas + block events.</summary>
    public IEnumerable<AgentEvent> Feed(AgentEvent ev)
    {
        if (ev.Kind != "text-delta" || ev.Text is null) return [ev];
        _buf.Append(ev.Text);
        return Drain(flush: false);
    }

    /// <summary>Call once the turn's text is complete. An unterminated fence resolves to invalid —
    /// a placeholder that spins forever is a worse failure than an honest one.</summary>
    public IEnumerable<AgentEvent> Flush() => Drain(flush: true);

    private List<AgentEvent> Drain(bool flush)
    {
        var outp = new List<AgentEvent>();
        while (true)
        {
            var buf = _buf.ToString();
            if (!_inFence)
            {
                var at = FindAtLineStart(buf, Open, 0);
                if (at < 0)
                {
                    // Hold back a trailing partial fence marker so "``" never leaks as prose.
                    var safe = flush ? buf.Length : SafePrefix(buf);
                    if (safe > 0)
                    {
                        outp.Add(Prose(buf[..safe]));
                        _buf.Remove(0, safe);
                    }
                    return outp;
                }
                if (at > 0)
                {
                    outp.Add(Prose(buf[..at]));
                    _buf.Remove(0, at);
                }
                // Consume the opening fence line (```ui plus the rest of that line).
                var line = _buf.ToString();
                var nl = line.IndexOf('\n');
                if (nl < 0)
                {
                    if (!flush) return outp;      // opening line not complete yet
                    outp.Add(Block(new UiBlockEvent(NextSegment(), "invalid", Raw: line, Reason: "unterminated block")));
                    _buf.Clear();
                    return outp;
                }
                _buf.Remove(0, nl + 1);
                _inFence = true;
                _announced = false;
                _segment++;
                continue;
            }

            // Inside a fence: hold everything until the closing ``` at a line start.
            var body = _buf.ToString();
            var end = FindAtLineStart(body, Close, 0);
            if (end < 0)
            {
                if (flush)
                {
                    outp.Add(Block(new UiBlockEvent(_segment, "invalid", Raw: body, Reason: "unterminated block")));
                    _buf.Clear();
                    _inFence = false;
                    return outp;
                }
                if (!_announced)
                {
                    outp.Add(Block(new UiBlockEvent(_segment, "partial")));
                    _announced = true;
                }
                return outp;
            }

            var payload = body[..end];
            var result = _validator.ValidateJson(payload);
            outp.Add(Block(result.Ok
                ? new UiBlockEvent(_segment, "ready", Node: result.Node)
                : new UiBlockEvent(_segment, "invalid", Raw: payload, Reason: result.Reason)));

            // Consume the closing fence line.
            var afterClose = end + Close.Length;
            var nl2 = body.IndexOf('\n', afterClose);
            _buf.Remove(0, nl2 < 0 ? body.Length : nl2 + 1);
            _inFence = false;
            _segment++;
        }
    }

    private int NextSegment() => ++_segment;

    private AgentEvent Prose(string text) =>
        new() { Kind = "text-delta", Text = text, Data = new { segment = _segment } };

    private static AgentEvent Block(UiBlockEvent b) => new() { Kind = "ui-block", Data = b };

    /// <summary>Index of `marker` when it starts a line, else -1.</summary>
    private static int FindAtLineStart(string s, string marker, int from)
    {
        for (var i = from; i >= 0 && i < s.Length;)
        {
            var at = s.IndexOf(marker, i, StringComparison.Ordinal);
            if (at < 0) return -1;
            if (at == 0 || s[at - 1] == '\n') return at;
            i = at + 1;
        }
        return -1;
    }

    /// <summary>How much of `s` is safe to emit as prose — everything except a trailing fragment
    /// that could still turn into an opening fence once more text arrives.</summary>
    private static int SafePrefix(string s)
    {
        var lineStart = s.LastIndexOf('\n') + 1;
        var tail = s[lineStart..];
        return Open.StartsWith(tail, StringComparison.Ordinal) && tail.Length > 0 ? lineStart : s.Length;
    }
}
