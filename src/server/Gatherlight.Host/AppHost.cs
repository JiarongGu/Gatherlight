using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net.Http;
using System.Text.Json;
using Gatherlight.Server;

namespace Gatherlight.Host;

/// <summary>
/// The management console: a native WinForms panel that supervises the in-process Gatherlight
/// server. It is NOT the planner UI — users open that in a browser. This window monitors site
/// health (polls /api/health, shows a rolling status strip + latency + uptime), surfaces live
/// counts (plans / library / tools), and offers host controls (open in browser, open data folder,
/// restart, stop). Closing minimizes to the tray; the server keeps serving browsers.
/// </summary>
public sealed class AppHost : Form
{
    private static readonly Color Bg = ColorTranslator.FromHtml("#15110d");
    private static readonly Color Surface = ColorTranslator.FromHtml("#1e1811");
    private static readonly Color TextC = ColorTranslator.FromHtml("#f1e9db");
    private static readonly Color Text2 = ColorTranslator.FromHtml("#c6b9a4");
    private static readonly Color Muted = ColorTranslator.FromHtml("#8d8069");
    private static readonly Color Accent = ColorTranslator.FromHtml("#e6a057");
    private static readonly Color GreenC = ColorTranslator.FromHtml("#66b06a");
    private static readonly Color RedC = ColorTranslator.FromHtml("#e0745c");
    private static readonly Color BorderC = ColorTranslator.FromHtml("#382c22");

    private const string ShowSignalName = "Gatherlight.Host.Show";
    private const int StripCapacity = 40;

    private readonly GatherlightServerOptions _options;
    private readonly string _url;
    private readonly HttpClient _http;
    private readonly DateTime _startedAt = DateTime.Now;
    private readonly NotifyIcon _tray;
    private readonly List<bool> _health = new();
    private EventWaitHandle? _showSignal;
    private bool _exiting;
    private int _consecutiveFail;

    private Label _dot = null!, _statusText = null!, _uptime = null!, _latency = null!, _stats = null!, _footer = null!;
    private LinkLabel _link = null!;
    private Panel _strip = null!;
    private CheckBox _autoRestart = null!;

    public AppHost(GatherlightServerOptions options)
    {
        _options = options;
        _url = $"http://127.0.0.1:{options.Port}/";
        _http = new HttpClient { BaseAddress = new Uri(_url), Timeout = TimeSpan.FromSeconds(4) };

        Text = "Gatherlight · 拾光";
        Icon = SealIcon();
        BackColor = Bg;
        ForeColor = TextC;
        Font = new Font("Segoe UI", 9f);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        ClientSize = new Size(468, 486);
        StartPosition = FormStartPosition.CenterScreen;

        BuildUi();

        _tray = new NotifyIcon { Icon = Icon, Text = "Gatherlight · 拾光 (管理)", Visible = true, ContextMenuStrip = BuildTrayMenu() };
        _tray.DoubleClick += (_, _) => ShowWindow();
        FormClosing += OnClosing;
        StartShowListener();

        var timer = new System.Windows.Forms.Timer { Interval = 2000 };
        timer.Tick += async (_, _) => await TickAsync();
        timer.Start();
        _ = TickAsync();
    }

    // ---- layout ----
    private void BuildUi()
    {
        var seal = new PictureBox { Image = SealBitmap(38), Size = new Size(38, 38), Location = new Point(22, 20), SizeMode = PictureBoxSizeMode.Zoom };
        Controls.Add(seal);
        Controls.Add(Lbl("Gatherlight · 拾光", 70, 20, 14f, TextC, bold: true));
        Controls.Add(Lbl("管理控制台 · Management Console", 71, 42, 8.5f, Muted));

        var card = new Panel { Location = new Point(20, 74), Size = new Size(428, 128), BackColor = Surface };
        card.Paint += (_, e) => Border(e, card);
        Controls.Add(card);

        _dot = new Label { Text = "●", ForeColor = Muted, Font = new Font("Segoe UI", 13f), AutoSize = true, Location = new Point(16, 14) };
        _statusText = Lbl("检查中…", 38, 16, 12.5f, TextC, bold: true);
        card.Controls.Add(_dot);
        card.Controls.Add(_statusText);

        _link = new LinkLabel { Text = _url, AutoSize = true, Location = new Point(18, 48), LinkColor = Accent, ActiveLinkColor = Accent, Font = new Font("Consolas", 9.5f) };
        _link.LinkClicked += (_, _) => OpenExternal(_url);
        card.Controls.Add(_link);

        _strip = new Panel { Location = new Point(18, 74), Size = new Size(394, 20), BackColor = Surface };
        _strip.Paint += DrawStrip;
        card.Controls.Add(_strip);

        _latency = Lbl("—", 18, 100, 8.5f, Muted);
        _uptime = Lbl("", 250, 100, 8.5f, Muted);
        _uptime.AutoSize = false; _uptime.Size = new Size(160, 16); _uptime.TextAlign = ContentAlignment.MiddleRight;
        card.Controls.Add(_latency);
        card.Controls.Add(_uptime);

        _stats = Lbl("计划 — · 知识库 — · 工具 —", 22, 214, 10f, Text2);
        Controls.Add(_stats);

        // buttons
        var open = Btn("在浏览器打开 Gatherlight", 20, 246, 428, primary: true, onClick: () => OpenExternal(_url));
        Controls.Add(open);
        Controls.Add(Btn("打开数据文件夹", 20, 292, 209, onClick: () => OpenExternal(_options.DataPath)));
        Controls.Add(Btn("重启服务", 239, 292, 209, onClick: Restart));

        _autoRestart = new CheckBox { Text = "无响应时自动重启服务", Location = new Point(22, 340), AutoSize = true, ForeColor = Text2, BackColor = Bg };
        Controls.Add(_autoRestart);

        Controls.Add(Btn("退出(停止服务)", 20, 372, 428, onClick: ExitApp));

        _footer = Lbl("", 22, 424, 8f, Muted);
        _footer.AutoSize = false; _footer.Size = new Size(428, 40);
        _footer.Text = $"端口 {_options.Port}\n数据 {_options.DataPath}";
        Controls.Add(_footer);
    }

    private static Label Lbl(string text, int x, int y, float size, Color color, bool bold = false) => new()
    {
        Text = text, Location = new Point(x, y), AutoSize = true, ForeColor = color, BackColor = Color.Transparent,
        Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular),
    };

    private Button Btn(string text, int x, int y, int w, bool primary = false, Action? onClick = null)
    {
        var b = new Button
        {
            Text = text, Location = new Point(x, y), Size = new Size(w, 36), FlatStyle = FlatStyle.Flat,
            ForeColor = primary ? Bg : TextC, BackColor = primary ? Accent : Surface, Cursor = Cursors.Hand,
            Font = new Font("Segoe UI", 9.5f, primary ? FontStyle.Bold : FontStyle.Regular),
        };
        b.FlatAppearance.BorderColor = primary ? Accent : BorderC;
        b.FlatAppearance.BorderSize = 1;
        b.FlatAppearance.MouseOverBackColor = primary ? ColorTranslator.FromHtml("#f2b871") : ColorTranslator.FromHtml("#281f17");
        if (onClick is not null) b.Click += (_, _) => onClick();
        return b;
    }

    private static void Border(PaintEventArgs e, Control c)
    {
        using var pen = new Pen(BorderC);
        e.Graphics.DrawRectangle(pen, 0, 0, c.Width - 1, c.Height - 1);
    }

    private void DrawStrip(object? sender, PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        const int bw = 8, gap = 2;
        var n = Math.Min(_health.Count, StripCapacity);
        for (var i = 0; i < n; i++)
        {
            var ok = _health[_health.Count - n + i];
            using var brush = new SolidBrush(ok ? GreenC : RedC);
            var x = i * (bw + gap);
            e.Graphics.FillRectangle(brush, x, 0, bw, _strip.Height);
        }
    }

    // ---- health polling ----
    private async Task TickAsync()
    {
        if (_exiting) return;
        var sw = Stopwatch.StartNew();
        bool ok;
        try
        {
            using var r = await _http.GetAsync("api/health");
            ok = r.IsSuccessStatusCode;
        }
        catch { ok = false; }
        sw.Stop();

        _health.Add(ok);
        if (_health.Count > StripCapacity * 2) _health.RemoveRange(0, _health.Count - StripCapacity);
        _consecutiveFail = ok ? 0 : _consecutiveFail + 1;

        _dot.ForeColor = ok ? GreenC : RedC;
        _statusText.Text = ok ? "运行正常 · Healthy" : "无响应 · Not responding";
        _statusText.ForeColor = ok ? TextC : RedC;
        _latency.Text = ok ? $"延迟 {sw.ElapsedMilliseconds} ms" : $"连续失败 {_consecutiveFail} 次";
        _uptime.Text = "运行 " + FormatUptime(DateTime.Now - _startedAt);
        _footer.Text = $"端口 {_options.Port} · 上次检查 {DateTime.Now:HH:mm:ss}\n数据 {_options.DataPath}";
        _strip.Invalidate();

        if (ok && _health.Count % 3 == 0) await RefreshStatsAsync();

        // Self-heal: if configured and the server has been unresponsive for a while, restart it.
        if (!ok && _autoRestart.Checked && _consecutiveFail >= 5) Restart();
    }

    private async Task RefreshStatsAsync()
    {
        try
        {
            var plans = await CountAsync("api/plans", "files");
            var lib = await LibraryTotalAsync();
            var tools = await CountAsync("api/tools", "tools");
            _stats.Text = $"计划 {plans}  ·  知识库 {lib}  ·  工具 {tools}";
        }
        catch { /* transient — leave the last values */ }
    }

    private async Task<int> CountAsync(string path, string arrayProp)
    {
        using var doc = JsonDocument.Parse(await _http.GetStringAsync(path));
        return doc.RootElement.TryGetProperty(arrayProp, out var a) && a.ValueKind == JsonValueKind.Array ? a.GetArrayLength() : 0;
    }

    private async Task<int> LibraryTotalAsync()
    {
        using var doc = JsonDocument.Parse(await _http.GetStringAsync("api/library"));
        return doc.RootElement.TryGetProperty("facets", out var f) && f.TryGetProperty("total", out var t) ? t.GetInt32() : 0;
    }

    private static string FormatUptime(TimeSpan t) =>
        t.TotalHours >= 1 ? $"{(int)t.TotalHours}h {t.Minutes}m" : t.TotalMinutes >= 1 ? $"{t.Minutes}m {t.Seconds}s" : $"{t.Seconds}s";

    // ---- tray + window ----
    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("管理控制台", null, (_, _) => ShowWindow());
        menu.Items.Add("在浏览器打开", null, (_, _) => OpenExternal(_url));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("打开数据文件夹", null, (_, _) => OpenExternal(_options.DataPath));
        menu.Items.Add("重启服务", null, (_, _) => Restart());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitApp());
        return menu;
    }

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

    private void Restart()
    {
        var exe = Environment.ProcessPath ?? Application.ExecutablePath;
        try { Process.Start(new ProcessStartInfo(exe, "--restarted") { UseShellExecute = true }); }
        catch { return; }
        ExitApp();
    }

    private void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_exiting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            ShowInTaskbar = false;
        }
    }

    private void ExitApp()
    {
        _exiting = true;
        _tray.Visible = false;
        _showSignal?.Dispose();
        Application.Exit();
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

    // ---- brand seal (drawn — no binary asset) ----
    private static Bitmap SealBitmap(int size)
    {
        var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        var r = new Rectangle(1, 1, size - 2, size - 2);
        using var path = RoundRect(r, size / 4);
        using var fill = new LinearGradientBrush(r, ColorTranslator.FromHtml("#f2b871"), ColorTranslator.FromHtml("#b85c1c"), 55f);
        g.FillPath(fill, path);
        using var font = new Font("Microsoft YaHei", size * 0.5f, FontStyle.Bold, GraphicsUnit.Pixel);
        using var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString("拾", font, Brushes.White, r, fmt);
        return bmp;
    }

    private static Icon SealIcon() => Icon.FromHandle(SealBitmap(32).GetHicon());

    private static GraphicsPath RoundRect(Rectangle r, int radius)
    {
        var d = radius * 2;
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}
