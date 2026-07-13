using System.Runtime.InteropServices;

namespace Gatherlight.Host;

/// <summary>
/// DPI scaling for the WinForms shell. With PerMonitorV2 (set in the csproj) the WebView2 + control
/// layout auto-scale, but a FORM's outer size/position set in code is device px and is NOT auto-scaled
/// from a logical baseline — so persisted window bounds need an explicit logical↔physical conversion
/// (see AppHost.Load/SaveWindowState). Ported from the sibling D3dx pattern.
/// </summary>
internal static class DpiHelper
{
    private const double BaseDpi = 96.0; // Windows' 100% reference DPI

    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] private static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
    private const int LOGPIXELSX = 88;

    /// <summary>Primary-monitor scale factor in this PerMonitorV2 process (1.0 at 100%, 2.0 at 200%).</summary>
    public static double GetScaleFactor()
    {
        var hdc = GetDC(IntPtr.Zero);
        try { return GetDeviceCaps(hdc, LOGPIXELSX) / BaseDpi; }
        finally { ReleaseDC(IntPtr.Zero, hdc); }
    }

    /// <summary>Scale for a control's <see cref="Control.DeviceDpi"/> (96→1.0, 144→1.5, 192→2.0).</summary>
    public static double ScaleFromDeviceDpi(int deviceDpi) => deviceDpi > 0 ? deviceDpi / BaseDpi : 1.0;
}
