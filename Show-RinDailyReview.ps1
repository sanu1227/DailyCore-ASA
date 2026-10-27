param(
    [Parameter(Mandatory = $true)][string]$TitleBase64,
    [Parameter(Mandatory = $true)][string]$BodyBase64,
    [string]$ItemId = '',
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$BaseUrl = 'http://127.0.0.1:4317',
    [int]$PreviewSeconds = 0,
    [string]$GameWindowBase64 = '',
    [string]$ReadyPath = '',
    [ValidateSet('review')][string]$Sound = 'review',
    [ValidateRange(0,100)][int]$Volume = 70
)
$ErrorActionPreference = 'Stop'
if ($ItemId -eq '__RIN_EMPTY__') { $ItemId = '' }
if ($GameWindowBase64 -eq '__RIN_EMPTY__') { $GameWindowBase64 = '' }
function Start-RinSound {
    $soundScript = Join-Path $PSScriptRoot 'Play-RinSound.ps1'
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $soundScript + '"'), $Sound, '-Volume', $Volume)
}
$rinCreated = $false
$rinMutex = New-Object Threading.Mutex($true, 'Local\RinDailyReviewPopup', [ref]$rinCreated)
if (-not $rinCreated) { throw '이미 표시 중인 아사 하루 결산이 있습니다.' }

try {
    Add-Type -AssemblyName PresentationFramework, PresentationCore, System.Windows.Forms
    $rinTitle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleBase64))
    $rinBody = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BodyBase64))
    function Get-RinTargetWorkArea {
        $screens = @([Windows.Forms.Screen]::AllScreens)
        $target = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1
        if ($target) { return $target.WorkingArea }
        return [Windows.SystemParameters]::WorkArea
    }
    $rinTargetWorkArea = Get-RinTargetWorkArea
    if (-not $rinTargetWorkArea) {
        if ($ReadyPath) { Set-Content -LiteralPath $ReadyPath -Value 'suppressed' -Encoding Ascii }
        return
    }
    $rinWindow = New-Object Windows.Window
    $rinWindow.Title = '아사 하루 결산'; $rinWindow.Width = 760; $rinWindow.Height = 560
    $rinWindow.Topmost = $true; $rinWindow.ShowInTaskbar = $true
    $rinWindow.WindowStyle = 'None'; $rinWindow.ResizeMode = 'NoResize'; $rinWindow.AllowsTransparency = $true; $rinWindow.Background = [Windows.Media.Brushes]::Transparent

    $rinBorder = New-Object Windows.Controls.Border
    $rinBorder.Background = [Windows.Media.BrushConverter]::new().ConvertFromString('#F6F3EE')
    $rinBorder.BorderBrush = [Windows.Media.BrushConverter]::new().ConvertFromString('#BCBAB5')
    $rinBorder.BorderThickness = '1'; $rinBorder.CornerRadius = '18'; $rinBorder.Padding = '32'
    $rinShadow = New-Object Windows.Media.Effects.DropShadowEffect
    $rinShadow.Color = [Windows.Media.ColorConverter]::ConvertFromString('#292B2F'); $rinShadow.BlurRadius = 26; $rinShadow.ShadowDepth = 7; $rinShadow.Opacity = 0.25
    $rinBorder.Effect = $rinShadow
    $rinWindow.Content = $rinBorder
    $rinPanel = New-Object Windows.Controls.StackPanel; $rinBorder.Child = $rinPanel
    $rinHero = New-Object Windows.Controls.Grid; $rinHero.Height = 165
    $rinHero.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition -Property @{ Width = '154' }))
    $rinHero.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition -Property @{ Width = '*' }))
    $rinPortrait = New-Object Windows.Controls.Border
    $rinPortrait.Width = 146; $rinPortrait.Height = 146; $rinPortrait.CornerRadius = '73'; $rinPortrait.Background = [Windows.Media.BrushConverter]::new().ConvertFromString('#E7E8E6'); $rinPortrait.ClipToBounds = $true
    $rinImagePath = Join-Path $PSScriptRoot 'public\assets\asa\portrait.jpg'
    if ($rinImagePath -and (Test-Path -LiteralPath $rinImagePath)) {
        $rinBitmap = New-Object Windows.Media.Imaging.BitmapImage
        $rinBitmap.BeginInit(); $rinBitmap.CacheOption = 'OnLoad'; $rinBitmap.UriSource = [Uri]::new($rinImagePath); $rinBitmap.EndInit()
        $rinImage = New-Object Windows.Controls.Image; $rinImage.Source = $rinBitmap; $rinImage.Stretch = 'UniformToFill'; $rinPortrait.Child = $rinImage
    }
    [Windows.Controls.Grid]::SetColumn($rinPortrait, 0); $rinHero.Children.Add($rinPortrait) | Out-Null
    $rinHeroCopy = New-Object Windows.Controls.StackPanel; $rinHeroCopy.Margin = '22,8,0,0'
    [Windows.Controls.Grid]::SetColumn($rinHeroCopy, 1); $rinHero.Children.Add($rinHeroCopy) | Out-Null
    $rinLabel = New-Object Windows.Controls.TextBlock
    $rinLabel.Text = '아사  ·  오늘 결산'; $rinLabel.FontSize = 13; $rinLabel.FontWeight = 'Bold'; $rinLabel.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString('#34373C')
    $rinHeroCopy.Children.Add($rinLabel) | Out-Null
    $rinHeading = New-Object Windows.Controls.TextBlock
    $rinHeading.Text = $rinTitle; $rinHeading.FontSize = 30; $rinHeading.FontWeight = 'SemiBold'; $rinHeading.Margin = '0,10,0,0'; $rinHeading.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString('#292B2F'); $rinHeading.TextTrimming = 'CharacterEllipsis'
    $rinHeroCopy.Children.Add($rinHeading) | Out-Null
    $rinPanel.Children.Add($rinHero) | Out-Null
    $rinMessage = New-Object Windows.Controls.TextBlock
    $rinMessage.Text = $rinBody; $rinMessage.FontSize = 18; $rinMessage.LineHeight = 30; $rinMessage.TextWrapping = 'Wrap'; $rinMessage.Height = 230; $rinMessage.Margin = '6,12,6,0'
    $rinMessage.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString('#4A4B4E')
    $rinPanel.Children.Add($rinMessage) | Out-Null
    $rinButtons = New-Object Windows.Controls.StackPanel
    $rinButtons.Orientation = 'Horizontal'; $rinButtons.HorizontalAlignment = 'Center'; $rinButtons.Margin = '0,12,0,0'
    $rinPanel.Children.Add($rinButtons) | Out-Null

    function Add-RinReviewButton([string]$label, [string]$action, [bool]$primary) {
        $button = New-Object Windows.Controls.Button
        $button.Content = $label; $button.MinWidth = 132; $button.Height = 50; $button.Margin = '7,0'; $button.Padding = '17,8'; $button.FontSize = 15; $button.FontWeight = 'SemiBold'; $button.Cursor = 'Hand'
        $button.BorderBrush = [Windows.Media.BrushConverter]::new().ConvertFromString('#BCBAB5')
        if ($primary) { $button.Background = [Windows.Media.BrushConverter]::new().ConvertFromString('#34373C'); $button.Foreground = [Windows.Media.Brushes]::White }
        else { $button.Background = [Windows.Media.BrushConverter]::new().ConvertFromString('#F6F3EE'); $button.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString('#4C5157') }
        $button.Add_Click({
            try {
                if ($PreviewSeconds -gt 0) { $rinWindow.Close(); return }
                if ($action -eq 'health') { Start-Process "$BaseUrl/#health" }
                elseif ($action -eq 'review') { Start-Process "$BaseUrl/#review" }
                elseif ($action -eq 'focus') {
                    $headers = @{ 'X-Rin-Token' = $Token }
                    $payload = @{ action = 'focus'; itemId = $ItemId } | ConvertTo-Json -Compress
                    Invoke-RestMethod -Uri "$BaseUrl/api/reminder/action" -Method Post -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 5 | Out-Null
                }
                $rinWindow.Close()
            } catch { [Windows.MessageBox]::Show('아사 앱에 연결하지 못했어. Asa.cmd 실행 상태를 확인해.', '아사') | Out-Null }
        }.GetNewClosure())
        $rinButtons.Children.Add($button) | Out-Null
    }
    if ($ItemId) { Add-RinReviewButton '25분 집중' 'focus' $true }
    Add-RinReviewButton '생활 기록' 'health' (-not [bool]$ItemId)
    Add-RinReviewButton '결산 열기' 'review' $false
    Add-RinReviewButton '확인했어' 'close' $false

    $rinWindow.Add_Loaded({
        $area = $rinTargetWorkArea
        $rinWindow.Width = [Math]::Min($rinWindow.Width, $area.Width - 48); $rinWindow.Height = [Math]::Min($rinWindow.Height, $area.Height - 48)
        $rinWindow.Left = $area.Left + (($area.Width - $rinWindow.Width) / 2); $rinWindow.Top = $area.Top + (($area.Height - $rinWindow.Height) / 2)
        $rinWindow.Activate() | Out-Null
        if ($ReadyPath) { Set-Content -LiteralPath $ReadyPath -Value 'ready' -Encoding Ascii }
        Start-RinSound
    })
    if ($PreviewSeconds -gt 0) {
        $rinTimer = New-Object Windows.Threading.DispatcherTimer; $rinTimer.Interval = [TimeSpan]::FromSeconds($PreviewSeconds)
        $rinTimer.Add_Tick({ $rinTimer.Stop(); $rinWindow.Close() }); $rinTimer.Start()
    }
    $rinWindow.ShowDialog() | Out-Null
} finally {
    if ($rinCreated) { $rinMutex.ReleaseMutex() }
    $rinMutex.Dispose()
}
