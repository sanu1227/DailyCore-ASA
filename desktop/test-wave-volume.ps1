$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Rin-WaveVolume.ps1')
$source = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '..\public\assets\voices\rin-recorded-tease-fine.wav'))
$full = [RinWaveVolume]::Scale($source, 100)
$half = [RinWaveVolume]::Scale($source, 50)
$silent = [RinWaveVolume]::Scale($source, 0)
$samples = 0
for ($p = 12; $p + 8 -le $source.Length;) {
    $length = [BitConverter]::ToInt32($source, $p + 4)
    if ([Text.Encoding]::ASCII.GetString($source, $p, 4) -eq 'data') {
        for ($i = $p + 8; $i + 1 -lt $p + 8 + $length; $i += 2) {
            $sample = [BitConverter]::ToInt16($source, $i)
            if ([BitConverter]::ToInt16($full, $i) -ne $sample) { throw '100% changed PCM' }
            if ([Math]::Abs([BitConverter]::ToInt16($half, $i) - $sample / 2) -gt 0.5) { throw '50% scaling wrong' }
            if ([BitConverter]::ToInt16($silent, $i) -ne 0) { throw '0% is not silent' }
            $samples++
        }
    }
    $p += 8 + $length + ($length % 2)
}
if ($samples -lt 1000) { throw 'Missing audio samples' }
Write-Output "Volume 0/50/100 verified: $samples samples"
