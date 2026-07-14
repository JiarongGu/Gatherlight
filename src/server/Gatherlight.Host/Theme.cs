using System.Drawing.Drawing2D;

namespace Gatherlight.Host;

/// <summary>Shared lantern-paper palette + small WinForms factory helpers, so the native window +
/// tray match the web /manage console. The palette is MODE-AWARE — light "rice paper" ↔ neutral dark,
/// mirroring the CSS variables in <c>styles.css</c> — and <see cref="ApplyMode"/> switches it when the
/// console posts its current theme, after which the host rebuilds the tray + repaints the window.</summary>
internal static class Theme
{
    /// <summary>True when the current palette is the light "rice paper" one.</summary>
    public static bool IsLight { get; private set; }

    // Current palette (set by ApplyMode). Mirrors styles.css :root (dark) / [data-theme=light].
    public static Color Bg { get; private set; }
    public static Color Rail { get; private set; }
    public static Color Surface { get; private set; }
    public static Color Surface2 { get; private set; }
    public static Color Text { get; private set; }
    public static Color Text2 { get; private set; }
    public static Color Muted { get; private set; }
    public static Color Accent { get; private set; }
    public static Color AccentHi { get; private set; }
    public static Color AccentDeep { get; private set; }
    public static Color Green { get; private set; }
    public static Color Red { get; private set; }
    public static Color Border { get; private set; }
    /// <summary>Menu-item hover fill — a soft tint of the surface, calibrated per mode.</summary>
    public static Color Hover { get; private set; }

    static Theme() => ApplyMode(light: false); // app default = neutral dark; the console posts the real mode

    /// <summary>Swap the whole palette to light ("rice paper") or neutral dark. Idempotent.</summary>
    public static void ApplyMode(bool light)
    {
        IsLight = light;
        if (light)
        {
            // [data-theme="light"] — warm ivory rice paper.
            Bg = C("#f3ecdf"); Rail = C("#efe6d5"); Surface = C("#fbf6ec"); Surface2 = C("#efe6d5");
            Text = C("#2b2119"); Text2 = C("#5c5044"); Muted = C("#8a7d64");
            Accent = C("#b85c1c"); AccentHi = C("#98491a"); AccentDeep = C("#8a3f14");
            Green = C("#4f7a4a"); Red = C("#b0432b"); Border = C("#e2d6c0"); Hover = C("#efe4d0");
        }
        else
        {
            // :root — proper neutral dark; the amber ember + celadon carry the colour.
            Bg = C("#0a0a0b"); Rail = C("#141416"); Surface = C("#141416"); Surface2 = C("#1d1d20");
            Text = C("#ebebed"); Text2 = C("#9d9da5"); Muted = C("#6a6a72");
            Accent = C("#eaa860"); AccentHi = C("#f4bd7d"); AccentDeep = C("#b85c1c");
            Green = C("#5faf63"); Red = C("#e0745c"); Border = C("#2a2a2f"); Hover = C("#26262b");
        }
    }

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
        b.FlatAppearance.MouseOverBackColor = primary ? AccentHi : Hover;
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

    /// <summary>The amber wax-seal 拾 brand mark (drawn — no binary asset). Fixed amber in BOTH
    /// themes: the brand mark is constant regardless of the surrounding light/dark surface.</summary>
    public static Bitmap Seal(int size)
    {
        var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        var r = new Rectangle(1, 1, size - 2, size - 2);
        using var path = RoundRect(r, size / 4);
        using var fill = new LinearGradientBrush(r, C("#f2b871"), C("#b85c1c"), 55f);
        g.FillPath(fill, path);
        using var font = new Font("Microsoft YaHei", size * 0.5f, FontStyle.Bold, GraphicsUnit.Pixel);
        using var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString("拾", font, Brushes.White, r, fmt);
        return bmp;
    }

    public static Icon SealIcon() => Icon.FromHandle(Seal(32).GetHicon());

    private static Color C(string hex) => ColorTranslator.FromHtml(hex);
}
