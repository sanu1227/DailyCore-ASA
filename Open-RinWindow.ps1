param([string]$Fragment = '')
$ErrorActionPreference = 'Stop'

$rinView = if ($Fragment) { $Fragment -replace '^/?#', '' } else { 'chat' }
$rinAllowedViews = @('home','chat','university','routines','activity','health','review','memory','settings')
if ($rinView -notin $rinAllowedViews) { throw 'Invalid RIN view.' }
$rinDesktop = if ($env:RIN_DESKTOP_EXE -and (Test-Path -LiteralPath $env:RIN_DESKTOP_EXE)) { $env:RIN_DESKTOP_EXE } else { Join-Path $PSScriptRoot 'dist\RIN-win32-x64\RIN.exe' }
if (-not (Test-Path -LiteralPath $rinDesktop)) { throw 'Build the desktop application first: node desktop/build.mjs' }
Start-Process -FilePath $rinDesktop -ArgumentList "--view=$rinView" -WorkingDirectory (Split-Path $rinDesktop -Parent) -WindowStyle Hidden
