const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
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

test("dashboard exposes paginated target/status APIs and standard error envelope", async (t) => {
  const workDir = path.join(__dirname, "..", "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-board-test-dashboard-"));
  const agentPort = await findFreePort();
  const dashboardPort = await findFreePort();
  const webhookPort = await findFreePort();
  const agentToken = "dashboard-agent-token";
  const webhook = await startWebhookMock(webhookPort);
  t.after(async () => {
    await webhook.close();
  });

  const agent = startNodeService({
    cwd: path.join(workDir, "agent"),
    env: {
      PORT: String(agentPort),
      AGENT_TOKEN: agentToken,
      STATUS_CACHE_TTL_MS: "500",
    },
  });
  t.after(async () => {
    await agent.stop();
  });
  await waitForHttp(`http://127.0.0.1:${agentPort}/healthz`);

  const targets = [
    {
      name: "test-agent",
      url: `http://127.0.0.1:${agentPort}`,
      token: agentToken,
      env: "test",
      owner: "qa",
    },
  ];
  const notifications = {
    enabled: true,
    cooldownSec: 0,
    remindIntervalSec: 0,
    messageLocale: "en-US",
    bindings: [
      {
        name: "ops-all",
        enabled: true,
        targets: ["*"],
        severities: ["all"],
        channels: [
          {
            type: "wechat",
            name: "ops-wechat",
            webhook: `http://127.0.0.1:${webhookPort}/notify`,
            messageLocale: "zh-CN",
            messageTemplates: {
              test: "[渠道模板] {{targetName}} {{severity}}",
            },
          },
        ],
      },
    ],
  };

  const dashboard = startNodeService({
    cwd: path.join(workDir, "dashboard"),
    env: {
      PORT: String(dashboardPort),
      ALERT_LOOP_ENABLED: "false",
      REQUEST_TIMEOUT_MS: "15000",
      MONITOR_TARGETS: JSON.stringify(targets),
      MONITOR_NOTIFICATIONS: JSON.stringify(notifications),
      STATE_DB_FILE: path.join(tempDir, "dashboard-state.db"),
      API_PAGINATION_MAX: "50",
    },
  });
  t.after(async () => {
    await dashboard.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForHttp(`http://127.0.0.1:${dashboardPort}/healthz`);

  const targetsRes = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/targets?page=1&pageSize=1`
  );
  assert.equal(targetsRes.status, 200);
  assert.equal(targetsRes.headers.get("x-api-version"), "v1");
  const targetsBody = await readJson(targetsRes);
  assert.equal(targetsBody?.count, 1);
  assert.equal(targetsBody?.pagination?.total, 1);
  assert.equal(targetsBody?.data?.[0]?.metadata?.env, "test");

  const statusRes = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/targets/status?refresh=1&page=1&pageSize=1`
  );
  assert.equal(statusRes.status, 200);
  const statusBody = await readJson(statusRes);
  assert.equal(statusBody?.count, 1);
  assert.equal(statusBody?.cache?.forceRefresh, true);
  assert.equal(statusBody?.data?.[0]?.name, "test-agent");
  assert.equal(
    Boolean(statusBody?.data?.[0]?.status || statusBody?.data?.[0]?.error),
    true
  );

  const diagnose404 = await fetch(`http://127.0.0.1:${dashboardPort}/api/v1/targets/diagnose`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ targetUrl: "http://127.0.0.1:65530" }),
  });
  assert.equal(diagnose404.status, 404);
  const diagnoseBody = await readJson(diagnose404);
  assert.equal(diagnoseBody?.error?.code, "TARGET_NOT_FOUND");

  const configBlockedRes = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/config/notifications`
  );
  assert.equal(configBlockedRes.status, 409);
  const configBlockedBody = await readJson(configBlockedRes);
  assert.equal(configBlockedBody?.error?.code, "CONFIG_EDIT_BLOCKED");

  const validateOkRes = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/config/notifications/validate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          enabled: true,
          cooldownSec: 300,
          remindIntervalSec: 0,
          bindings: [
            {
              name: "ops-all",
              enabled: true,
              targets: ["*"],
              severities: ["danger", "offline"],
              notifyRecover: true,
              channels: [
                {
                  type: "wechat",
                  name: "ops-wechat",
                  webhook: "http://127.0.0.1:39099/notify",
                },
              ],
            },
          ],
        },
      }),
    }
  );
  assert.equal(validateOkRes.status, 200);
  const validateOkBody = await readJson(validateOkRes);
  assert.equal(validateOkBody?.ok, true);
  assert.equal(validateOkBody?.envOverride?.active, true);
  assert.equal(validateOkBody?.envOverride?.envName, "MONITOR_NOTIFICATIONS");

  const validateBadRes = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/config/notifications/validate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          enabled: true,
          bindings: [
            {
              name: "broken-binding",
              channels: [],
            },
          ],
        },
      }),
    }
  );
  assert.equal(validateBadRes.status, 200);
  const validateBadBody = await readJson(validateBadRes);
  assert.equal(validateBadBody?.ok, false);
  assert.equal(Array.isArray(validateBadBody?.errors), true);
  assert.equal(validateBadBody.errors.length > 0, true);

  const validateLocaleBadRes = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/config/notifications/validate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          enabled: true,
          messageLocale: "fr-FR",
          bindings: [
            {
              name: "ops-all",
              enabled: true,
              targets: ["*"],
              severities: ["danger"],
              channels: [
                {
                  type: "wechat",
                  name: "ops-wechat",
                  webhook: "http://127.0.0.1:39099/notify",
                },
              ],
            },
          ],
        },
      }),
    }
  );
  assert.equal(validateLocaleBadRes.status, 200);
  const validateLocaleBadBody = await readJson(validateLocaleBadRes);
  assert.equal(validateLocaleBadBody?.ok, false);
  assert.equal(
    (validateLocaleBadBody?.errors || []).some((item) =>
      String(item).includes("notifications.messageLocale")
    ),
    true
  );

  const validateChannelLocaleBadRes = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/config/notifications/validate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          enabled: true,
          bindings: [
            {
              name: "ops-all",
              enabled: true,
              targets: ["*"],
              severities: ["danger"],
              channels: [
                {
                  type: "wechat",
                  name: "ops-wechat",
                  webhook: "http://127.0.0.1:39099/notify",
                  messageLocale: "fr-FR",
                },
              ],
            },
          ],
        },
      }),
    }
  );
  assert.equal(validateChannelLocaleBadRes.status, 200);
  const validateChannelLocaleBadBody = await readJson(validateChannelLocaleBadRes);
  assert.equal(validateChannelLocaleBadBody?.ok, false);
  assert.equal(
    (validateChannelLocaleBadBody?.errors || []).some((item) =>
      String(item).includes("notifications.bindings[0].channels[0].messageLocale")
    ),
    true
  );

  const testNotifyRes = await fetch(`http://127.0.0.1:${dashboardPort}/api/v1/alerts/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      binding: "ops-all",
      target: "template-target",
      severity: "danger",
      message: "template check",
    }),
  });
  assert.equal(testNotifyRes.status, 200);
  const testNotifyBody = await readJson(testNotifyRes);
  assert.equal(testNotifyBody?.data?.[0]?.binding, "ops-all");
  assert.equal(testNotifyBody?.data?.[0]?.successCount, 1);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(webhook.events.length >= 1);
  const latestWebhook = webhook.events[webhook.events.length - 1];
  const webhookPayload = JSON.parse(latestWebhook.body || "{}");
  const content = String(webhookPayload?.text?.content || "");
  assert.equal(content.includes("[渠道模板] template-target DANGER"), true);

  const testNotifyByChannelRes = await fetch(`http://127.0.0.1:${dashboardPort}/api/v1/alerts/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      binding: "ops-all",
      channel: "ops-wechat",
      target: "template-target",
      severity: "danger",
      message: "template check",
    }),
  });
  assert.equal(testNotifyByChannelRes.status, 200);
  const testNotifyByChannelBody = await readJson(testNotifyByChannelRes);
  assert.equal(testNotifyByChannelBody?.data?.[0]?.binding, "ops-all");
  assert.equal(testNotifyByChannelBody?.data?.[0]?.channelCount, 1);

  const testNotifyByChannelNotFound = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/alerts/test`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        binding: "ops-all",
        channel: "not-exists",
        target: "template-target",
        severity: "danger",
      }),
    }
  );
  assert.equal(testNotifyByChannelNotFound.status, 404);
  const testNotifyByChannelNotFoundBody = await readJson(testNotifyByChannelNotFound);
  assert.equal(testNotifyByChannelNotFoundBody?.error?.code, "CHANNEL_NOT_FOUND");

  const testNotifyByChannelTypeBad = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/v1/alerts/test`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        binding: "ops-all",
        channelType: "email",
      }),
    }
  );
  assert.equal(testNotifyByChannelTypeBad.status, 400);
  const testNotifyByChannelTypeBadBody = await readJson(testNotifyByChannelTypeBad);
  assert.equal(testNotifyByChannelTypeBadBody?.error?.code, "CHANNEL_TYPE_INVALID");
});
