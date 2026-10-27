$ErrorActionPreference = 'Stop'
$rinSetupRoot = $PSScriptRoot
$rinRuntime = Join-Path $rinSetupRoot '.runtime'
New-Item -ItemType Directory -Force $rinRuntime | Out-Null
$rinExe = Join-Path $rinRuntime 'ollama\ollama.exe'
if (-not (Test-Path -LiteralPath $rinExe)) {
    $rinRelease = Invoke-RestMethod 'https://api.github.com/repos/ollama/ollama/releases/tags/v0.33.3'
    $rinAsset = $rinRelease.assets | Where-Object name -eq 'ollama-windows-amd64.zip'
    $rinZip = Join-Path $rinRuntime 'ollama.zip'
    if (-not (Test-Path -LiteralPath $rinZip)) { Invoke-WebRequest $rinAsset.browser_download_url -OutFile $rinZip -UseBasicParsing }
    if ((Get-FileHash $rinZip -Algorithm SHA256).Hash.ToLower() -ne '52cb36a62e7e501f61514f60212dec7117b6c098811357585e02fffe32d2fcd7') { throw 'Ollama download hash mismatch.' }
    Expand-Archive -LiteralPath $rinZip -DestinationPath (Join-Path $rinRuntime 'ollama') -Force
}
& (Join-Path $rinSetupRoot 'Start-LocalAI.ps1')
$rinOldHost = $env:OLLAMA_HOST
try {
    $env:OLLAMA_HOST='127.0.0.1:11435'
    & $rinExe pull qwen3:8b
    if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Run this script again to resume.' }
} finally { $env:OLLAMA_HOST=$rinOldHost }
Write-Output 'Free local AI is ready. Open Rin.cmd.'
