$ErrorActionPreference = 'Stop'
$rinRoot = $PSScriptRoot
$rinStartup = [Environment]::GetFolderPath('Startup')
$rinLauncher = Join-Path $rinStartup 'Baek SeoA Background.lnk'
$rinExecutable = Join-Path $rinRoot 'dist\RIN-win32-x64\RIN.exe'
if (-not (Test-Path -LiteralPath $rinExecutable)) { throw 'RIN.exe를 찾을 수 없습니다. 먼저 데스크톱 앱을 빌드해 주세요.' }
$rinShell = New-Object -ComObject WScript.Shell
$rinShortcut = $rinShell.CreateShortcut($rinLauncher)
$rinShortcut.TargetPath = $rinExecutable
$rinShortcut.Arguments = '--background'
$rinShortcut.WorkingDirectory = Split-Path $rinExecutable -Parent
$rinShortcut.Description = 'Windows 로그인 시 아사 알림을 백그라운드에서 시작합니다.'
$rinShortcut.IconLocation = "$rinExecutable,0"
$rinShortcut.Save()
foreach ($rinLegacyName in @('RIN Background.lnk', 'Rin Daily Sync.lnk')) {
    $rinLegacyLauncher = Join-Path $rinStartup $rinLegacyName
    if (Test-Path -LiteralPath $rinLegacyLauncher) { Remove-Item -LiteralPath $rinLegacyLauncher }
}
Write-Output "아사 백그라운드 자동 시작을 등록했습니다: $rinLauncher"
