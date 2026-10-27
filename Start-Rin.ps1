param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$rinRoot = $PSScriptRoot
$rinDesktop = Join-Path $rinRoot 'dist\RIN-win32-x64\RIN.exe'
if (Test-Path -LiteralPath $rinDesktop) {
    $rinDesktopArgs = if ($NoBrowser) { '--background' } else { '--view=chat' }
    Start-Process -FilePath $rinDesktop -ArgumentList $rinDesktopArgs -WorkingDirectory (Split-Path $rinDesktop -Parent) -WindowStyle Hidden
    if ($NoBrowser) {
        $rinReady = $false
        for ($rinAttempt = 0; $rinAttempt -lt 40; $rinAttempt++) {
            try { $rinHealth = Invoke-RestMethod 'http://127.0.0.1:4317/api/health' -TimeoutSec 1; if ($rinHealth.app -eq 'rin-companion') { $rinReady = $true; break } } catch {}
            Start-Sleep -Milliseconds 250
        }
        if (-not $rinReady) { throw 'Seo-a desktop backend did not become ready.' }
    }
    return
}
$rinUrl = 'http://127.0.0.1:4317'
$rinRunning = $false
try {
    $rinHealth = Invoke-RestMethod -Uri "$rinUrl/api/health" -TimeoutSec 2
    $rinRunning = $rinHealth.app -eq 'rin-companion'
} catch {}
if (-not $rinRunning) {
    $rinNodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $rinNodePath = if ($rinNodeCommand) { $rinNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
    if (-not (Test-Path -LiteralPath $rinNodePath)) { throw 'Node.js 24 or later is required.' }
    $rinData = Join-Path $rinRoot 'data'
    New-Item -ItemType Directory -Path $rinData -Force | Out-Null
    $rinProcess = Start-Process -FilePath $rinNodePath -ArgumentList @(('"' + (Join-Path $rinRoot 'app\server.mjs') + '"')) -WorkingDirectory $rinRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $rinData 'server.log') -RedirectStandardError (Join-Path $rinData 'server-error.log')
    $rinProcess.Id | Set-Content -LiteralPath (Join-Path $rinData 'server.pid')
    for ($rinAttempt = 0; $rinAttempt -lt 30; $rinAttempt++) {
        Start-Sleep -Milliseconds 200
        try { $rinHealth = Invoke-RestMethod -Uri "$rinUrl/api/health" -TimeoutSec 1; if ($rinHealth.app -eq 'rin-companion') { $rinRunning = $true; break } } catch {}
        if ($rinProcess.HasExited) { break }
    }
    if (-not $rinRunning) { throw 'Seo-a could not start. See data/server-error.log.' }
}
$rinTrayPidFile = Join-Path $rinRoot 'data\tray.pid'
$rinTrayRunning = $false
if (Test-Path -LiteralPath $rinTrayPidFile) {
    $rinTraySavedPid = [int](Get-Content -LiteralPath $rinTrayPidFile)
    $rinTrayProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $rinTraySavedPid" -ErrorAction SilentlyContinue
    $rinTrayRunning = [bool]($rinTrayProcess -and $rinTrayProcess.Name -eq 'powershell.exe' -and $rinTrayProcess.CommandLine.Contains('Rin-Tray.ps1'))
}
if (-not $rinTrayRunning) {
    $rinTrayScript = Join-Path $rinRoot 'Rin-Tray.ps1'
    $rinTray = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',('"' + $rinTrayScript + '"')) -WorkingDirectory $rinRoot -WindowStyle Hidden -PassThru
    $rinTray.Id | Set-Content -LiteralPath $rinTrayPidFile
}
if (-not $NoBrowser) { & (Join-Path $rinRoot 'Open-RinWindow.ps1') }
Write-Output "Seo-a: $rinUrl"
