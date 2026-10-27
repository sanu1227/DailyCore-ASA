$ErrorActionPreference = 'Stop'
$rinRoot = $PSScriptRoot
$rinBaseUrl = 'http://127.0.0.1:4317'
$rinCreated = $false
$rinMutex = New-Object Threading.Mutex($true, 'Local\RinCompanionTray', [ref]$rinCreated)
if (-not $rinCreated) { exit 0 }

try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $rinContext = New-Object Windows.Forms.ApplicationContext
    $rinNotify = New-Object Windows.Forms.NotifyIcon
    $rinBitmap = New-Object Drawing.Bitmap 32, 32
    $rinGraphics = [Drawing.Graphics]::FromImage($rinBitmap)
    $rinGraphics.SmoothingMode = 'AntiAlias'; $rinGraphics.Clear([Drawing.Color]::Transparent)
    $rinBrush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(41, 43, 47))
    $rinGraphics.FillEllipse($rinBrush, 1, 1, 30, 30)
    $rinFont = New-Object Drawing.Font 'Segoe UI', 17, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
    $rinTextBrush = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
    $rinGraphics.DrawString('A', $rinFont, $rinTextBrush, 7, 5)
    $rinNotify.Icon = [Drawing.Icon]::FromHandle($rinBitmap.GetHicon())
    $rinNotify.Text = '아사'; $rinNotify.Visible = $true

    $rinMenu = New-Object Windows.Forms.ContextMenuStrip
    $rinStatus = $rinMenu.Items.Add('아사 연결 확인 중…'); $rinStatus.Enabled = $false
    $rinPriority = $rinMenu.Items.Add('가장 급한 일정 확인 중…'); $rinPriority.Enabled = $false
    [void]$rinMenu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
    $rinOpen = $rinMenu.Items.Add('아사 열기')
    $rinReview = $rinMenu.Items.Add('하루 결산 열기')
    $rinHealth = $rinMenu.Items.Add('생활 기록 열기')
    $rinFocus = $rinMenu.Items.Add('25분 집중 시작'); $rinFocus.Enabled = $false
    [void]$rinMenu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
    $rinTracking = $rinMenu.Items.Add('PC 활동 측정 확인 중…')
    $rinExit = $rinMenu.Items.Add('아사 종료')
    $rinNotify.ContextMenuStrip = $rinMenu
    $script:rinSession = $null

    function Open-Rin([string]$fragment = '') {
        $openScript = Join-Path $rinRoot 'Open-RinWindow.ps1'
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $openScript + '"'),'-Fragment',('"' + $fragment + '"')) -WindowStyle Hidden
    }
    function Update-RinTray {
        try {
            $script:rinSession = Invoke-RestMethod -Uri "$rinBaseUrl/api/session" -TimeoutSec 3
            $focus = $script:rinSession.reminderControl.focus
            if ($focus -and [DateTime]::Parse($focus.ends) -gt (Get-Date)) { $rinStatus.Text = "집중 중 · $($focus.title)" }
            else { $rinStatus.Text = '아사 실행 중 · 무료 로컬 AI' }
            $priority = $script:rinSession.eveningReview.priority
            if ($priority) {
                $rinPriority.Text = "가장 급함 · $($priority.title)"
                $rinFocus.Text = "25분 집중 · $($priority.title)"; $rinFocus.Enabled = $true
            } else {
                $rinPriority.Text = '남은 학업 일정 없음'; $rinFocus.Text = '25분 집중 시작'; $rinFocus.Enabled = $false
            }
            $enabled = [bool]$script:rinSession.settings.activityTracking
            $rinTracking.Enabled = $true
            $rinTracking.Text = if ($enabled) { 'PC 활동 측정 일시 중지' } else { 'PC 활동 측정 재개' }
            $tip = if ($priority) { "아사 · $($priority.title)부터 확인해" } else { '아사' }
            $rinNotify.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))
        } catch {
            $script:rinSession = $null; $rinStatus.Text = '아사 서버에 연결할 수 없음'; $rinPriority.Text = 'Asa.cmd로 다시 실행해'; $rinFocus.Enabled = $false; $rinTracking.Enabled = $false
        }
    }
    $rinOpen.Add_Click({ Open-Rin })
    $rinReview.Add_Click({ Open-Rin '/#review' })
    $rinHealth.Add_Click({ Open-Rin '/#health' })
    $rinNotify.Add_DoubleClick({ Open-Rin })
    $rinFocus.Add_Click({
        if (-not $script:rinSession.eveningReview.priority) { return }
        try {
            $headers = @{ 'X-Rin-Token' = $script:rinSession.token }
            $payload = @{ action = 'focus'; itemId = $script:rinSession.eveningReview.priority.id } | ConvertTo-Json -Compress
            Invoke-RestMethod -Uri "$rinBaseUrl/api/reminder/action" -Method Post -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 5 | Out-Null
            Update-RinTray
        } catch { $rinNotify.ShowBalloonTip(4000, '아사', '집중을 시작하지 못했어. 앱 연결을 확인해.', [Windows.Forms.ToolTipIcon]::Warning) }
    })
    $rinTracking.Add_Click({
        if (-not $script:rinSession) { return }
        try {
            $headers = @{ 'X-Rin-Token' = $script:rinSession.token }
            $payload = @{ enabled = -not [bool]$script:rinSession.settings.activityTracking } | ConvertTo-Json -Compress
            Invoke-RestMethod -Uri "$rinBaseUrl/api/activity/toggle" -Method Post -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 5 | Out-Null
            Update-RinTray
        } catch { $rinNotify.ShowBalloonTip(4000, '아사', '설정을 바꾸지 못했어. 앱 연결을 확인해.', [Windows.Forms.ToolTipIcon]::Warning) }
    })
    $rinExit.Add_Click({
        $rinNotify.Visible = $false
        $pidPath = Join-Path $rinRoot 'data\tray.pid'; if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
        $stopScript = Join-Path $rinRoot 'Stop-Rin.ps1'
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $stopScript + '"')) -WindowStyle Hidden
        $rinContext.ExitThread()
    })
    $rinTimer = New-Object Windows.Forms.Timer; $rinTimer.Interval = 30000; $rinTimer.Add_Tick({ Update-RinTray }); $rinTimer.Start()
    Update-RinTray
    [Windows.Forms.Application]::Run($rinContext)
} finally {
    if ($rinNotify) { $rinNotify.Visible = $false; $rinNotify.Dispose() }
    if ($rinGraphics) { $rinGraphics.Dispose() }; if ($rinBitmap) { $rinBitmap.Dispose() }
    if ($rinCreated) { $rinMutex.ReleaseMutex() }; $rinMutex.Dispose()
}
