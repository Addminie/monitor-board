#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");

const SCALES = [100, 300, 500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx];
}

async function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      const port = Number(addr?.port || 0);
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startNodeService({ cwd, env }) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return {
    child,
    getStderr: () => stderr,
    async stop() {
      if (child.exitCode != null || child.killed) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch (_error) {}
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill("SIGTERM");
        } catch (_error) {
          clearTimeout(timer);
          resolve();
        }
      });
    },
  };
}

async function waitHttpReady(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (_error) {}
    await sleep(200);
  }
  throw new Error(`timeout waiting ${url}`);
}

function buildTargets(scale, agentPort, token) {
  return Array.from({ length: scale }).map((_, idx) => ({
    name: `cap-agent-${String(idx + 1).padStart(3, "0")}`,
    url: `http://127.0.0.1:${agentPort}`,
    token,
    env: "perf",
    business: "benchmark",
    room: "local",
    owner: "capacity",
  }));
}

async function runScaleBenchmark({ rootDir, agentPort, token, scale, requests = 5 }) {
  const dashboardPort = await findFreePort();
  const targets = buildTargets(scale, agentPort, token);
  const dashboard = startNodeService({
    cwd: path.join(rootDir, "dashboard"),
    env: {
      PORT: String(dashboardPort),
      ALERT_LOOP_ENABLED: "false",
      REQUEST_TIMEOUT_MS: "8000",
      COLLECTION_CACHE_TTL_MS: "1000",
      MONITOR_TARGETS: JSON.stringify(targets),
      MONITOR_NOTIFICATIONS: JSON.stringify({ enabled: false, bindings: [] }),
      STATE_PERSIST_ENABLED: "false",
      API_PAGINATION_MAX: "1000",
    },
  });
  const statusUrl = `http://127.0.0.1:${dashboardPort}/api/v1/targets/status?refresh=1&page=1&pageSize=${scale}`;

  try {
    await waitHttpReady(`http://127.0.0.1:${dashboardPort}/readyz`, 20000);
    await fetch(statusUrl);
    await sleep(300);

    const latencies = [];
    let failCount = 0;
    for (let i = 0; i < requests; i += 1) {
      const start = Date.now();
      try {
        const res = await fetch(statusUrl);
        const cost = Date.now() - start;
        latencies.push(cost);
        if (!res.ok) failCount += 1;
      } catch (_error) {
        failCount += 1;
      }
      await sleep(250);
    }

    const total = latencies.length;
    const avg = total ? Math.round(latencies.reduce((a, b) => a + b, 0) / total) : 0;
    return {
      scale,
      requests: total,
      failed: failCount,
      latencyMs: {
        min: total ? Math.min(...latencies) : 0,
        max: total ? Math.max(...latencies) : 0,
        avg,
        p50: Math.round(percentile(latencies, 50)),
        p95: Math.round(percentile(latencies, 95)),
      },
      dashboardStderr: dashboard.getStderr().slice(-1200),
    };
  } finally {
    await dashboard.stop();
  }
}

function buildConclusion(reportRows) {
  const bottlenecks = [];
  for (const row of reportRows) {
    if (row.failed > 0) {
      bottlenecks.push(`${row.scale} targets: failed requests ${row.failed}/${row.requests}`);
      continue;
    }
    if (row.latencyMs.p95 > 8000) {
      bottlenecks.push(
        `${row.scale} targets: P95=${row.latencyMs.p95}ms (>8s), split dashboard instances by domain`
      );
    } else if (row.latencyMs.p95 > 4000) {
      bottlenecks.push(
        `${row.scale} targets: P95=${row.latencyMs.p95}ms (>4s), increase poll interval and cache TTL`
      );
    }
  }
  if (!bottlenecks.length) {
    bottlenecks.push("No obvious bottleneck in this run. Continue scaling and track CPU/memory.");
  }
  return bottlenecks;
}

function renderMarkdown(results, context) {
  const rows = results
    .map(
      (r) =>
        `| ${r.scale} | ${r.requests} | ${r.failed} | ${r.latencyMs.min} | ${r.latencyMs.avg} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.max} |`
    )
    .join("\n");
  const conclusions = buildConclusion(results)
    .map((item) => `- ${item}`)
    .join("\n");

  return `# Capacity Report

Generated At: ${new Date().toISOString()}  
Host: ${os.hostname()}  
Node: ${process.version}

## Method

- Single local agent + single dashboard
- Target set scales: ${SCALES.join(", ")}
- Endpoint: \`/api/v1/targets/status?refresh=1\`
- Per-scale sample count: ${context.requests}

## Results

| Targets | Requests | Failed | Min(ms) | Avg(ms) | P50(ms) | P95(ms) | Max(ms) |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows}

## Bottleneck Notes

${conclusions}

## Scaling Suggestions

- <=100 targets: a single dashboard instance is generally acceptable
- ~300 targets: keep collection cache enabled and increase poll interval
- >=500 targets: split dashboard instances by business domain and move long-term trends to Prometheus/Grafana
`;
}

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  const docsDir = path.join(rootDir, "docs");
  const outputFile = path.join(docsDir, "CAPACITY_REPORT.md");
  const agentPort = await findFreePort();
  const token = "capacity-benchmark-token";
  const requests = 5;

  const agent = startNodeService({
    cwd: path.join(rootDir, "agent"),
    env: {
      PORT: String(agentPort),
      AGENT_TOKEN: token,
      STATUS_CACHE_TTL_MS: "500",
    },
  });

  try {
    await waitHttpReady(`http://127.0.0.1:${agentPort}/readyz`, 20000);
    const results = [];
    for (const scale of SCALES) {
      process.stdout.write(`Running scale ${scale} ...\n`);
      const report = await runScaleBenchmark({
        rootDir,
        agentPort,
        token,
        scale,
        requests,
      });
      results.push(report);
      process.stdout.write(
        `  done: fail=${report.failed}, p95=${report.latencyMs.p95}ms, avg=${report.latencyMs.avg}ms\n`
      );
    }
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(outputFile, `${renderMarkdown(results, { requests })}\n`, "utf8");
    process.stdout.write(`\nCapacity report written: ${outputFile}\n`);
  } finally {
    await agent.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`capacity benchmark failed: ${error?.message || "unknown"}\n`);
  process.exitCode = 1;
});
