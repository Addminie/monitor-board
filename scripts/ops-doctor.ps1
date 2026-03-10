param(
  [string]$DashboardUrl = "http://127.0.0.1:9200",
  [string]$AgentUrl = "http://127.0.0.1:9101",
  [string]$NotifyUrl = "http://127.0.0.1:9300",
  [string]$PrometheusUrl = "http://127.0.0.1:9090",
  [string]$GrafanaUrl = "http://127.0.0.1:3000",
  [int]$TimeoutMs = 4000,
  [switch]$Strict,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$scriptPath = Join-Path $projectRoot "scripts\ops-doctor.js"

if (-not (Test-Path $scriptPath)) {
  throw "Missing script: $scriptPath"
}

$args = @(
  $scriptPath,
  "--dashboard-url", $DashboardUrl,
  "--agent-url", $AgentUrl,
  "--notify-url", $NotifyUrl,
  "--prometheus-url", $PrometheusUrl,
  "--grafana-url", $GrafanaUrl,
  "--timeout-ms", "$TimeoutMs"
)

if ($Strict) { $args += "--strict" }
if ($Json) { $args += "--json" }

& node @args
exit $LASTEXITCODE
