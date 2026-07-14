using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using Gatherlight.Server;
using Gatherlight.Server.Modules.Core.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Gatherlight.Host;

/// <summary>
/// The management app: a resizable, DPI-correct WinForms shell whose whole client area is a
/// WebView2 pointed at the server's <c>/manage</c> admin page (built with the lantern-paper web
/// design system — crisp at any DPI, resizable). It supervises the in-process server; the planner
/// itself opens in a browser. A tiny host bridge handles native actions the web can't do
/// (open the planner in the system browser, open the data folder, restart, exit, memory files).
/// </summary>
internal sealed class AppHost : Form
{
    private const string ShowSignalName = "Gatherlight.Host.Show";

    private readonly GatherlightServerOptions _options;
    private readonly ServerConfigService _config; // shared with the server: close-behaviour + live settings
    private string _url;         // mutable: a Settings restart can change the port/scheme
    private string _manageUrl;
    private HttpClient _http;
    private readonly HostContext _ctx;
    private readonly NotifyIcon _tray;
    private ToolStripMenuItem _trayStatus; // reassigned when the tray is rebuilt on a theme switch
    private readonly WebView2 _web;
    private readonly ServerControl _server; // start / stop / recycle the in-process Kestrel
    private EventWaitHandle? _showSignal;
    private bool _exiting;
    private bool _themeApplied;
    private Task _serverOp = Task.CompletedTask; // chain head: serializes start/stop/restart in order

    public AppHost(GatherlightServerOptions options, ServerConfigService config, ServerControl server)
    {
        _options = options;
        _config = config;
        _server = server;
        _url = $"{(options.TlsEnabled ? "https" : "http")}://127.0.0.1:{options.Port}/";
        _manageUrl = _url + "manage";
        _http = LoopbackClient(_url, TimeSpan.FromSeconds(4)); // the shared health-poll client

        Text = "Gatherlight · 拾光 — 管理控制台";
        Icon = LoadAppIcon();
        BackColor = Theme.Bg;
        // Resizable + DPI-correct (PerMonitorV2 is set in the csproj; WebView2 renders crisp). Window
        // size/position set in code is DEVICE px and is NOT auto-scaled, so the LOGICAL defaults +
        // persisted (logical) state are converted to physical for THIS monitor's DPI — a window saved at
        // 200% must not open giant at 100%. DPI is resolved fresh each start (each launch a possibly
        // different monitor). See Load/SaveWindowState + DpiHelper (ported from the D3dx pattern).
        var dpi = DpiHelper.GetScaleFactor();
        int Phys(int logical) => (int)Math.Round(logical * dpi);
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimumSize = new Size(Phys(720), Phys(520));
        ClientSize = new Size(Phys(960), Phys(660)); // logical default until LoadWindowState overrides
        StartPosition = FormStartPosition.CenterScreen;
        LoadWindowState(dpi); // restore the last position + size (logical → physical)

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Theme.Bg };
        Controls.Add(_web);
        _ = InitWebAsync();

        _ctx = new HostContext
        {
            Options = options,
            Url = _url,
            ShowWindow = ShowWindow,
            OpenBrowser = () => OpenExternal(_url),
            OpenDataFolder = () => OpenExternal(_options.DataPath),
            Restart = () => _ = ServerActionAsync("restart"),
            Exit = ExitApp,
        };
        var (menu, status) = TrayMenu.Build(_ctx);
        _trayStatus = status;
        _tray = new NotifyIcon { Icon = Icon, Text = "Gatherlight · 拾光 (管理)", Visible = true, ContextMenuStrip = menu };
        _tray.DoubleClick += (_, _) => ShowWindow();

        FormClosing += OnClosing;
        StartShowListener();

        var timer = new System.Windows.Forms.Timer { Interval = 3000 };
        timer.Tick += async (_, _) => await PollTrayHealthAsync();
        timer.Start();
        _ = PollTrayHealthAsync();
    }

    private async Task InitWebAsync()
    {
        try
        {
            // A dedicated user-data folder can be forced (GATHERLIGHT_WEBVIEW_USERDATA) so `host --dev`
            // gets its OWN browser process — WebView2 shares one across instances with the same folder,
            // and a pre-existing one would ignore the CDP debug-port arg.
            var userData = Environment.GetEnvironmentVariable("GATHERLIGHT_WEBVIEW_USERDATA")
                ?? Path.Combine(Path.GetTempPath(), "gatherlight-webview2");
            // Expose the WebView2 over CDP for automated desktop tests when a port is set. Passing the
            // debug-port via AdditionalBrowserArguments (in code) is more reliable than the env var.
            CoreWebView2EnvironmentOptions? opts = null;
            var cdpPort = Environment.GetEnvironmentVariable("GATHERLIGHT_WEBVIEW_CDP_PORT");
            if (!string.IsNullOrWhiteSpace(cdpPort))
                opts = new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = $"--remote-debugging-port={cdpPort}" };
            var env = await CoreWebView2Environment.CreateAsync(browserExecutableFolder: null, userDataFolder: userData, options: opts);
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            // Under TLS the loopback endpoint may present a self-signed cert — accept it, but only
            // for loopback hosts (the WebView2 only ever loads our own /manage; external links open
            // in the system browser via NewWindowRequested).
            core.ServerCertificateErrorDetected += (_, e) =>
            {
                try { if (new Uri(e.RequestUri).IsLoopback) e.Action = CoreWebView2ServerCertificateErrorAction.AlwaysAllow; }
                catch { /* leave default (reject) */ }
            };
            // Tell the page it's inside the host (so it renders host-only actions), and wire the bridge.
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__gatherlightHost = true;");
            core.WebMessageReceived += OnHostMessage;
            core.NewWindowRequested += (_, e) => { e.Handled = true; if (e.Uri is { Length: > 0 }) OpenExternal(e.Uri); };
            core.Navigate(_manageUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "无法加载内嵌视图(可能缺少 WebView2 运行时)。将用系统浏览器打开管理页。\n\n" + ex.Message,
                "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            OpenExternal(_manageUrl);
            Hide();
        }
    }

    // ---- host bridge: the web /manage page posts a string action for things the web can't do ----
    private async void OnHostMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string action;
        try { action = e.TryGetWebMessageAsString(); } catch { return; }
        // The console mirrors its current theme so the native window + tray match (light ↔ dark).
        if (action.StartsWith("theme:", StringComparison.Ordinal)) { ApplyThemeMode(action == "theme:light"); return; }
        switch (action)
        {
            case "openPlanner": OpenExternal(_url); break;
            case "openDataFolder": OpenExternal(_options.DataPath); break;
            case "openLogs":
            {
                var logs = Path.Combine(_options.DataPath, "state", "logs");
                try { Directory.CreateDirectory(logs); } catch { /* best effort */ }
                OpenExternal(logs);
                break;
            }
            case "restart":
            case "serverRestart": await ServerActionAsync("restart"); break;
            case "serverStart": await ServerActionAsync("start"); break;
            case "serverStop": await ServerActionAsync("stop"); break;
            case "applyUpdate": RestartForUpdate(); break;
            case "exit": ExitApp(); break;
            case "exportMemory": await ExportMemoryAsync(); break;
            case "importMemory": await ImportMemoryAsync(); break;
            case "exportBackup": await ExportBackupAsync(); break;
            case "importBackup": await ImportBackupAsync(); break;
        }
    }

    // An HttpClient bound to our own loopback endpoint — trusts the self-signed cert under TLS (loopback
    // only, so there's no MITM surface). Used for the shared 4 s health client and the 5 min backup
    // transfers (export streams the whole .zip; import does extract + reindex + commit).
    private static HttpClient LoopbackClient(string url, TimeSpan timeout)
    {
        var handler = new HttpClientHandler();
        if (url.StartsWith("https", StringComparison.Ordinal)) handler.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;
        return new HttpClient(handler) { BaseAddress = new Uri(url), Timeout = timeout };
    }

    private async Task ExportBackupAsync()
    {
        using var dlg = new SaveFileDialog
        {
            Filter = "Gatherlight 备份 (*.zip)|*.zip",
            FileName = $"gatherlight-backup-{DateTime.Now:yyyyMMdd-HHmmss}.zip",
            Title = "导出完整备份",
        };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            // Stream the response straight to disk — a full backup (git history + uploads) can be large;
            // buffering it all in memory (GetByteArrayAsync) would risk OOM.
            using var http = LoopbackClient(_url, TimeSpan.FromMinutes(10));
            using var resp = await http.GetAsync("api/backup/export", HttpCompletionOption.ResponseHeadersRead);
            resp.EnsureSuccessStatusCode();
            await using (var fs = File.Create(dlg.FileName))
                await resp.Content.CopyToAsync(fs);
            MessageBox.Show(this, $"已导出完整备份到:\n{dlg.FileName}\n\n(整个数据文件夹:计划 · 家庭 · 知识库 · git 历史 · 记忆)", "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) { MessageBox.Show(this, "导出失败:" + ex.Message, "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private async Task ImportBackupAsync()
    {
        using var dlg = new OpenFileDialog { Filter = "Gatherlight 备份 (*.zip)|*.zip", Title = "从备份恢复" };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        if (MessageBox.Show(this, "恢复将覆盖当前的计划 / 家庭 / 知识库,并合并记忆。确定继续?", "Gatherlight",
            MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
        try
        {
            // Stream the file up rather than reading it all into memory first.
            using var http = LoopbackClient(_url, TimeSpan.FromMinutes(10));
            await using var fs = File.OpenRead(dlg.FileName);
            using var content = new StreamContent(fs);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/zip");
            using var res = await http.PostAsync("api/backup/import", content);
            var text = await res.Content.ReadAsStringAsync();
            if (!res.IsSuccessStatusCode) throw new Exception(text);
            MessageBox.Show(this, "已从备份恢复。\n" + text, "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Information);
            try { _web.CoreWebView2?.Reload(); } catch { }
        }
        catch (Exception ex) { MessageBox.Show(this, "恢复失败:" + ex.Message, "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private async Task ExportMemoryAsync()
    {
        using var dlg = new SaveFileDialog
        {
            Filter = "Gatherlight 记忆 (*.json)|*.json",
            FileName = $"gatherlight-memory-{DateTime.Now:yyyyMMdd}.json",
            Title = "导出记忆",
        };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            var bytes = await _http.GetByteArrayAsync("api/memory/export");
            await File.WriteAllBytesAsync(dlg.FileName, bytes);
            MessageBox.Show(this, $"已导出记忆到:\n{dlg.FileName}", "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) { MessageBox.Show(this, "导出失败:" + ex.Message, "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private async Task ImportMemoryAsync()
    {
        using var dlg = new OpenFileDialog { Filter = "Gatherlight 记忆 (*.json)|*.json", Title = "导入记忆" };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            using var body = new StringContent(await File.ReadAllTextAsync(dlg.FileName), System.Text.Encoding.UTF8, "application/json");
            using var res = await _http.PostAsync("api/memory/import", body);
            var text = await res.Content.ReadAsStringAsync();
            if (!res.IsSuccessStatusCode) throw new Exception(text);
            MessageBox.Show(this, "已导入记忆(合并 upsert)。\n" + text, "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Information);
            try { _web.CoreWebView2?.Reload(); } catch { }
        }
        catch (Exception ex) { MessageBox.Show(this, "导入失败:" + ex.Message, "Gatherlight", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    // ---- light health poll — only to keep the tray status line live ----
    private async Task PollTrayHealthAsync()
    {
        if (_exiting) return;
        var sw = Stopwatch.StartNew();
        bool ok;
        try { using var r = await _http.GetAsync("api/health"); ok = r.IsSuccessStatusCode; }
        catch { ok = false; }
        sw.Stop();
        TrayMenu.SetStatus(_trayStatus, ok, sw.ElapsedMilliseconds);
    }

    // ---- window + tray behavior ----
    private void ShowWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        ShowInTaskbar = true;
        Activate();
        BringToFront();
    }

    private static void OpenExternal(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { /* best effort */ }
    }

    // The shipped multi-resolution app icon (amber 拾 seal), embedded in the exe; falls back to the
    // hand-drawn seal if the resource is somehow unavailable.
    private static Icon LoadAppIcon()
    {
        try
        {
            using var stream = typeof(AppHost).Assembly.GetManifestResourceStream("Gatherlight.Host.gatherlight.ico");
            if (stream is not null) return new Icon(stream);
        }
        catch { /* fall back */ }
        return Theme.SealIcon();
    }

    // Drive the in-process server lifecycle — the /manage Controls + tray actions. Actions are CHAINED
    // (never dropped), so a quick Stop→Start or a double-click runs in order rather than the second
    // one being silently swallowed. The heavy work is serialized again in Program by the server gate.
    private Task ServerActionAsync(string kind) // "start" | "stop" | "restart"
    {
        if (_exiting) return Task.CompletedTask;
        var prev = _serverOp;
        return _serverOp = ChainServerActionAsync(prev, kind);
    }

    // One link of the action chain: wait for the previous action, then (re)build / tear down Kestrel.
    // "start"/"restart" build off the UI thread (keeping the window), wait for the fresh server to
    // answer, then reload the view so it reconnects; "stop" tears it down (the SPA stays rendered, its
    // health poll goes red). A start/restart failure falls back to a clean full process relaunch.
    private async Task ChainServerActionAsync(Task prev, string kind)
    {
        try { await prev; } catch { /* a prior action's failure must not block the next */ }
        if (_exiting) return;
        try
        {
            if (kind == "stop")
            {
                await Task.Run(_server.Stop);
                TrayMenu.SetStatus(_trayStatus, healthy: false, 0); // intentionally down — no need to poll a dead port
                return;
            }

            var newUrl = kind == "start" ? await Task.Run(_server.Start) : await Task.Run(_server.Restart);
            // A Settings restart can change the port/scheme — re-point the host client + WebView.
            var urlChanged = !string.Equals(newUrl, _url, StringComparison.Ordinal);
            if (urlChanged)
            {
                _url = newUrl;
                _manageUrl = _url + "manage";
                _http.Dispose();
                _http = LoopbackClient(_url, TimeSpan.FromSeconds(4));
            }
            for (var i = 0; i < 40; i++)
            {
                try { using var r = await _http.GetAsync("api/health"); if (r.IsSuccessStatusCode) break; } catch { /* not up yet */ }
                await Task.Delay(300);
            }
            try { if (urlChanged) _web.CoreWebView2?.Navigate(_manageUrl); else _web.CoreWebView2?.Reload(); } catch { /* the view recovers on its own */ }
        }
        catch
        {
            if (kind != "stop") Restart(); // (re)start failed (rare) → clean full relaunch
        }
    }

    // Repaint the native window + rebuild the tray to match the theme the console posted (light ↔ dark),
    // so the whole app reads as one piece regardless of which theme the user runs.
    private void ApplyThemeMode(bool light)
    {
        if (_themeApplied && Theme.IsLight == light) return;
        _themeApplied = true;
        Theme.ApplyMode(light);
        BackColor = Theme.Bg;
        try { _web.DefaultBackgroundColor = Theme.Bg; } catch { /* not ready yet */ }
        var previous = _tray.ContextMenuStrip;
        var (menu, status) = TrayMenu.Build(_ctx);
        _trayStatus = status;
        _tray.ContextMenuStrip = menu;
        previous?.Dispose();
        _ = PollTrayHealthAsync(); // refresh the status line's colour + text under the new palette
    }

    // Full process relaunch — the fallback for RestartServerInProcessAsync, and the path
    // RestartForUpdate uses (via the launcher).
    private void Restart()
    {
        var exe = Environment.ProcessPath ?? Application.ExecutablePath;
        try { Process.Start(new ProcessStartInfo(exe, "--restarted") { UseShellExecute = true }); } catch { return; }
        ExitApp();
    }

    // Restart THROUGH the native launcher (Gatherlight.exe at the install root, a sibling of libs/)
    // so it applies the staged update before relaunching the host. Falls back to a plain restart when
    // there is no launcher (dev / bare-exe run) — the staged update then applies whenever the launcher
    // is next used.
    private void RestartForUpdate()
    {
        var launcher = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Gatherlight.exe"));
        if (!File.Exists(launcher)) { Restart(); return; }
        try
        {
            Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(launcher)! });
        }
        catch { Restart(); return; }
        ExitApp();
    }

    private void OnClosing(object? sender, FormClosingEventArgs e)
    {
        SaveWindowState();
        // Only intercept the user pressing the window ✕. Programmatic exits (tray「退出」, bridge "exit",
        // Application.Exit) already set _exiting / aren't UserClosing and must close straight through.
        if (_exiting || e.CloseReason != CloseReason.UserClosing) return;

        var action = (_config.Current.HostCloseAction ?? "ask").Trim().ToLowerInvariant();
        if (action == "ask")
        {
            var (chosen, remember) = AskCloseAction();
            if (chosen is null) { e.Cancel = true; return; } // cancelled → stay open
            if (remember) { try { _config.Update(c => c.HostCloseAction = chosen); } catch { /* best effort */ } }
            action = chosen;
        }

        if (action == "exit")
        {
            // Let the close proceed → Application.Run returns → Program stops the server. Clean up the
            // tray + listener here (Application.Exit isn't needed; the form is already on its way out).
            _exiting = true;
            _tray.Visible = false;
            _showSignal?.Dispose();
            return;
        }

        // Default ("tray"): minimize to the tray and keep serving in the background.
        e.Cancel = true;
        Hide();
        ShowInTaskbar = false;
    }

    // Native "regular application" close prompt: minimize-to-tray vs exit, with a remember checkbox
    // that persists the choice (also changeable in Settings). Returns (action, remember) where action
    // is "tray"/"exit", or (null, _) when the user cancels (Esc / ✕ / Cancel) → the window stays open.
    private (string? action, bool remember) AskCloseAction()
    {
        var tray = new TaskDialogButton("最小化到托盘  ·  Minimize to tray");
        var exit = new TaskDialogButton("退出  ·  Exit");
        var verify = new TaskDialogVerificationCheckBox("记住我的选择(可在「设置」中更改)");
        var page = new TaskDialogPage
        {
            Caption = "Gatherlight · 拾光",
            Heading = "关闭管理控制台?",
            Text = "服务会在后台继续运行。要最小化到托盘,还是完全退出?",
            Icon = TaskDialogIcon.Information,
            AllowCancel = true,
            Verification = verify,
            Buttons = { tray, exit },
            DefaultButton = tray,
        };
        var result = TaskDialog.ShowDialog(this, page);
        if (result == tray) return ("tray", verify.Checked);
        if (result == exit) return ("exit", verify.Checked);
        return (null, false);
    }

    private void ExitApp()
    {
        SaveWindowState();
        _exiting = true;
        _tray.Visible = false;
        _showSignal?.Dispose();
        Application.Exit();
    }

    // ---- window position + size persistence ----
    private string WindowStateFile => Path.Combine(_options.DataPath, "state", "host-window.json");

    // Stored state is LOGICAL px (DPI-independent) → convert to PHYSICAL for the current monitor DPI.
    private void LoadWindowState(double dpi)
    {
        try
        {
            if (!File.Exists(WindowStateFile)) return;
            var s = JsonSerializer.Deserialize<WinState>(File.ReadAllText(WindowStateFile));
            if (s is null) return;
            int w = (int)Math.Round(s.W * dpi), h = (int)Math.Round(s.H * dpi);
            int x = (int)Math.Round(s.X * dpi), y = (int)Math.Round(s.Y * dpi);
            if (w >= MinimumSize.Width && h >= MinimumSize.Height)
            {
                var b = new Rectangle(x, y, w, h);
                if (OnAnyScreen(b)) { StartPosition = FormStartPosition.Manual; Bounds = b; }
                else Size = new Size(w, h); // valid size, off-screen position (monitor unplugged) → keep centered
            }
            if (s.Max) WindowState = FormWindowState.Maximized;
        }
        catch { /* first run / bad file → default bounds */ }
    }

    // Persist LOGICAL px (÷ this monitor's DPI) so the window restores correctly at ANY DPI next launch;
    // the DPI itself is never stored.
    private void SaveWindowState()
    {
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            double scale = DpiHelper.ScaleFromDeviceDpi(DeviceDpi);
            var s = new WinState
            {
                X = (int)Math.Round(b.X / scale), Y = (int)Math.Round(b.Y / scale),
                W = (int)Math.Round(b.Width / scale), H = (int)Math.Round(b.Height / scale),
                Max = WindowState == FormWindowState.Maximized,
            };
            Directory.CreateDirectory(Path.GetDirectoryName(WindowStateFile)!);
            File.WriteAllText(WindowStateFile, JsonSerializer.Serialize(s));
        }
        catch { /* best effort */ }
    }

    private static bool OnAnyScreen(Rectangle b)
    {
        foreach (var sc in Screen.AllScreens)
            if (sc.WorkingArea.IntersectsWith(b)) return true;
        return false;
    }

    private sealed class WinState
    {
        public int X { get; set; }
        public int Y { get; set; }
        public int W { get; set; }
        public int H { get; set; }
        public bool Max { get; set; }
    }

    private void StartShowListener()
    {
        _showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowSignalName);
        new Thread(() =>
        {
            while (!_exiting)
            {
                try { if (!_showSignal.WaitOne(500)) continue; } catch { return; }
                if (_exiting) return;
                try { BeginInvoke(ShowWindow); } catch { return; }
            }
        }) { IsBackground = true }.Start();
    }

    public static void SignalShowExisting()
    {
        try { if (EventWaitHandle.TryOpenExisting(ShowSignalName, out var h)) { h.Set(); h.Dispose(); } }
        catch { /* nothing to signal */ }
    }
}
