const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  findFreePort,
  waitForHttp,
  startNodeService,
  readJson,
} = require("../helpers/service-process");

test("agent supports auth, metrics auth and /api/v1 alias", async (t) => {
  const port = await findFreePort();
  const token = "unit-agent-token";
  const metricsToken = "unit-metrics-token";
  const service = startNodeService({
    cwd: path.join(__dirname, "..", "..", "agent"),
    env: {
      PORT: String(port),
      AGENT_TOKEN: token,
      METRICS_TOKEN: metricsToken,
      STATUS_CACHE_TTL_MS: "500",
    },
  });
  t.after(async () => {
    await service.stop();
  });

  await waitForHttp(`http://127.0.0.1:${port}/healthz`);

  const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(healthRes.status, 200);

  const forbiddenRes = await fetch(`http://127.0.0.1:${port}/api/v1/monitor/status`);
  assert.equal(forbiddenRes.status, 403);
  const forbiddenBody = await readJson(forbiddenRes);
  assert.equal(forbiddenBody?.error?.code, "AUTH_FORBIDDEN");

  const okRes = await fetch(`http://127.0.0.1:${port}/api/v1/monitor/status`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("x-api-version"), "v1");
  const okBody = await readJson(okRes);
  assert.equal(typeof okBody?.system?.hostname, "string");
  assert.equal(typeof okBody?.cpu?.usagePercent, "number");

  const metrics403 = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(metrics403.status, 403);

  const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`, {
    headers: {
      Authorization: `Bearer ${metricsToken}`,
    },
  });
  assert.equal(metricsRes.status, 200);
  const metricsText = await metricsRes.text();
  assert.match(metricsText, /monitor_cpu_usage_percent/);
});
