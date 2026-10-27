$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'public\assets\voices'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$voice = 'Microsoft Heami Desktop'
$lines = @(
    @{ File = 'rin-soft-01.wav'; Rate = '+8%'; Pitch = '+2st'; Text = '잠깐, 알림 왔어. 확인은 해 둬.' },
    @{ File = 'rin-soft-02.wav'; Rate = '+5%'; Pitch = '+2st'; Text = '있잖아, 놓치면 곤란한 알림이야. 지금 봐.' },
    @{ File = 'rin-soft-03.wav'; Rate = '+10%'; Pitch = '+3st'; Text = '또 집중하고 있었어? 알림 하나 왔거든.' },
    @{ File = 'rin-priority-01.wav'; Rate = '+12%'; Pitch = '+3st'; Text = '잠깐! 게임은 거기까지. 급한 일부터 확인해.' },
    @{ File = 'rin-priority-02.wav'; Rate = '+9%'; Pitch = '+2st'; Text = '또 미루는 거야? 이번 판 끝나면 바로 시작해.' },
    @{ File = 'rin-priority-03.wav'; Rate = '+11%'; Pitch = '+3st'; Text = '중요한 알림이야. 못 들은 척하면 정말 화낼 거니까.' },
    @{ File = 'rin-review-01.wav'; Rate = '+3%'; Pitch = '+1st'; Text = '오늘 하루, 제대로 정리해 봐. 내가 같이 봐 줄게.' },
    @{ File = 'rin-review-02.wav'; Rate = '+1%'; Pitch = '+1st'; Text = '수고했어. 이제 오늘 한 일을 천천히 확인하자.' }
)

foreach ($line in $lines) {
    $path = Join-Path $output $line.File
    $text = [Security.SecurityElement]::Escape($line.Text)
    $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ko-KR'><voice name='$voice'><prosody rate='$($line.Rate)' pitch='$($line.Pitch)' volume='95'>$text</prosody></voice></speak>"
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $synth.SelectVoice($voice)
        $synth.SetOutputToWaveFile($path)
        $synth.SpeakSsml($ssml)
    } finally {
        $synth.Dispose()
    }
}
