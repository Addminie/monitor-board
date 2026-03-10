$ErrorActionPreference = "SilentlyContinue"
& schtasks /Delete /TN "MonitorBoard-Ensure-Agent" /F | Out-Null
& schtasks /Delete /TN "MonitorBoard-Ensure-Dashboard" /F | Out-Null
Write-Host "Autostart tasks removed."
