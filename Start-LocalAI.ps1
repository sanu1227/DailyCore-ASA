$ErrorActionPreference = 'Stop'
$rinAIRoot = $PSScriptRoot
$rinAIExe = Join-Path $rinAIRoot '.runtime\ollama\ollama.exe'
if (-not (Test-Path -LiteralPath $rinAIExe)) { throw 'Run Setup-LocalAI.ps1 first.' }
$rinAIReady = $false
try { $null = Invoke-RestMethod 'http://127.0.0.1:11435/api/version' -TimeoutSec 2; $rinAIReady = $true } catch {}
if (-not $rinAIReady) {
    New-Item -ItemType Directory -Force (Join-Path $rinAIRoot 'data') | Out-Null
    # Dedicated process settings: do not alter the user's global Ollama configuration.
    $rinAIVars = @{ OLLAMA_HOST='127.0.0.1:11435'; OLLAMA_NO_CLOUD='1'; OLLAMA_MODELS=(Join-Path $rinAIRoot '.runtime\models'); OLLAMA_CONTEXT_LENGTH='16384'; OLLAMA_NUM_PARALLEL='1'; OLLAMA_FLASH_ATTENTION='1'; OLLAMA_KV_CACHE_TYPE='q8_0' }
    $rinAIOld = @{}
    try {
        foreach ($rinAIName in $rinAIVars.Keys) { $rinAIOld[$rinAIName] = [Environment]::GetEnvironmentVariable($rinAIName, 'Process'); [Environment]::SetEnvironmentVariable($rinAIName, $rinAIVars[$rinAIName], 'Process') }
        $rinAIProcess = Start-Process -FilePath $rinAIExe -ArgumentList 'serve' -WorkingDirectory $rinAIRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $rinAIRoot 'data\ollama.log') -RedirectStandardError (Join-Path $rinAIRoot 'data\ollama-error.log')
        $rinAIProcess.Id | Set-Content -LiteralPath (Join-Path $rinAIRoot 'data\ollama.pid')
    } finally {
        foreach ($rinAIName in $rinAIVars.Keys) { [Environment]::SetEnvironmentVariable($rinAIName, $rinAIOld[$rinAIName], 'Process') }
    }
    for ($rinAIAttempt=0; $rinAIAttempt -lt 60; $rinAIAttempt++) {
        Start-Sleep -Milliseconds 500
        try { $null = Invoke-RestMethod 'http://127.0.0.1:11435/api/version' -TimeoutSec 1; $rinAIReady=$true; break } catch {}
        if ($rinAIProcess.HasExited) { break }
    }
    if (-not $rinAIReady) { throw 'Local AI could not start. See data/ollama-error.log.' }
}
