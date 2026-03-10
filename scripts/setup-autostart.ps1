param(
  [string]$ProjectRoot = "E:\\Ai project\\monitor-board"
)

$ErrorActionPreference = "Stop"
$agentScript = Join-Path $ProjectRoot "scripts\\ensure-agent.ps1"
$dashboardScript = Join-Path $ProjectRoot "scripts\\ensure-dashboard.ps1"

if (-not (Test-Path $agentScript)) { throw "Missing script: $agentScript" }
if (-not (Test-Path $dashboardScript)) { throw "Missing script: $dashboardScript" }

function Register-EnsureTask([string]$TaskName, [string]$ScriptPath) {
  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
  $trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

  Start-ScheduledTask -TaskName $TaskName
}

Register-EnsureTask -TaskName "MonitorBoard-Ensure-Agent" -ScriptPath $agentScript
Register-EnsureTask -TaskName "MonitorBoard-Ensure-Dashboard" -ScriptPath $dashboardScript

Write-Host "Autostart tasks created."
Write-Host "- MonitorBoard-Ensure-Agent"
Write-Host "- MonitorBoard-Ensure-Dashboard"
