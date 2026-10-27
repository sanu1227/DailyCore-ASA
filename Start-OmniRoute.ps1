$ErrorActionPreference = 'Stop'
$devRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$nodeDir = Join-Path $devRoot 'Tools\node-v24.19.0-win-x64'
$node = Join-Path $nodeDir 'node.exe'
$omni = Join-Path $devRoot 'Tools\OmniRoute-cli\node_modules\omniroute\bin\omniroute.mjs'
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $omni)) { exit 0 }

$secretFile = Join-Path $env:APPDATA 'omniroute\.env'
if (Test-Path -LiteralPath $secretFile) {
    foreach ($line in Get-Content -LiteralPath $secretFile) {
        if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
}
$env:Path = "$nodeDir;$env:Path"
$env:OMNIROUTE_SERVER_HOST = '127.0.0.1'
$env:REQUIRE_API_KEY = 'true'
$env:OMNIROUTE_CLI_SKIP_REPO_ENV = '1'

if (-not (Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $node -ArgumentList @($omni, 'serve', '--no-open', '--no-tray') -WorkingDirectory (Split-Path $omni -Parent) -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue) { break }
    }
}
if (-not (Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue)) { exit 0 }

$credentialFile = Join-Path $env:APPDATA 'Rin\omniroute.key'
if (-not (Test-Path -LiteralPath $credentialFile)) { exit 0 }
# Node/Electron may inherit PowerShell 7 module paths; use this host's DPAPI cmdlet.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$secureKey = (Get-Content -LiteralPath $credentialFile -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    Write-Output ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
