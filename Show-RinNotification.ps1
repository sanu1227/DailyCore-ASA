param([Parameter(Mandatory = $true)][string]$TitleBase64, [Parameter(Mandatory = $true)][string]$BodyBase64, [string]$Sound = 'casual', [ValidateRange(0,100)][int]$Volume = 70)
$ErrorActionPreference = 'Stop'
$rinTitle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleBase64))
$rinBody = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BodyBase64))
$rinEscapedTitle = [Security.SecurityElement]::Escape($rinTitle)
$rinEscapedBody = [Security.SecurityElement]::Escape($rinBody)
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$rinXml = New-Object Windows.Data.Xml.Dom.XmlDocument
$rinXml.LoadXml("<toast duration='long'><visual><binding template='ToastGeneric'><text>$rinEscapedTitle</text><text>$rinEscapedBody</text></binding></visual><audio silent='true'/></toast>")
$rinToast = [Windows.UI.Notifications.ToastNotification]::new($rinXml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsPowerShell').Show($rinToast)
& (Join-Path $PSScriptRoot 'Play-RinSound.ps1') -Sound $Sound -Volume $Volume
