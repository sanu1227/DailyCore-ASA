$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RinForegroundWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    public static uint IdleSeconds() {
        var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
        return GetLastInputInfo(ref info) ? (uint)(Environment.TickCount - info.dwTime) / 1000 : 0;
    }
}
'@

$rinPid = [uint32]0
$rinHandle = [RinForegroundWindow]::GetForegroundWindow()
[void][RinForegroundWindow]::GetWindowThreadProcessId($rinHandle, [ref]$rinPid)
$rinProcess = Get-Process -Id $rinPid -ErrorAction Stop
$rinLauncherNames = @('steam', 'epicgameslauncher', 'riotclientservices', 'leagueclientux', 'battle.net', 'galaxyclient', 'goggalaxy', 'client')
$rinKnownGameNames = @('nikke')
$rinKnownPaths = @(Get-ChildItem -LiteralPath 'HKCU:\System\GameConfigStore\Children' -ErrorAction SilentlyContinue |
    ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).MatchedExeFullPath } |
    Where-Object { $_ })

function Get-RinWindowBounds([IntPtr]$handle) {
    $rect = New-Object RinForegroundWindow+RECT
    if ([RinForegroundWindow]::GetWindowRect($handle, [ref]$rect) -and $rect.Right -gt $rect.Left -and $rect.Bottom -gt $rect.Top) {
        return [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
    }
    return $null
}
function Test-RinGameProcess($process) {
    $name = $process.ProcessName.ToLowerInvariant()
    if ($rinKnownGameNames -contains $name) { return $true }
    if ($rinLauncherNames -contains $name) { return $false }
    $path = try { $process.MainModule.FileName } catch { '' }
    if (-not $path) { return $false }
    $known = $rinKnownPaths | Where-Object { $_ -ieq $path } | Select-Object -First 1
    $gamePath = $path -match '(?i)\\steamapps\\common\\|\\Epic Games\\|\\Riot Games\\|\\XboxGames\\|\\GOG Galaxy\\Games\\|\\HoYoPlay\\games\\|\\Overwatch\\|\\curseforge\\minecraft\\|\\Google\\Play Games\\current\\emulator\\'
    return [bool]($known -or $gamePath)
}

$rinName = $rinProcess.ProcessName
$rinWindowBounds = Get-RinWindowBounds $rinHandle
$rinIsGame = Test-RinGameProcess $rinProcess
$rinVisibleGameBounds = if ($rinIsGame) { $rinWindowBounds } else { $null }
if (-not $rinVisibleGameBounds) {
    $rinVisibleGame = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $rinPid } | ForEach-Object {
        if (-not (Test-RinGameProcess $_)) { return }
        $bounds = Get-RinWindowBounds $_.MainWindowHandle
        if ($bounds) { [pscustomobject]@{ bounds = $bounds; area = [long]$bounds.width * [long]$bounds.height } }
    } | Sort-Object area -Descending | Select-Object -First 1
    if ($rinVisibleGame) { $rinVisibleGameBounds = $rinVisibleGame.bounds }
}

[pscustomobject]@{ isGame = $rinIsGame; name = $rinName; idleSeconds = [RinForegroundWindow]::IdleSeconds(); windowBounds = $rinWindowBounds; visibleGameWindowBounds = $rinVisibleGameBounds } | ConvertTo-Json -Compress
