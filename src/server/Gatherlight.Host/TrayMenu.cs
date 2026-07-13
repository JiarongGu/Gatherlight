using System.Drawing.Drawing2D;

namespace Gatherlight.Host;

/// <summary>A crafted warm tray menu: no image gutter, inset rounded amber hover, roomy padding,
/// a brand header + live health line + grouped actions — not the default gray Windows menu.</summary>
internal static class TrayMenu
{
    public static (ContextMenuStrip Menu, ToolStripMenuItem Status) Build(HostContext ctx)
    {
        var menu = new ContextMenuStrip
        {
            Renderer = new TrayRenderer(),
            BackColor = Theme.Surface,
            ForeColor = Theme.Text,
            Font = Theme.UI(9.5f),
            ShowImageMargin = false,
            ShowCheckMargin = false,
            Padding = new Padding(6, 6, 6, 6),
        };

        var header = new ToolStripMenuItem("Gatherlight · 拾光")
        {
            Enabled = false,
            Font = Theme.UI(10.5f, FontStyle.Bold),
            ForeColor = Theme.Text,
            Padding = new Padding(2, 3, 2, 1),
        };
        var status = new ToolStripMenuItem("●  检查中…") { Enabled = false, ForeColor = Theme.Muted, Padding = new Padding(2, 0, 2, 4) };

        menu.Items.Add(header);
        menu.Items.Add(status);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("管理控制台", ctx.ShowWindow));
        menu.Items.Add(Item("在浏览器打开规划界面", ctx.OpenBrowser));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("打开数据文件夹", ctx.OpenDataFolder));
        menu.Items.Add(Item("重启服务", ctx.Restart));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item("退出", ctx.Exit));
        return (menu, status);
    }

    public static void SetStatus(ToolStripMenuItem status, bool healthy, long latencyMs)
    {
        status.Text = healthy ? $"●  运行正常 · {latencyMs} ms" : "●  无响应";
        status.ForeColor = healthy ? Theme.Green : Theme.Red;
    }

    private static ToolStripMenuItem Item(string text, Action onClick)
    {
        var it = new ToolStripMenuItem(text) { ForeColor = Theme.Text, Padding = new Padding(2, 4, 2, 4) };
        it.Click += (_, _) => onClick();
        return it;
    }
}

internal sealed class TrayRenderer : ToolStripRenderer
{
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
    {
        e.Graphics.Clear(Theme.Surface);
    }

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        using var pen = new Pen(Theme.Border);
        var r = e.AffectedBounds;
        e.Graphics.DrawRectangle(pen, 0, 0, r.Width - 1, r.Height - 1);
    }

    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        if (!e.Item.Selected || !e.Item.Enabled) return;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(3, 1, e.Item.Width - 6, e.Item.Height - 2);
        using var path = Theme.RoundRect(r, 7);
        using var fill = new SolidBrush(ColorTranslator.FromHtml("#312619"));
        e.Graphics.FillPath(fill, path);
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        e.TextColor = e.Item.Enabled ? (e.Item.Selected ? Theme.AccentHi : Theme.Text) : e.Item.ForeColor;
        e.TextRectangle = new Rectangle(e.TextRectangle.X + 10, e.TextRectangle.Y, e.TextRectangle.Width - 12, e.TextRectangle.Height);
        e.TextFormat |= TextFormatFlags.VerticalCenter | TextFormatFlags.Left;
        base.OnRenderItemText(e);
    }

    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        using var pen = new Pen(Theme.Border);
        var y = e.Item.Height / 2;
        e.Graphics.DrawLine(pen, 10, y, e.Item.Width - 10, y);
    }
}
