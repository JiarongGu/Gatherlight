namespace Gatherlight.Host;

/// <summary>A warm-themed tray context menu (dark bg, amber hover, brand header + live health line
/// + grouped actions with glyphs) — matches the app instead of the default gray Windows menu.</summary>
internal static class TrayMenu
{
    public static (ContextMenuStrip Menu, ToolStripMenuItem Status) Build(HostContext ctx)
    {
        var menu = new ContextMenuStrip
        {
            Renderer = new TrayRenderer(),
            BackColor = Theme.Surface,
            ForeColor = Theme.Text,
            Font = Theme.UI(9f),
            ShowImageMargin = true,
        };

        var header = new ToolStripMenuItem("Gatherlight · 拾光")
        {
            Enabled = false,
            Image = Theme.Seal(18),
            Font = Theme.UI(10f, FontStyle.Bold),
            ForeColor = Theme.Text,
        };
        var status = new ToolStripMenuItem("●  检查中…") { Enabled = false, ForeColor = Theme.Muted };

        menu.Items.Add(header);
        menu.Items.Add(status);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("管理控制台", ctx.ShowWindow));
        menu.Items.Add(Item("在浏览器打开", ctx.OpenBrowser));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("打开数据文件夹", ctx.OpenDataFolder));
        menu.Items.Add(Item("重启服务", ctx.Restart));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("退出(停止服务)", ctx.Exit));
        return (menu, status);
    }

    /// <summary>Update the live health line (called from the shell's poll).</summary>
    public static void SetStatus(ToolStripMenuItem status, bool healthy, long latencyMs)
    {
        status.Text = healthy ? $"●  运行正常 · {latencyMs} ms" : "●  无响应";
        status.ForeColor = healthy ? Theme.Green : Theme.Red;
    }

    private static ToolStripMenuItem Item(string text, Action onClick)
    {
        var it = new ToolStripMenuItem(text) { ForeColor = Theme.Text };
        it.Click += (_, _) => onClick();
        return it;
    }
}

/// <summary>Dark warm palette for the tray menu.</summary>
internal sealed class TrayColors : ProfessionalColorTable
{
    public override Color ToolStripDropDownBackground => Theme.Surface;
    public override Color MenuBorder => Theme.Border;
    public override Color MenuItemBorder => Theme.Accent;
    public override Color MenuItemSelected => ColorTranslator.FromHtml("#312619");
    public override Color MenuItemSelectedGradientBegin => MenuItemSelected;
    public override Color MenuItemSelectedGradientEnd => MenuItemSelected;
    public override Color ImageMarginGradientBegin => Theme.Surface;
    public override Color ImageMarginGradientMiddle => Theme.Surface;
    public override Color ImageMarginGradientEnd => Theme.Surface;
    public override Color SeparatorDark => Theme.Border;
    public override Color SeparatorLight => Theme.Border;
}

internal sealed class TrayRenderer : ToolStripProfessionalRenderer
{
    public TrayRenderer() : base(new TrayColors()) { RoundedEdges = true; }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        // Enabled items: amber on hover, warm-white otherwise. Disabled items keep their own
        // ForeColor (the header stays warm, the status line stays green/red).
        e.TextColor = e.Item.Enabled ? (e.Item.Selected ? Theme.AccentHi : Theme.Text) : e.Item.ForeColor;
        base.OnRenderItemText(e);
    }
}
