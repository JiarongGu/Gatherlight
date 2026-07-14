using System.Collections.Concurrent;
using System.Text;

namespace Gatherlight.Server.Modules.Core.Logging;

/// <summary>
/// A file logging provider for Microsoft.Extensions.Logging — so every module's existing
/// <c>ILogger</c> calls get persisted, making errors trackable after the fact (the console output
/// is gone once the window closes). Writes daily-rolling plain-text files to
/// <c>{data}/state/logs/{yyyy-MM-dd}.log</c> with a fixed, greppable line format; older files are
/// pruned. Ported in spirit from the sibling D3dxSkinManager's LogHelper.
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly LogSink _sink;
    private readonly LogLevel _min;

    public FileLoggerProvider(string logsDir, LogLevel min)
    {
        _sink = LogSink.For(logsDir);
        _min = min;
    }

    public ILogger CreateLogger(string category) => new FileLogger(Shorten(category), _sink, _min);
    public void Dispose() { /* the sink is process-shared + self-flushing; nothing per-provider */ }

    // Microsoft categories are full type names — keep just the class for a readable [Source] tag.
    private static string Shorten(string c)
    {
        var i = c.LastIndexOf('.');
        return i >= 0 && i < c.Length - 1 ? c[(i + 1)..] : c;
    }
}

internal sealed class FileLogger(string category, LogSink sink, LogLevel min) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel level) => level != LogLevel.None && level >= min;

    public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? ex,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(level)) return;
        sink.Write(LogSink.Format(level, category, formatter(state, ex), ex));
    }
}

/// <summary>
/// The actual file writer — one instance per logs directory (process-shared, so the WinForms host
/// crash logger and the in-process server write to the same file without contention). Appends under a
/// lock with immediate flush so a crash never loses the lines that explain it.
/// </summary>
public sealed class LogSink : IDisposable
{
    private const int KeepDays = 14;
    private static readonly UTF8Encoding NoBom = new(false);
    private static readonly ConcurrentDictionary<string, LogSink> Sinks = new(StringComparer.OrdinalIgnoreCase);

    public static LogSink For(string dir) => Sinks.GetOrAdd(Path.GetFullPath(dir), d => new LogSink(d));

    private readonly string _dir;
    private readonly object _lock = new();
    private StreamWriter? _writer;
    private string? _day;

    private LogSink(string dir)
    {
        _dir = dir;
        try { Directory.CreateDirectory(dir); Prune(); } catch { /* logging must never throw */ }
    }

    public void Write(string line)
    {
        try
        {
            lock (_lock)
            {
                var day = DateTime.Now.ToString("yyyy-MM-dd");
                if (day != _day || _writer is null)
                {
                    _writer?.Dispose();
                    _writer = new StreamWriter(Path.Combine(_dir, day + ".log"), append: true, NoBom) { AutoFlush = true };
                    _day = day;
                }
                _writer.WriteLine(line);
            }
        }
        catch { /* never let logging crash the app; fall back to stderr */ try { Console.Error.WriteLine(line); } catch { } }
    }

    /// <summary>Crash-log helper for code with no <c>ILogger</c> (the WinForms host boot path).</summary>
    public static void Crash(string logsDir, string source, string message, Exception? ex) =>
        For(logsDir).Write(Format(LogLevel.Critical, source, message, ex));

    public static string Format(LogLevel level, string source, string message, Exception? ex)
    {
        var sb = new StringBuilder(160);
        sb.Append('[').Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff")).Append("] [")
          .Append(Tag(level)).Append("] [").Append(source).Append("] ").Append(message);
        for (var e = ex; e is not null; e = e.InnerException)
        {
            sb.Append('\n').Append("  → ").Append(e.GetType().FullName).Append(": ").Append(e.Message);
            if (e.StackTrace is { Length: > 0 } st) sb.Append('\n').Append(st);
        }
        return sb.ToString();
    }

    private static string Tag(LogLevel l) => l switch
    {
        LogLevel.Trace => "TRACE",
        LogLevel.Debug => "DEBUG",
        LogLevel.Information => "INFO ",
        LogLevel.Warning => "WARN ",
        LogLevel.Error => "ERROR",
        LogLevel.Critical => "CRIT ",
        _ => "     ",
    };

    private void Prune()
    {
        var cutoff = DateTime.Now.AddDays(-KeepDays);
        foreach (var f in System.IO.Directory.GetFiles(_dir, "*.log"))
            try { if (File.GetLastWriteTime(f) < cutoff) File.Delete(f); } catch { /* best-effort */ }
    }

    public void Dispose() { lock (_lock) { _writer?.Dispose(); _writer = null; _day = null; } }
}
