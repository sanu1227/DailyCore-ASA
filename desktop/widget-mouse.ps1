$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WidgetSmokeMouse {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][WidgetSmokeMouse]::SetProcessDpiAwarenessContext([IntPtr](-4))
$original = New-Object WidgetSmokeMouse+Point
[void][WidgetSmokeMouse]::GetCursorPos([ref]$original)
$virtualX = [WidgetSmokeMouse]::GetSystemMetrics(76)
$virtualY = [WidgetSmokeMouse]::GetSystemMetrics(77)
$virtualWidth = [WidgetSmokeMouse]::GetSystemMetrics(78)
$virtualHeight = [WidgetSmokeMouse]::GetSystemMetrics(79)
function Move-Cursor([int]$x, [int]$y) {
    # Inject movement through the mouse input path so Electron's forwarding hook runs.
    $normalizedX = [uint32][Math]::Max(0, [Math]::Min(65535, [Math]::Floor(($x - $virtualX + 0.5) * 65536.0 / $virtualWidth)))
    $normalizedY = [uint32][Math]::Max(0, [Math]::Min(65535, [Math]::Floor(($y - $virtualY + 0.5) * 65536.0 / $virtualHeight)))
    [WidgetSmokeMouse]::mouse_event(0xC001, $normalizedX, $normalizedY, 0, [UIntPtr]::Zero)
}
function Assert-Point($point, $bounds) {
    if ($null -eq $bounds -or $point.x -lt $bounds.left -or $point.x -ge $bounds.right -or $point.y -lt $bounds.top -or $point.y -ge $bounds.bottom) {
        throw 'Mouse action is outside the smoke-test receiver.'
    }
}
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            $request = $line | ConvertFrom-Json
            if ($request.action -eq 'restore') {
                Move-Cursor $original.X $original.Y
                [Console]::WriteLine('{"ok":true}')
                break
            }
            if ($request.action -notin @('move', 'click', 'drag')) { throw 'Unsupported mouse action.' }
            Assert-Point $request.point $request.bounds
            if ($request.action -eq 'drag') { Assert-Point $request.end $request.bounds }
            Move-Cursor $request.point.x $request.point.y
            Start-Sleep -Milliseconds 300
            $point = New-Object WidgetSmokeMouse+Point
            [void][WidgetSmokeMouse]::GetCursorPos([ref]$point)
            if ([Math]::Abs($point.X - $request.point.x) -gt 1 -or [Math]::Abs($point.Y - $request.point.y) -gt 1) { throw 'Cursor moved during native smoke test.' }
            $target = [WidgetSmokeMouse]::GetAncestor([WidgetSmokeMouse]::WindowFromPoint($point), 2).ToInt64().ToString()
            if ($target -notin $request.handles) { throw "Unexpected window at smoke-test point: $target" }
            $styles = @($request.handles | ForEach-Object {
                $style = [WidgetSmokeMouse]::GetWindowLong([IntPtr]([long]$_), -20)
                @{ handle = $_; exStyle = $style; transparent = [bool]($style -band 0x20); layered = [bool]($style -band 0x80000) }
            })
            if ($request.action -eq 'click') {
                [WidgetSmokeMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 45
                [WidgetSmokeMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
            } elseif ($request.action -eq 'drag') {
                [WidgetSmokeMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
                try {
                    for ($step = 1; $step -le 8; $step++) {
                        $x = [int]($request.point.x + ($request.end.x - $request.point.x) * $step / 8)
                        $y = [int]($request.point.y + ($request.end.y - $request.point.y) * $step / 8)
                        Move-Cursor $x $y
                        Start-Sleep -Milliseconds 45
                    }
                } finally { [WidgetSmokeMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
            }
            [Console]::WriteLine((@{ ok = $true; target = $target; styles = $styles } | ConvertTo-Json -Compress -Depth 4))
        } catch {
            [Console]::WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
        }
    }
} finally {
    [WidgetSmokeMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Move-Cursor $original.X $original.Y
}
