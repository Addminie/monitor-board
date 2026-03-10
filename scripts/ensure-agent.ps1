param(
  [int]$Port = 9101,
  [string]$AgentToken = "123456"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$workDir = Join-Path $projectRoot "agent"
$logDir = Join-Path $projectRoot "logs"
$stdoutLog = Join-Path $logDir "agent.autostart.out.log"
$stderrLog = Join-Path $logDir "agent.autostart.err.log"

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
  throw "Agent work directory not found: $workDir"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$nodeExe = Resolve-NodeExe
$command = "$env:AGENT_TOKEN='$AgentToken'; $env:PORT='$Port'; & '$nodeExe' 'server.js'"

Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-Command",$command `
  -WorkingDirectory $workDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog | Out-Null
