param(
    [Parameter(Mandatory = $true)][ValidateSet('soft', 'priority', 'review', 'greeting', 'casual', 'away', 'break', 'meal', 'study', 'bedtime', 'success')][string]$Sound,
    [switch]$ValidateOnly,
    [ValidateRange(0,100)][int]$Volume = 70
)
$ErrorActionPreference = 'Stop'
# Keep legacy recordings archived; Seo-a currently uses only quiet chimes.
$chime = if ($Sound -eq 'priority') { 'rin-priority-chime.wav' } elseif ($Sound -eq 'review') { 'rin-review-chime.wav' } else { 'rin-soft-chime.wav' }
$path = Join-Path $PSScriptRoot "public\assets\sounds\$chime"
# Share the existing lock with card and popup processes during upgrades.
$mutex = New-Object Threading.Mutex($false, 'Local\RinRecordedVoicePlayback')
$locked = $false
$player = $null
$stream = $null
try {
    if ($Volume -eq 0 -and -not $ValidateOnly) { return }
    try { $locked = $mutex.WaitOne(60000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Seo-a notification sound queue timed out.' }
    . (Join-Path $PSScriptRoot 'Rin-WaveVolume.ps1')
    $bytes = [RinWaveVolume]::Scale([IO.File]::ReadAllBytes($path), $Volume)
    $stream = New-Object IO.MemoryStream(,$bytes)
    $player = New-Object System.Media.SoundPlayer $stream
    $player.Load()
    if ($ValidateOnly) { Write-Output $path }
    else { $player.PlaySync() }
} finally {
    if ($player) { $player.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
