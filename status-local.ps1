param(
  [int]$AgentPort = 9101,
  [int]$DashboardPort = 9200,
  [string]$AgentToken = "123456"
)

$agentListen = Get-NetTCPConnection -LocalPort $AgentPort -State Listen -ErrorAction SilentlyContinue
$dashListen = Get-NetTCPConnection -LocalPort $DashboardPort -State Listen -ErrorAction SilentlyContinue

Write-Host ("Agent listen    : " + [bool]$agentListen)
Write-Host ("Dashboard listen: " + [bool]$dashListen)

try {
  $a = Invoke-WebRequest -Uri "http://127.0.0.1:$AgentPort/api/monitor/status" -Headers @{ Authorization = "Bearer $AgentToken" } -UseBasicParsing
  Write-Host "Agent API       : HTTP $($a.StatusCode)"
} catch {
  Write-Host "Agent API       : ERROR"
}

try {
  $d = Invoke-WebRequest -Uri "http://127.0.0.1:$DashboardPort/api/targets/status" -UseBasicParsing
  Write-Host "Dashboard API   : HTTP $($d.StatusCode)"
} catch {
  Write-Host "Dashboard API   : ERROR"
}
