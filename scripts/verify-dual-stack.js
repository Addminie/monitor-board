#!/usr/bin/env node
const DEFAULT_TIMEOUT_MS = 4000;

function parseArgs(argv) {
  const opts = {
    dashboardUrl: "http://127.0.0.1:9200/healthz",
    prometheusUrl: "http://127.0.0.1:9090/-/healthy",
    alertmanagerUrl: "http://127.0.0.1:9093/-/healthy",
    notifyBridgeUrl: "http://127.0.0.1:9300/healthz",
    grafanaUrl: "http://127.0.0.1:3000/api/health",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    strict: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    if (!arg) continue;
    if (arg === "--strict") {
      opts.strict = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = String(argv[i + 1] || "").trim();
    if (!value || value.startsWith("--")) continue;
    i += 1;
    if (key === "dashboard-url") opts.dashboardUrl = value;
    else if (key === "prometheus-url") opts.prometheusUrl = value;
    else if (key === "alertmanager-url") opts.alertmanagerUrl = value;
    else if (key === "notify-url") opts.notifyBridgeUrl = value;
    else if (key === "grafana-url") opts.grafanaUrl = value;
    else if (key === "timeout-ms") opts.timeoutMs = Math.max(500, Number(value) || DEFAULT_TIMEOUT_MS);
  }
  return opts;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || "fetch failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const checks = [
    { name: "dashboard", url: opts.dashboardUrl },
    { name: "prometheus", url: opts.prometheusUrl },
    { name: "alertmanager", url: opts.alertmanagerUrl },
    { name: "notify-bridge", url: opts.notifyBridgeUrl },
    { name: "grafana", url: opts.grafanaUrl },
  ];
  let failCount = 0;

  for (const item of checks) {
    const res = await fetchWithTimeout(item.url, opts.timeoutMs);
    if (res.ok) {
      process.stdout.write(`[PASS] ${item.name} -> HTTP ${res.status} (${item.url})\n`);
      continue;
    }
    failCount += 1;
    process.stdout.write(
      `[FAIL] ${item.name} -> ${res.status || "ERR"} ${res.error || ""} (${item.url})\n`
    );
  }

  if (!failCount) {
    process.stdout.write("\nDual-stack verification passed: legacy dashboard + monitoring stack are both reachable.\n");
  } else {
    process.stdout.write(`\nDual-stack verification failed: ${failCount} endpoint(s) unreachable.\n`);
  }

  if (opts.strict && failCount > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`verify-dual-stack runtime error: ${error?.message || "unknown"}\n`);
  process.exitCode = 1;
});
