using System.Drawing.Drawing2D;

namespace Gatherlight.Host;

/// <summary>A crafted lantern-paper tray menu — not the default gray Windows menu: no image gutter,
/// an inset rounded hover tint, roomy aligned padding, a brand header + live health line + grouped
/// actions. Colours come from <see cref="Theme"/> so it matches whichever theme the console is in;
/// the host rebuilds it via <see cref="Build"/> when the mode changes.</summary>
internal static class TrayMenu
{
    // One shared horizontal inset for header / status / items / separators so everything left-aligns.
    private const int TextInset = 13;

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
            Padding = new Padding(7, 8, 7, 8),
            MinimumSize = new Size(232, 0),
        };

        var header = new ToolStripMenuItem("Gatherlight · 拾光")
        {
            Enabled = false,
            Font = Theme.UI(10.5f, FontStyle.Bold),
            ForeColor = Theme.Text,
            Padding = new Padding(2, 4, 2, 2),
        };
        var status = new ToolStripMenuItem("●  检查中…")
        {
            Enabled = false,
            Font = Theme.UI(9f),
            ForeColor = Theme.Muted,
            Padding = new Padding(2, 0, 2, 5),
        };

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
        var it = new ToolStripMenuItem(text) { ForeColor = Theme.Text, Padding = new Padding(2, 6, 2, 6) };
        it.Click += (_, _) => onClick();
        return it;
    }

    internal static int Inset => TextInset;
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
        var r = new Rectangle(4, 1, e.Item.Width - 8, e.Item.Height - 2);
        using var path = Theme.RoundRect(r, 7);
        using var fill = new SolidBrush(Theme.Hover);
        e.Graphics.FillPath(fill, path);
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        e.TextColor = e.Item.Enabled ? (e.Item.Selected ? Theme.AccentHi : Theme.Text) : e.Item.ForeColor;
        var inset = TrayMenu.Inset;
        // Center within the FULL item height (Y=0..Height), not the padding-offset content rectangle —
        // the item's asymmetric top/bottom Padding otherwise pushes VerticalCenter text downward.
        e.TextRectangle = new Rectangle(e.TextRectangle.X + inset, 0, e.TextRectangle.Width - inset - 4, e.Item.Height);
        e.TextFormat |= TextFormatFlags.VerticalCenter | TextFormatFlags.Left;
        base.OnRenderItemText(e);
    }

    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        using var pen = new Pen(Theme.Border);
        var y = e.Item.Height / 2;
        e.Graphics.DrawLine(pen, TrayMenu.Inset, y, e.Item.Width - TrayMenu.Inset, y);
    }
}
