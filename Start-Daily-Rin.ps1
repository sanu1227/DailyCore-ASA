$ErrorActionPreference = 'Stop'
$rinRoot = $PSScriptRoot
& (Join-Path $rinRoot 'Start-Rin.ps1') -NoBrowser
