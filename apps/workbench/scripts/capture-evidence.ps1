param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("ListTargets", "Screenshot")]
    [string]$Action,
    [ValidateSet("desktop", "monitor", "window")]
    [string]$TargetType = "desktop",
    [string]$TargetId = "desktop",
    [switch]$PassThruJson
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ("TraceLab.NativeWindow" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace TraceLab {
    public static class NativeWindow {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")]
        public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    }
}
"@
}

function Get-TraceLabWindows {
    $items = [System.Collections.Generic.List[object]]::new()
    $callback = [TraceLab.NativeWindow+EnumWindowsProc]{
        param([IntPtr]$handle, [IntPtr]$state)
        if (-not [TraceLab.NativeWindow]::IsWindowVisible($handle)) { return $true }
        $length = [TraceLab.NativeWindow]::GetWindowTextLength($handle)
        if ($length -le 0) { return $true }
        $builder = [Text.StringBuilder]::new($length + 1)
        [void][TraceLab.NativeWindow]::GetWindowText($handle, $builder, $builder.Capacity)
        $title = $builder.ToString().Trim()
        if (-not $title) { return $true }
        $rect = [TraceLab.NativeWindow+RECT]::new()
        if (-not [TraceLab.NativeWindow]::GetWindowRect($handle, [ref]$rect)) { return $true }
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -lt 80 -or $height -lt 60) { return $true }
        [uint32]$processId = 0
        [void][TraceLab.NativeWindow]::GetWindowThreadProcessId($handle, [ref]$processId)
        $processName = ""
        try { $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch {}
        $items.Add([ordered]@{
            id = $handle.ToInt64().ToString()
            label = if ($processName) { "$title - $processName" } else { $title }
            title = $title
            processName = $processName
            x = $rect.Left
            y = $rect.Top
            width = $width
            height = $height
        })
        return $true
    }
    [void][TraceLab.NativeWindow]::EnumWindows($callback, [IntPtr]::Zero)
    return @($items | Sort-Object processName, title)
}

function Get-TraceLabMonitors {
    return @([Windows.Forms.Screen]::AllScreens | ForEach-Object {
        [ordered]@{
            id = $_.DeviceName
            label = if ($_.Primary) { "Primary monitor ($($_.DeviceName))" } else { "Monitor $($_.DeviceName)" }
            primary = $_.Primary
            x = $_.Bounds.X
            y = $_.Bounds.Y
            width = $_.Bounds.Width
            height = $_.Bounds.Height
        }
    })
}

if ($Action -eq "ListTargets") {
    [ordered]@{
        backend = "windows"
        capturedAt = [DateTimeOffset]::Now.ToString("o")
        windows = @(Get-TraceLabWindows)
        monitors = @(Get-TraceLabMonitors)
    } | ConvertTo-Json -Compress -Depth 6
    exit 0
}

$bounds = $null
$label = "Windows desktop"
$handle = [IntPtr]::Zero
if ($TargetType -eq "desktop") {
    $bounds = [Windows.Forms.SystemInformation]::VirtualScreen
} elseif ($TargetType -eq "monitor") {
    $screen = [Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq $TargetId } | Select-Object -First 1
    if (-not $screen) { throw "Monitor not found: $TargetId" }
    $bounds = $screen.Bounds
    $label = if ($screen.Primary) { "Primary monitor ($($screen.DeviceName))" } else { "Monitor $($screen.DeviceName)" }
} else {
    $target = Get-TraceLabWindows | Where-Object { $_.id -eq $TargetId } | Select-Object -First 1
    if (-not $target) { throw "The selected window is closed or hidden. Refresh targets and retry." }
    $bounds = [Drawing.Rectangle]::new($target.x, $target.y, $target.width, $target.height)
    $label = $target.label
    $handle = [IntPtr]::new([int64]$TargetId)
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "TraceLab"
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
$outputPath = Join-Path $tempRoot ("screenshot_{0}_{1}.png" -f [DateTimeOffset]::Now.ToUnixTimeMilliseconds(), [Guid]::NewGuid().ToString("N"))
$bitmap = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$captureMethod = "CopyFromScreen"
try {
    $printed = $false
    if ($TargetType -eq "window") {
        $dc = $graphics.GetHdc()
        try { $printed = [TraceLab.NativeWindow]::PrintWindow($handle, $dc, 2) } finally { $graphics.ReleaseHdc($dc) }
        if ($printed) { $captureMethod = "PrintWindow" }
    }
    if (-not $printed) {
        $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size, [Drawing.CopyPixelOperation]::SourceCopy)
    }
    $bitmap.Save($outputPath, [Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

[ordered]@{
    path = $outputPath
    width = $bounds.Width
    height = $bounds.Height
    targetType = $TargetType
    targetId = $TargetId
    targetLabel = $label
    captureMethod = $captureMethod
    capturedAt = [DateTimeOffset]::Now.ToString("o")
} | ConvertTo-Json -Compress -Depth 4
