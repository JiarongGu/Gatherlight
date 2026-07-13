# make-icon.ps1 — generate the canonical Gatherlight app icon (src/assets/gatherlight.ico).
# Draws the lantern-paper "拾" seal (amber gradient rounded square + white glyph) at every size
# Windows wants, and packs them into one .ico using 32-bit BMP (DIB) frames — the format GDI+/WinForms
# reads at every size (PNG-in-ICO breaks GDI+'s legacy Icon parser at 256px). Run once; the .ico is
# committed as a binary asset and consumed by the desktop host (ApplicationIcon + window/tray) and the
# C++ launcher (.rc).
#
#   powershell -ExecutionPolicy Bypass -File devtools/scripts/make-icon.ps1
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outDir = Join-Path $repo 'src\assets'
$out = Join-Path $outDir 'gatherlight.ico'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256

# lantern-paper amber (matches the app accent) + white glyph
$amberTop = [System.Drawing.Color]::FromArgb(255, 244, 181, 106)  # #f4b56a
$amberBot = [System.Drawing.Color]::FromArgb(255, 224, 154, 72)   # #e09a48
$ink      = [System.Drawing.Color]::FromArgb(255, 255, 248, 238)  # warm white

function New-SealBitmap([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [math]::Max(1, [int]($s * 0.06))
    $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($s - 2 * $pad), ($s - 2 * $pad))
    $radius = [float]($s * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($rect.Left, $rect.Top, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Top, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.Left, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $amberTop, $amberBot, 55.0)
    $g.FillPath($brush, $path)

    $fontSize = [float]($s * 0.56)
    $font = New-Object System.Drawing.Font('Microsoft YaHei', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $inkBrush = New-Object System.Drawing.SolidBrush($ink)
    $glyphRect = New-Object System.Drawing.RectangleF(0, [float](-$s * 0.02), $s, $s)
    $g.DrawString([char]0x62FE, $font, $inkBrush, $glyphRect, $fmt)

    $g.Dispose()
    return $bmp
}

# Build a 32bpp BMP (DIB) ICO frame from a bitmap: BITMAPINFOHEADER + BGRA pixels (bottom-up) +
# a zeroed 1bpp AND mask (transparency comes from the alpha channel). Returns the frame bytes.
function New-DibFrame([System.Drawing.Bitmap]$bmp) {
    $s = $bmp.Width
    $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
    $bits = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $bits.Stride
    $src = New-Object byte[] ($stride * $s)
    [System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $src, 0, $src.Length)
    $bmp.UnlockBits($bits)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    # BITMAPINFOHEADER (biHeight = 2*s: XOR image stacked over the AND mask)
    $bw.Write([uint32]40); $bw.Write([int32]$s); $bw.Write([int32]($s * 2))
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
    $bw.Write([uint32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
    # XOR pixel data — bottom-up rows, BGRA (GDI+ 32bppArgb is already BGRA in memory)
    for ($y = $s - 1; $y -ge 0; $y--) { $bw.Write($src, $y * $stride, $s * 4) }
    # AND mask — 1bpp, rows padded to 4 bytes, all zero (alpha handles transparency)
    $maskRow = [int]([math]::Floor(($s + 31) / 32)) * 4
    $bw.Write((New-Object byte[] ($maskRow * $s)), 0, $maskRow * $s)
    $bw.Flush()
    return , $ms.ToArray()
}

$frames = @{}
foreach ($s in $sizes) {
    $bmp = New-SealBitmap $s
    $frames[$s] = New-DibFrame $bmp
    $bmp.Dispose()
}

# assemble the ICO container
$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ico)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
    $data = [byte[]]$frames[$s]
    $dim = if ($s -ge 256) { [byte]0 } else { [byte]$s }
    $bw.Write($dim); $bw.Write($dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length); $bw.Write([uint32]$offset)
    $offset += $data.Length
}
foreach ($s in $sizes) { $bw.Write([byte[]]$frames[$s]) }
$bw.Flush()

[System.IO.File]::WriteAllBytes($out, $ico.ToArray())
$bw.Dispose()

$kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "wrote $out  ($($sizes.Count) sizes, $kb KB)"
