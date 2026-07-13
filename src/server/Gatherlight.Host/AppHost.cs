using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using Gatherlight.Server;
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
public sealed class AppHost : Form
{
    private const string ShowSignalName = "Gatherlight.Host.Show";

    private readonly GatherlightServerOptions _options;
    private readonly string _url;
    private readonly string _manageUrl;
    private readonly HttpClient _http;
    private readonly HostContext _ctx;
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _trayStatus;
    private readonly WebView2 _web;
    private readonly Func<Task> _restartServer;
    private EventWaitHandle? _showSignal;
    private bool _exiting;
    private bool _restarting;

    public AppHost(GatherlightServerOptions options, Func<Task> restartServer)
    {
        _options = options;
        _restartServer = restartServer;
        _url = $"{(options.TlsEnabled ? "https" : "http")}://127.0.0.1:{options.Port}/";
        _manageUrl = _url + "manage";
        // With TLS on we talk to our own loopback endpoint, whose cert may be self-signed — trust it
        // (loopback only, so there's no MITM surface to protect against here).
        var handler = new HttpClientHandler();
        if (options.TlsEnabled) handler.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;
        _http = new HttpClient(handler) { BaseAddress = new Uri(_url), Timeout = TimeSpan.FromSeconds(4) };

        Text = "Gatherlight · 拾光 — 管理控制台";
        Icon = LoadAppIcon();
        BackColor = Theme.Bg;
        // Resizable + DPI-correct (PerMonitorV2 is set in the csproj; WebView2 renders crisp).
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimumSize = new Size(720, 520);
        ClientSize = new Size(940, 640);
        StartPosition = FormStartPosition.CenterScreen;
        LoadWindowState(); // restore the last position + size

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
            Restart = () => _ = RestartServerInProcessAsync(),
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
            var userData = Path.Combine(Path.GetTempPath(), "gatherlight-webview2");
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
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
        switch (action)
        {
            case "openPlanner": OpenExternal(_url); break;
            case "openDataFolder": OpenExternal(_options.DataPath); break;
            case "restart": await RestartServerInProcessAsync(); break;
            case "applyUpdate": RestartForUpdate(); break;
            case "exit": ExitApp(); break;
            case "exportMemory": await ExportMemoryAsync(); break;
            case "importMemory": await ImportMemoryAsync(); break;
        }
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

    // Recycle the in-process server — the /manage "重启服务" action + the tray "重启". Rebuilds Kestrel
    // off the UI thread (keeping the window), waits for the fresh server to answer, then reloads the
    // management view so it reconnects. Any failure falls back to a clean full process relaunch.
    private async Task RestartServerInProcessAsync()
    {
        if (_restarting || _exiting) return;
        _restarting = true;
        try
        {
            await Task.Run(_restartServer);
            for (var i = 0; i < 30; i++)
            {
                try { using var r = await _http.GetAsync("api/health"); if (r.IsSuccessStatusCode) break; } catch { /* not up yet */ }
                await Task.Delay(300);
            }
            try { _web.CoreWebView2?.Reload(); } catch { /* the view recovers on its own */ }
        }
        catch
        {
            Restart(); // in-process recycle failed (rare) → clean full relaunch
        }
        finally { _restarting = false; }
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
        if (!_exiting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            ShowInTaskbar = false;
        }
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

    private void LoadWindowState()
    {
        try
        {
            if (!File.Exists(WindowStateFile)) return;
            var s = JsonSerializer.Deserialize<WinState>(File.ReadAllText(WindowStateFile));
            if (s is null) return;
            var b = new Rectangle(s.X, s.Y, s.W, s.H);
            if (s.W >= MinimumSize.Width && s.H >= MinimumSize.Height && OnAnyScreen(b))
            {
                StartPosition = FormStartPosition.Manual;
                Bounds = b;
            }
            if (s.Max) WindowState = FormWindowState.Maximized;
        }
        catch { /* first run / bad file → default bounds */ }
    }

    private void SaveWindowState()
    {
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var s = new WinState { X = b.X, Y = b.Y, W = b.Width, H = b.Height, Max = WindowState == FormWindowState.Maximized };
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
