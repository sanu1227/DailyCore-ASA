$ErrorActionPreference = 'Stop'
$rinTrayPidFile = Join-Path $PSScriptRoot 'data\tray.pid'
if (Test-Path -LiteralPath $rinTrayPidFile) {
    $rinTraySavedPid = [int](Get-Content -LiteralPath $rinTrayPidFile)
    $rinTrayProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $rinTraySavedPid" -ErrorAction SilentlyContinue
    if ($rinTrayProcess -and $rinTrayProcess.Name -eq 'powershell.exe' -and $rinTrayProcess.CommandLine.Contains('Rin-Tray.ps1')) { Stop-Process -Id $rinTraySavedPid -Force }
    Remove-Item -LiteralPath $rinTrayPidFile -Force
}
$rinPidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (Test-Path -LiteralPath $rinPidFile) {
    $rinSavedPid = [int](Get-Content -LiteralPath $rinPidFile)
    $rinProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $rinSavedPid"
    $rinServerPath = Join-Path $PSScriptRoot 'app\server.mjs'
    if ($rinProcess -and $rinProcess.Name -eq 'node.exe' -and $rinProcess.CommandLine.Contains($rinServerPath)) { Stop-Process -Id $rinSavedPid }
    Remove-Item -LiteralPath $rinPidFile
}
