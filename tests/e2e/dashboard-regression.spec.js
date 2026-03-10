const path = require("node:path");
const http = require("node:http");

const { test, expect } = require("@playwright/test");
const {
  findFreePort,
  waitForHttp,
  startNodeService,
} = require("../helpers/service-process");

let agentService = null;
let dashboardService = null;
let webhookServer = null;
let webhookEvents = [];
let baseUrl = "";

function startWebhookServer(port) {
  webhookEvents = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        webhookEvents.push({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

async function stopWebhookServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function expandTopControls(page) {
  const grid = page.locator(".controls-grid");
  await expect(grid).toHaveCount(1);
  const collapsed = await grid.evaluate((node) => node.classList.contains("collapsed"));
  if (!collapsed) return;
  await page.click("#top-controls-toggle");
}

async function gotoGuideStep(page, step) {
  await page.click(`[data-guide-step=\"${step}\"]`);
}

test.beforeAll(async () => {
  const rootDir = path.join(__dirname, "..", "..");
  const agentPort = await findFreePort();
  const dashboardPort = await findFreePort();
  const webhookPort = await findFreePort();
  const agentToken = "e2e-agent-token";

  webhookServer = await startWebhookServer(webhookPort);

  agentService = startNodeService({
    cwd: path.join(rootDir, "agent"),
    env: {
      PORT: String(agentPort),
      AGENT_TOKEN: agentToken,
      STATUS_CACHE_TTL_MS: "800",
    },
  });
  await waitForHttp(`http://127.0.0.1:${agentPort}/healthz`);

  const targets = [
    {
      name: "online-agent",
      url: `http://127.0.0.1:${agentPort}`,
      token: agentToken,
      env: "dev",
      business: "core",
      room: "local-a",
      owner: "qa-dev",
    },
    {
      name: "offline-node",
      url: "http://127.0.0.1:65530",
      token: "unused-token",
      env: "prod",
      business: "edge",
      room: "local-b",
      owner: "qa-prod",
    },
  ];
  const notifications = {
    enabled: true,
    cooldownSec: 0,
    remindIntervalSec: 0,
    bindings: [
      {
        name: "ops-all",
        enabled: true,
        targets: ["*"],
        severities: ["all"],
        notifyRecover: true,
        channels: [
          {
            type: "wechat",
            name: "e2e-wechat",
            webhook: `http://127.0.0.1:${webhookPort}/notify`,
            mentionedMobileList: [],
            mentionedList: [],
          },
        ],
      },
    ],
  };

  dashboardService = startNodeService({
    cwd: path.join(rootDir, "dashboard"),
    env: {
      PORT: String(dashboardPort),
      ALERT_LOOP_ENABLED: "false",
      REQUEST_TIMEOUT_MS: "8000",
      MONITOR_TARGETS: JSON.stringify(targets),
      MONITOR_NOTIFICATIONS: JSON.stringify(notifications),
      STATE_PERSIST_ENABLED: "false",
      RBAC_ENABLED: "false",
    },
  });
  await waitForHttp(`http://127.0.0.1:${dashboardPort}/healthz`);
  baseUrl = `http://127.0.0.1:${dashboardPort}`;
});

test.afterAll(async () => {
  await Promise.allSettled([
    dashboardService?.stop?.(),
    agentService?.stop?.(),
    stopWebhookServer(webhookServer),
  ]);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
  });
  webhookEvents.length = 0;
});

test("看板回归：顶部筛选、快捷筛选、详情标签", async ({ page }) => {
  await page.goto(`${baseUrl}/`);
  await expandTopControls(page);

  const table = page.locator("#servers-table");
  const rows = page.locator("#servers-table tr[data-server-id]");
  await expect(rows).toHaveCount(2);
  await expect(table).toContainText("online-agent");
  await expect(table).toContainText("offline-node");

  await page.click("#table-quick-alert");
  await expect(page.locator("#table-quick-alert")).toHaveClass(/is-active/);
  await expect(table).toContainText("offline-node");

  await page.click("#table-quick-all");
  await expect(rows).toHaveCount(2);

  await page.selectOption("#filter-env", "dev");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("online-agent");

  await page.fill("#search-input", "not-exists-keyword");
  await expect(rows).toHaveCount(0);
  await expect(table).toContainText("暂无匹配服务器");

  await page.click("#saved-view-reset-btn");
  await expect(rows).toHaveCount(2);

  await rows.first().click();
  await expect(page.locator("#detail-target")).toContainText(/online-agent|offline-node/);
  await page.click("#detail-tab-system");
  await expect(page.locator("#detail-tab-system")).toHaveClass(/is-active/);
});

test("配置页回归：小白引导 + 高级功能 + 测试发送", async ({ page }) => {
  await page.goto(`${baseUrl}/config.html`);

  await expect(page.locator("#config-guide-shell")).toBeVisible();
  await expect(page.locator("#guide-mode-toggle")).toContainText("完整模式");

  await page.click("#guide-advanced-toggle");
  await page.click("#load-config-btn");
  await expect(page.locator("#editor-status")).toContainText("blocked");

  await gotoGuideStep(page, 1);
  await page.fill("#binding-name", "ops-all");
  await page.selectOption("#channel-type", "wechat");
  await page.fill("#channel-name", "ops-channel");
  await page.fill("#wechat-webhook", `${baseUrl}/__unused__`);
  await page.selectOption("#message-locale", "en-US");
  await page.click("#apply-template-preset-btn");
  await expect(page.locator("#tpl-alert")).toHaveValue(/Binding:/);
  await page.check("#channel-template-enabled");
  await page.selectOption("#channel-message-locale", "zh-CN");
  await page.click("#apply-channel-template-preset-btn");
  await page.fill("#channel-tpl-alert", "[CH-PREVIEW] {{targetName}} {{severity}}");
  await page.click("#export-channel-template-snippet-btn");
  await expect(page.locator("#template-snippet-json")).toHaveValue(/"scope":\s*"channel"/);

  await page.locator("#builder-form").evaluate((form) => form.requestSubmit());
  await gotoGuideStep(page, 2);

  const jsonOutput = page.locator("#json-output");
  await expect
    .poll(async () => (await jsonOutput.inputValue()).length, { timeout: 10000 })
    .toBeGreaterThan(50);
  await expect(jsonOutput).toHaveValue(/"name":\s*"ops-all"/);
  await expect(jsonOutput).toHaveValue(/"messageLocale":\s*"en-US"/);

  await gotoGuideStep(page, 3);
  await page.click("#test-easy-fill-btn");
  await expect(page.locator("#test-binding")).toHaveValue("ops-all");
  await page.selectOption("#test-channel-mode", "custom");
  await page.fill("#test-channel-name", "e2e-wechat");
  await page.fill("#test-target", "ui-e2e-target");
  await page.fill("#test-message", "ui e2e regression");
  await page.click("#test-form button[type='submit']");

  const result = page.locator("#result");
  await expect(result).toContainText('"ok": true');
  await expect(result).toContainText('"status": 200');
  await expect.poll(() => webhookEvents.length, { timeout: 15000 }).toBeGreaterThan(0);
});
