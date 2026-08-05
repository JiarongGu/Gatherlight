using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Capabilities.Sandbox.Services;
using Gatherlight.Server.Platform.Capabilities.Services;
using Gatherlight.Server.Platform.Capabilities.Tools.Models;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Capabilities.Tools.Services;

/// <summary>
/// Hot-loadable script tools: each {data}/tools/&lt;name&gt;/tool.json declares a tool (schema +
/// command); the script receives the validated args as JSON on STDIN and prints the result to
/// stdout (stderr = logs). A debounced watcher reloads the set on any change, so creating a tool
/// needs NO rebuild — it appears on HTTP + MCP immediately. Built-in C# tools win on name
/// collision. Unlike built-ins, a script tool did NOT come from the platform: it is off until
/// <c>site.json</c>'s <c>capabilities.enabled</c> names it, and it runs sandboxed
/// (<see cref="ICapabilityLauncher"/>), never with the server's own privileges. Authored by the
/// user (or a dev session), never by the chat agent — the scope guard keeps the agent out of tools/.
/// </summary>
public interface IScriptToolProvider
{
    IReadOnlyList<IGatherlightTool> Current { get; }

    /// <summary>Force an immediate rescan, bypassing the debounce. The watcher already reloads on a
    /// <c>tool.json</c> file event, but a manifest-only change (nothing enables/allows a capability by
    /// touching a script's own file) never fires that watcher — a grant written straight to
    /// <c>site.json</c> (draft promotion aside, which also drops a new file) needs this to take effect
    /// before the run that requested it resumes.</summary>
    void Reload();
}

public sealed class ScriptToolProvider : IScriptToolProvider, IHostedService, IDisposable
{
    private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(1);

    private readonly ISiteContext _data;
    private readonly ISiteManifestStore _manifest;
    private readonly ICapabilityLauncher _launcher;
    private readonly ISessionCapabilityAllowance _sessionAllowance;
    private readonly ILogger<ScriptToolProvider> _log;
    private FileSystemWatcher? _watcher;
    private Timer? _timer;
    private volatile IReadOnlyList<IGatherlightTool> _current = Array.Empty<IGatherlightTool>();

    public ScriptToolProvider(ISiteContext data, ISiteManifestStore manifest,
        ICapabilityLauncher launcher, ISessionCapabilityAllowance sessionAllowance, ILogger<ScriptToolProvider> log)
    {
        _data = data;
        _manifest = manifest;
        _launcher = launcher;
        _sessionAllowance = sessionAllowance;
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

    public void Reload()
    {
        var tools = new List<IGatherlightTool>();
        // Resolved fresh each pass — via Load(), NOT the cached .Current — so a site.json edit
        // (enable/deny) takes effect on the next reload: either a tool.json touch (the watcher) or
        // the next process start. ISiteManifestStore.Current caches indefinitely after first read
        // (by design, elsewhere: a singleton pinning a manifest for the process lifetime is exactly
        // right for e.g. the chat scope guard), so this is the one caller that deliberately forces a
        // re-read. A manifest caught mid external write (new-tool, or a hand edit) falls back to the
        // last-known-good one instead of taking every script tool down with it — same "broken input
        // never takes healthy tools down" contract as the per-tool try/catch below.
        IReadOnlyList<CapabilityGrant> enabledGrants;
        try { enabledGrants = _manifest.Load().Capabilities.Enabled; }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "site.json reload failed — keeping last-known capabilities.enabled");
            enabledGrants = _manifest.Current.Capabilities.Enabled;
        }
        // Persisted grants first, then the chat escalation gate's session-only ("allow once") grants
        // layered on top — a plain loop rather than Concat().ToDictionary() because the latter throws
        // on a duplicate id, and here a duplicate is not an error: the session grant is a deliberate,
        // more-recent human decision and is meant to win.
        var enabled = new Dictionary<string, CapabilityGrant>(StringComparer.OrdinalIgnoreCase);
        foreach (var g in enabledGrants) if (g.Id.Length > 0) enabled[g.Id] = g;
        foreach (var g in _sessionAllowance.Current) if (g.Id.Length > 0) enabled[g.Id] = g;
        foreach (var manifestPath in Directory.EnumerateFiles(ToolsRoot, "tool.json", SearchOption.AllDirectories))
        {
            try
            {
                var tool = ScriptTool.FromManifest(manifestPath, _launcher,
                    name => enabled.TryGetValue(name, out var g) ? g : null);
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

/// <summary>One script tool instance, built from its tool.json manifest. Spawns through
/// <see cref="ICapabilityLauncher"/> — the sandbox, not this class, owns process construction; a
/// null <see cref="_grant"/> (no matching <c>capabilities.enabled</c> entry) refuses to run.</summary>
public sealed class ScriptTool : IGatherlightTool
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private readonly string _dir;
    private readonly string _entryFile;
    private readonly int _timeoutSeconds;
    private readonly ICapabilityLauncher _launcher;
    private readonly CapabilityGrant? _grant;

    private ScriptTool(string name, string description, string inputSchema,
        IReadOnlyList<string>? surfaces, string dir, string entryFile, int timeoutSeconds,
        ICapabilityLauncher launcher, CapabilityGrant? grant)
    {
        Name = name;
        Description = description;
        InputSchema = inputSchema;
        Surfaces = surfaces;
        _dir = dir;
        _entryFile = entryFile;
        _timeoutSeconds = timeoutSeconds;
        _launcher = launcher;
        _grant = grant;
    }

    public string Name { get; }
    public string Description { get; }
    public string InputSchema { get; }
    public IReadOnlyList<string>? Surfaces { get; }

    /// <summary><paramref name="grantFor"/> resolves the tool's own name against
    /// <c>capabilities.enabled</c> — null when there is no matching entry.</summary>
    public static ScriptTool FromManifest(string manifestPath, ICapabilityLauncher launcher,
        Func<string, CapabilityGrant?> grantFor)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
        var root = doc.RootElement;
        var name = root.GetProperty("name").GetString();
        if (string.IsNullOrWhiteSpace(name) || !name.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c is '_' or '-'))
            throw new InvalidOperationException("name must be non-empty kebab/snake-case ascii");
        var command = root.GetProperty("command");
        var exe = command.GetProperty("exe").GetString()
            ?? throw new InvalidOperationException("command.exe required");
        // The sandbox is a node sandbox: ICapabilityLauncher only knows how to enforce node
        // --permission. A manifest naming any other runtime cannot be contained, so it is rejected
        // at load — same as any other broken manifest — rather than run unsandboxed.
        if (!string.Equals(Path.GetFileNameWithoutExtension(exe), "node", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                $"tool '{name}' declares command.exe='{exe}' — only node is sandboxable; rejected at load");
        var args = command.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Array
            ? a.EnumerateArray().Select(x => x.GetString() ?? "").ToList()
            : new List<string>();
        // The launcher composes the sandbox flags and appends a SINGLE entry file; it has no argv
        // slot beyond that. Only the first element of command.args is honoured as that entry file —
        // any further elements are no longer forwarded. This has never mattered in practice (every
        // shipped/scaffolded manifest lists exactly one arg): the script contract is stdin-JSON-in,
        // stdout-JSON-out, never argv.
        if (args.Count == 0)
            throw new InvalidOperationException(
                $"tool '{name}' command.args must name the entry script as its first element");
        var entryFile = args[0];
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
            schema, surfaces, Path.GetDirectoryName(manifestPath)!, entryFile, timeout,
            launcher, grantFor(name));
    }

    public async Task<string> RunAsync(JsonElement args, CancellationToken ct)
    {
        // Defence in depth: Task 6's registry already hides an unlisted tool from both surfaces, but
        // a tool object that could still execute when nothing lists it would be a latent hole.
        if (_grant is null)
            throw new ToolException(403, $"工具 {Name} 未在 site.json 的 capabilities.enabled 中启用,拒绝运行。");

        var psi = _launcher.Build(_grant, _dir, _entryFile);
        // The launcher owns sandbox argv; the stdin/stdout JSON contract is this class's to keep,
        // including the BOM-less UTF-8 the rest of the platform relies on for CJK content.
        psi.StandardInputEncoding = Utf8NoBom;
        psi.StandardOutputEncoding = Utf8NoBom;
        psi.StandardErrorEncoding = Utf8NoBom;

        using var proc = Process.Start(psi) ?? throw new ToolException(500, $"无法启动工具进程:{Name}");
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
