using System.Drawing.Drawing2D;

namespace Gatherlight.Host;

/// <summary>Shared lantern-paper palette + small WinForms factory helpers, so every page/menu of the
/// management app looks the same (and new pages are cheap to add).</summary>
internal static class Theme
{
    public static readonly Color Bg = C("#15110d");
    public static readonly Color Rail = C("#1a140e");
    public static readonly Color Surface = C("#1e1811");
    public static readonly Color Surface2 = C("#281f17");
    public static readonly Color Text = C("#f1e9db");
    public static readonly Color Text2 = C("#c6b9a4");
    public static readonly Color Muted = C("#8d8069");
    public static readonly Color Accent = C("#e6a057");
    public static readonly Color AccentHi = C("#f2b871");
    public static readonly Color AccentDeep = C("#b85c1c");
    public static readonly Color Green = C("#66b06a");
    public static readonly Color Red = C("#e0745c");
    public static readonly Color Border = C("#382c22");

    public static Font UI(float size, FontStyle style = FontStyle.Regular) => new("Segoe UI", size, style);

    public static string Uptime(TimeSpan t) =>
        t.TotalHours >= 1 ? $"{(int)t.TotalHours}h {t.Minutes}m"
        : t.TotalMinutes >= 1 ? $"{t.Minutes}m {t.Seconds}s"
        : $"{t.Seconds}s";

    public static Label Label(string text, float size, Color color, bool bold = false) => new()
    {
        Text = text,
        AutoSize = true,
        ForeColor = color,
        BackColor = Color.Transparent,
        Font = UI(size, bold ? FontStyle.Bold : FontStyle.Regular),
    };

    public static Button Button(string text, bool primary = false)
    {
        var b = new Button
        {
            Text = text,
            Height = 36,
            FlatStyle = FlatStyle.Flat,
            ForeColor = primary ? Bg : Text,
            BackColor = primary ? Accent : Surface2,
            Cursor = Cursors.Hand,
            Font = UI(9.5f, primary ? FontStyle.Bold : FontStyle.Regular),
            UseVisualStyleBackColor = false,
        };
        b.FlatAppearance.BorderColor = primary ? Accent : Border;
        b.FlatAppearance.BorderSize = 1;
        b.FlatAppearance.MouseOverBackColor = primary ? AccentHi : C("#312619");
        return b;
    }

    public static void Card(PaintEventArgs e, Control c)
    {
        using var pen = new Pen(Border);
        e.Graphics.DrawRectangle(pen, 0, 0, c.Width - 1, c.Height - 1);
    }

    public static GraphicsPath RoundRect(Rectangle r, int radius)
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

    /// <summary>The amber wax-seal 拾 brand mark (drawn — no binary asset).</summary>
    public static Bitmap Seal(int size)
    {
        var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        var r = new Rectangle(1, 1, size - 2, size - 2);
        using var path = RoundRect(r, size / 4);
        using var fill = new LinearGradientBrush(r, AccentHi, AccentDeep, 55f);
        g.FillPath(fill, path);
        using var font = new Font("Microsoft YaHei", size * 0.5f, FontStyle.Bold, GraphicsUnit.Pixel);
        using var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString("拾", font, Brushes.White, r, fmt);
        return bmp;
    }

    public static Icon SealIcon() => Icon.FromHandle(Seal(32).GetHicon());

    private static Color C(string hex) => ColorTranslator.FromHtml(hex);
}
