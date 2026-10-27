$ErrorActionPreference = 'Stop'
$rinStartup = [Environment]::GetFolderPath('Startup')
foreach ($rinName in @('Baek SeoA Background.lnk', 'RIN Background.lnk', 'Rin Daily Sync.lnk')) {
    $rinLauncher = Join-Path $rinStartup $rinName
    if (Test-Path -LiteralPath $rinLauncher) { Remove-Item -LiteralPath $rinLauncher }
}
Write-Output '아사 백그라운드 자동 시작을 해제했습니다.'
