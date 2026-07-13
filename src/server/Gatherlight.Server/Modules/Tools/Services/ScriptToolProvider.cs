using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services;

/// <summary>
/// Hot-loadable script tools: each {data}/tools/&lt;name&gt;/tool.json declares a tool (schema +
/// command); the script receives the validated args as JSON on STDIN and prints the result to
/// stdout (stderr = logs). A debounced watcher reloads the set on any change, so creating a tool
/// needs NO rebuild — it appears on HTTP + MCP immediately. Built-in C# tools win on name
/// collision. Scripts run with server privileges: they are authored by the user (or a dev
/// session), never by the chat agent — the scope guard keeps the agent out of tools/.
/// </summary>
public interface IScriptToolProvider
{
    IReadOnlyList<IGatherlightTool> Current { get; }
}

public sealed class ScriptToolProvider : IScriptToolProvider, IHostedService, IDisposable
{
    private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(1);

    private readonly IDataContext _data;
    private readonly ILogger<ScriptToolProvider> _log;
    private FileSystemWatcher? _watcher;
    private Timer? _timer;
    private volatile IReadOnlyList<IGatherlightTool> _current = Array.Empty<IGatherlightTool>();

    public ScriptToolProvider(IDataContext data, ILogger<ScriptToolProvider> log)
    {
        _data = data;
        _log = log;
    }

    public IReadOnlyList<IGatherlightTool> Current => _current;

    public string ToolsRoot => Path.Combine(_data.RootPath, "tools");

    public Task StartAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(ToolsRoot);
        Reload();
        _watcher = new FileSystemWatcher(ToolsRoot)
        {
            IncludeSubdirectories = true,
            Filter = "tool.json",
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite,
        };
        FileSystemEventHandler onChange = (_, _) => Schedule();
        _watcher.Changed += onChange;
        _watcher.Created += onChange;
        _watcher.Deleted += onChange;
        _watcher.Renamed += (_, _) => Schedule();
        _watcher.EnableRaisingEvents = true;
        return Task.CompletedTask;
    }

    private void Schedule()
    {
        _timer ??= new Timer(_ => Reload(), null, Timeout.Infinite, Timeout.Infinite);
        _timer.Change(Debounce, Timeout.InfiniteTimeSpan);
    }

    private void Reload()
    {
        var tools = new List<IGatherlightTool>();
        foreach (var manifestPath in Directory.EnumerateFiles(ToolsRoot, "tool.json", SearchOption.AllDirectories))
        {
            try
            {
                var tool = ScriptTool.FromManifest(manifestPath);
                if (tools.Any(t => t.Name == tool.Name))
                {
                    _log.LogWarning("Duplicate script tool name '{Name}' ({Path}) — skipped", tool.Name, manifestPath);
                    continue;
                }
                tools.Add(tool);
            }
            catch (Exception ex)
            {
                // A broken manifest never takes the server (or the other tools) down.
                _log.LogWarning(ex, "Invalid tool manifest skipped: {Path}", manifestPath);
            }
        }
        _current = tools;
        _log.LogInformation("Script tools loaded: {Count} ({Names})",
            tools.Count, string.Join(", ", tools.Select(t => t.Name)));
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (_watcher is not null) _watcher.EnableRaisingEvents = false;
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _watcher?.Dispose();
        _timer?.Dispose();
    }
}

/// <summary>One script tool instance, built from its tool.json manifest.</summary>
public sealed class ScriptTool : IGatherlightTool
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private readonly string _dir;
    private readonly string _exe;
    private readonly List<string> _args;
    private readonly int _timeoutSeconds;

    private ScriptTool(string name, string description, string inputSchema,
        IReadOnlyList<string>? surfaces, string dir, string exe, List<string> args, int timeoutSeconds)
    {
        Name = name;
        Description = description;
        InputSchema = inputSchema;
        Surfaces = surfaces;
        _dir = dir;
        _exe = exe;
        _args = args;
        _timeoutSeconds = timeoutSeconds;
    }

    public string Name { get; }
    public string Description { get; }
    public string InputSchema { get; }
    public IReadOnlyList<string>? Surfaces { get; }

    public static ScriptTool FromManifest(string manifestPath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
        var root = doc.RootElement;
        var name = root.GetProperty("name").GetString();
        if (string.IsNullOrWhiteSpace(name) || !name.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c is '_' or '-'))
            throw new InvalidOperationException("name must be non-empty kebab/snake-case ascii");
        var command = root.GetProperty("command");
        var exe = command.GetProperty("exe").GetString()
            ?? throw new InvalidOperationException("command.exe required");
        var args = command.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Array
            ? a.EnumerateArray().Select(x => x.GetString() ?? "").ToList()
            : new List<string>();
        var timeout = root.TryGetProperty("timeoutSeconds", out var t) && t.TryGetInt32(out var ts)
            ? Math.Clamp(ts, 1, 300) : 60;
        var surfaces = root.TryGetProperty("surfaces", out var s) && s.ValueKind == JsonValueKind.Array
            ? s.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
            : null;
        var schema = root.TryGetProperty("inputSchema", out var sch) && sch.ValueKind == JsonValueKind.Object
            ? sch.GetRawText()
            : """{"type":"object","properties":{},"required":[]}""";
        return new ScriptTool(
            name,
            root.TryGetProperty("description", out var d) ? d.GetString() ?? name : name,
            schema, surfaces, Path.GetDirectoryName(manifestPath)!, exe, args, timeout);
    }

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _exe,
            WorkingDirectory = _dir,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardInputEncoding = Utf8NoBom,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        foreach (var a in _args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi) ?? throw new ToolException(500, $"无法启动工具进程:{_exe}");
        await proc.StandardInput.WriteAsync(args.GetRawText());
        proc.StandardInput.Close();
        var stdoutTask = proc.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = proc.StandardError.ReadToEndAsync(ct);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));
        try
        {
            await proc.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            if (ct.IsCancellationRequested) throw;
            throw new ToolException(504, $"工具 {Name} 超时({_timeoutSeconds}s)");
        }
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (proc.ExitCode != 0)
        {
            var tail = stderr.Length > 400 ? stderr[^400..] : stderr;
            throw new ToolException(500, $"工具 {Name} 退出码 {proc.ExitCode}:{tail.Trim()}");
        }
        return stdout.Trim();
    }
}
