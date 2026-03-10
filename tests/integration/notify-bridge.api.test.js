const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");

const {
  findFreePort,
  waitForHttp,
  startNodeService,
  readJson,
} = require("../helpers/service-process");

function startWebhookMock(port) {
  const events = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      events.push({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        events,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

test("notify-bridge supports /api/v1 alias and alert dispatch", async (t) => {
  const bridgePort = await findFreePort();
  const webhookPort = await findFreePort();
  const webhook = await startWebhookMock(webhookPort);
  t.after(async () => {
    await webhook.close();
  });

  const notifications = {
    enabled: true,
    cooldownSec: 0,
    remindIntervalSec: 0,
    bindings: [
      {
        name: "test-binding",
        enabled: true,
        targets: ["*"],
        severities: ["all"],
        notifyRecover: true,
        channels: [
          {
            type: "wechat",
            name: "mock-wechat",
            webhook: `http://127.0.0.1:${webhookPort}/hook`,
          },
        ],
      },
    ],
  };

  const service = startNodeService({
    cwd: path.join(__dirname, "..", "..", "notify-bridge"),
    env: {
      PORT: String(bridgePort),
      MONITOR_NOTIFICATIONS: JSON.stringify(notifications),
      STATE_PERSIST_ENABLED: "false",
    },
  });
  t.after(async () => {
    await service.stop();
  });

  await waitForHttp(`http://127.0.0.1:${bridgePort}/healthz`);

  const testRes = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/alerts/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      binding: "test-binding",
      severity: "danger",
      target: "notify-target",
      message: "integration test message",
    }),
  });
  assert.equal(testRes.status, 200);
  assert.equal(testRes.headers.get("x-api-version"), "v1");
  const testBody = await readJson(testRes);
  assert.equal(testBody?.data?.[0]?.binding, "test-binding");
  assert.equal(testBody?.data?.[0]?.successCount, 1);

  const webhookRes = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/alerts/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: {
            alertname: "CpuHigh",
            severity: "danger",
            target: "notify-target",
            instance: "127.0.0.1",
          },
          annotations: {
            summary: "cpu high",
          },
          startsAt: new Date().toISOString(),
        },
      ],
    }),
  });
  assert.equal(webhookRes.status, 200);
  const webhookBody = await readJson(webhookRes);
  assert.equal(webhookBody?.accepted, 1);
  assert.ok((webhookBody?.processed || 0) >= 1);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(webhook.events.length >= 2);

  const binding404 = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/alerts/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      binding: "not-exists",
    }),
  });
  assert.equal(binding404.status, 404);
  const bindingBody = await readJson(binding404);
  assert.equal(bindingBody?.error?.code, "BINDING_NOT_FOUND");
});
