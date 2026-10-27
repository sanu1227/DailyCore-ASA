$ErrorActionPreference = 'Stop'
$rinProject = Split-Path $PSScriptRoot -Parent
$rinVersion = '44.4.1'
$rinCache = Join-Path $rinProject '.runtime\electron'
$rinArchive = "electron-v$rinVersion-win32-x64.zip"
$rinRelease = "https://github.com/electron/electron/releases/download/v$rinVersion"
New-Item -ItemType Directory -Force -Path $rinCache | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $rinCache $rinArchive))) {
    Invoke-WebRequest "$rinRelease/$rinArchive" -OutFile (Join-Path $rinCache $rinArchive)
}
Invoke-WebRequest "$rinRelease/SHASUMS256.txt" -OutFile (Join-Path $rinCache 'SHASUMS256.txt')
$rinExpected = ((Get-Content (Join-Path $rinCache 'SHASUMS256.txt') | Where-Object { $_ -match ('\*?' + [regex]::Escape($rinArchive) + '$') }) -split '\s+')[0]
$rinActual = (Get-FileHash (Join-Path $rinCache $rinArchive) -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $rinExpected -or $rinActual -ne $rinExpected) { throw 'Electron archive SHA256 verification failed.' }
Expand-Archive -LiteralPath (Join-Path $rinCache $rinArchive) -DestinationPath (Join-Path $rinCache 'runtime') -Force
Write-Output "Electron $rinVersion verified and ready."
