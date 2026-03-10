param(
  [int]$AgentPort = 9101,
  [int]$DashboardPort = 9200
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".local-pids.txt"

function Stop-ByProcessId([int]$ProcessId) {
  try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop } catch {}
}

function Stop-PortProcess([int]$Port) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $conns) { return }
  $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $pids) { Stop-ByProcessId -ProcessId $procId }
}

if (Test-Path $pidFile) {
  $raw = (Get-Content $pidFile -Raw).Trim()
  if ($raw) {
    $ids = $raw -split "," | Where-Object { $_ -match "^\d+$" }
    foreach ($id in $ids) { Stop-ByProcessId -ProcessId ([int]$id) }
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}

Stop-PortProcess -Port $AgentPort
Stop-PortProcess -Port $DashboardPort

Write-Host "Stopped local services."
