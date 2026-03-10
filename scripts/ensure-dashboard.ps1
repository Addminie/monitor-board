param(
  [int]$Port = 9200
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$workDir = Join-Path $projectRoot "dashboard"
$logDir = Join-Path $projectRoot "logs"
$stdoutLog = Join-Path $logDir "dashboard.autostart.out.log"
$stderrLog = Join-Path $logDir "dashboard.autostart.err.log"

function Resolve-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Path $cmd.Source)) { return $cmd.Source }

  $candidates = @(
    "D:\\Program Files\\node.exe",
    "C:\\Program Files\\nodejs\\node.exe"
  )
  foreach ($item in $candidates) {
    if (Test-Path $item) { return $item }
  }
  throw "node.exe not found."
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

if (-not (Test-Path $workDir)) {
  throw "Dashboard work directory not found: $workDir"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$nodeExe = Resolve-NodeExe
$previousPort = $env:PORT
try {
  $env:PORT = "$Port"
  Start-Process -FilePath $nodeExe `
    -ArgumentList "server.js" `
    -WorkingDirectory $workDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog | Out-Null
} finally {
  if ($null -eq $previousPort) {
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
  } else {
    $env:PORT = $previousPort
  }
}
