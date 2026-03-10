#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LEVEL_SCORE = { pass: 0, warn: 1, fail: 2 };
const DEFAULTS = {
  dashboardUrl: "http://127.0.0.1:9200",
  agentUrl: "http://127.0.0.1:9101",
  notifyUrl: "http://127.0.0.1:9300",
  prometheusUrl: "http://127.0.0.1:9090",
  grafanaUrl: "http://127.0.0.1:3000",
  timeoutMs: 4000,
  strict: false,
  json: false,
};

function parseArgs(argv) {
  const result = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    if (!arg) continue;
    if (arg === "--strict") {
      result.strict = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = String(argv[i + 1] || "").trim();
    if (!value || value.startsWith("--")) continue;
    i += 1;
    if (key === "dashboard-url") result.dashboardUrl = value;
    else if (key === "agent-url") result.agentUrl = value;
    else if (key === "notify-url") result.notifyUrl = value;
    else if (key === "prometheus-url") result.prometheusUrl = value;
    else if (key === "grafana-url") result.grafanaUrl = value;
    else if (key === "timeout-ms") result.timeoutMs = Math.max(500, Number(value) || DEFAULTS.timeoutMs);
  }
  return result;
}

function pushResult(results, level, check, message, details = {}) {
  const normalized = LEVEL_SCORE[level] != null ? level : "warn";
  results.push({
    level: normalized,
    check,
    message,
    details,
    ts: new Date().toISOString(),
  });
}

function printResults(results) {
  for (const row of results) {
    const prefix = row.level === "pass" ? "PASS" : row.level === "warn" ? "WARN" : "FAIL";
    process.stdout.write(`[${prefix}] ${row.check} - ${row.message}\n`);
  }
}

function buildSummary(results) {
  const summary = {
    pass: results.filter((r) => r.level === "pass").length,
    warn: results.filter((r) => r.level === "warn").length,
    fail: results.filter((r) => r.level === "fail").length,
  };
  const suggestions = [];
  if (results.some((r) => r.check.includes("dashboard.readyz") && r.level === "fail")) {
    suggestions.push("Dashboard 未就绪：优先检查 targets/alerts/notifications 配置是否合法。");
  }
  if (results.some((r) => r.check.includes("agent.status") && r.level !== "pass")) {
    suggestions.push("Agent 状态拉取失败：确认 AGENT_TOKEN、9101 端口、防火墙、目标 URL。");
  }
  if (results.some((r) => r.check.includes("target.connectivity") && r.level !== "pass")) {
    suggestions.push("目标连通异常：运行 /api/v1/targets/diagnose 定位 network/auth/api 类型错误。");
  }
  if (results.some((r) => r.check.includes("docker") && r.level === "fail")) {
    suggestions.push("Docker 不可用：检查 Docker Desktop/Engine 是否启动，或切换本地 Node 方式排障。");
  }
  if (!suggestions.length) {
    suggestions.push("未发现阻断项，可继续观察告警与趋势数据。");
  }
  return { ...summary, suggestions };
}

function runCommand(command, args, cwd) {
  try {
    const res = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: String(res.stdout || "").trim(),
      stderr: String(res.stderr || "").trim(),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: -1,
      stdout: "",
      stderr: "",
      error: error?.message || "command failed",
    };
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_error) {}
    return { ok: res.ok, status: res.status, text, json };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      json: null,
      error: error?.message || "fetch failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchApiWithFallback(baseUrl, v1Path, legacyPath, options = {}, timeoutMs = 4000) {
  const v1Url = `${String(baseUrl || "").replace(/\/+$/, "")}${v1Path}`;
  const v1Res = await fetchWithTimeout(v1Url, options, timeoutMs);
  if (v1Res.status !== 404) {
    return {
      ...v1Res,
      apiVersion: "v1",
      url: v1Url,
      usedLegacyFallback: false,
    };
  }
  const legacyUrl = `${String(baseUrl || "").replace(/\/+$/, "")}${legacyPath}`;
  const legacyRes = await fetchWithTimeout(legacyUrl, options, timeoutMs);
  return {
    ...legacyRes,
    apiVersion: "legacy",
    url: legacyUrl,
    usedLegacyFallback: true,
  };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, ok: true, data: null, error: "" };
  }
  try {
    return {
      exists: true,
      ok: true,
      data: JSON.parse(fs.readFileSync(filePath, "utf8")),
      error: "",
    };
  } catch (error) {
    return {
      exists: true,
      ok: false,
      data: null,
      error: error?.message || "invalid json",
    };
  }
}

function getDashboardToken() {
  const candidates = [
    process.env.DASHBOARD_API_TOKEN,
    process.env.RBAC_TOKEN_READONLY,
    process.env.RBAC_TOKEN_OPERATOR,
    process.env.RBAC_TOKEN_ADMIN,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return candidates[0] || "";
}

function withApiHeaders(token) {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function buildHealthUrl(baseUrl, pathName) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${pathName}`;
}

async function main() {
  const options = parseArgs(process.argv);
  const projectRoot = path.resolve(__dirname, "..");
  const results = [];
  const dashboardToken = getDashboardToken();

  pushResult(results, "pass", "env.node", `Node ${process.version}`, {
    cwd: process.cwd(),
    projectRoot,
  });

  const dockerVersion = runCommand("docker", ["version", "--format", "{{.Server.Version}}"], projectRoot);
  if (dockerVersion.ok) {
    pushResult(results, "pass", "docker.version", `Docker Server ${dockerVersion.stdout || "ok"}`);
  } else {
    pushResult(results, "warn", "docker.version", "Docker 未就绪或未安装", {
      error: dockerVersion.error || dockerVersion.stderr || dockerVersion.stdout,
    });
  }

  if (dockerVersion.ok) {
    const composePs = runCommand("docker", ["compose", "ps"], projectRoot);
    if (composePs.ok) {
      pushResult(results, "pass", "docker.compose.ps", "docker compose ps 可执行");
    } else {
      pushResult(results, "warn", "docker.compose.ps", "docker compose ps 执行失败", {
        error: composePs.stderr || composePs.stdout || composePs.error,
      });
    }
  }

  const targetsPath = path.join(projectRoot, "dashboard", "config", "targets.json");
  const alertsPath = path.join(projectRoot, "dashboard", "config", "alerts.json");
  const notificationsPath = path.join(projectRoot, "dashboard", "config", "notifications.json");

  const targetsFile = readJsonIfExists(targetsPath);
  const alertsFile = readJsonIfExists(alertsPath);
  const notificationsFile = readJsonIfExists(notificationsPath);

  if (!targetsFile.exists) {
    pushResult(results, "warn", "config.targets.file", "targets.json 不存在，可能使用环境变量 MONITOR_TARGETS");
  } else if (!targetsFile.ok || !Array.isArray(targetsFile.data)) {
    pushResult(results, "fail", "config.targets.file", "targets.json 解析失败或格式不是数组", {
      error: targetsFile.error,
    });
  } else {
    pushResult(results, "pass", "config.targets.file", `targets.json 已加载，目标数 ${targetsFile.data.length}`);
  }

  if (!alertsFile.exists) {
    pushResult(results, "warn", "config.alerts.file", "alerts.json 不存在，将使用默认阈值或环境变量");
  } else if (!alertsFile.ok) {
    pushResult(results, "fail", "config.alerts.file", "alerts.json 解析失败", {
      error: alertsFile.error,
    });
  } else {
    pushResult(results, "pass", "config.alerts.file", "alerts.json 格式正常");
  }

  if (!notificationsFile.exists) {
    pushResult(results, "warn", "config.notifications.file", "notifications.json 不存在，将使用默认通知配置");
  } else if (!notificationsFile.ok) {
    pushResult(results, "fail", "config.notifications.file", "notifications.json 解析失败", {
      error: notificationsFile.error,
    });
  } else {
    const bindingCount = Array.isArray(notificationsFile.data?.bindings)
      ? notificationsFile.data.bindings.length
      : 0;
    pushResult(
      results,
      "pass",
      "config.notifications.file",
      `notifications.json 格式正常，bindings=${bindingCount}`
    );
  }

  const agentHealth = await fetchWithTimeout(
    buildHealthUrl(options.agentUrl, "/healthz"),
    {},
    options.timeoutMs
  );
  if (agentHealth.ok) {
    pushResult(results, "pass", "agent.healthz", `HTTP ${agentHealth.status}`);
  } else {
    pushResult(results, "fail", "agent.healthz", "Agent 健康检查失败", {
      status: agentHealth.status,
      error: agentHealth.error || agentHealth.text,
    });
  }

  const agentReady = await fetchWithTimeout(
    buildHealthUrl(options.agentUrl, "/readyz"),
    {},
    options.timeoutMs
  );
  if (agentReady.ok) {
    pushResult(results, "pass", "agent.readyz", `HTTP ${agentReady.status}`);
  } else {
    pushResult(results, "fail", "agent.readyz", "Agent 未就绪", {
      status: agentReady.status,
      error: agentReady.error || agentReady.text,
    });
  }

  const agentHeaders = {};
  const agentToken = String(process.env.AGENT_TOKEN || "").trim();
  if (agentToken) {
    agentHeaders.Authorization = `Bearer ${agentToken}`;
  }
  const agentStatus = await fetchApiWithFallback(
    options.agentUrl,
    "/api/v1/monitor/status",
    "/api/monitor/status",
    { headers: agentHeaders },
    options.timeoutMs
  );
  if (agentStatus.ok && agentStatus.json?.system) {
    const message = agentStatus.usedLegacyFallback
      ? "Agent 状态接口可用（legacy 路径）"
      : "Agent 状态接口可用";
    pushResult(results, "pass", "agent.status", message);
  } else if (!agentToken && agentStatus.status === 403) {
    pushResult(results, "warn", "agent.status", "Agent 需要 token，当前未设置 AGENT_TOKEN 环境变量");
  } else {
    pushResult(results, "warn", "agent.status", "Agent 状态接口不可用", {
      status: agentStatus.status,
      error: agentStatus.error || agentStatus.text,
    });
  }

  const dashboardHealth = await fetchWithTimeout(
    buildHealthUrl(options.dashboardUrl, "/healthz"),
    {},
    options.timeoutMs
  );
  if (dashboardHealth.ok) {
    pushResult(results, "pass", "dashboard.healthz", `HTTP ${dashboardHealth.status}`);
  } else {
    pushResult(results, "fail", "dashboard.healthz", "Dashboard 健康检查失败", {
      status: dashboardHealth.status,
      error: dashboardHealth.error || dashboardHealth.text,
    });
  }

  const dashboardReady = await fetchWithTimeout(
    buildHealthUrl(options.dashboardUrl, "/readyz"),
    {},
    options.timeoutMs
  );
  if (dashboardReady.ok) {
    pushResult(results, "pass", "dashboard.readyz", `HTTP ${dashboardReady.status}`);
  } else {
    pushResult(results, "fail", "dashboard.readyz", "Dashboard 未就绪", {
      status: dashboardReady.status,
      error: dashboardReady.error || dashboardReady.text,
    });
  }

  const settings = await fetchApiWithFallback(
    options.dashboardUrl,
    "/api/v1/settings",
    "/api/settings",
    { headers: withApiHeaders(dashboardToken) },
    options.timeoutMs
  );
  if (settings.ok) {
    const invalidConfigs = Object.entries(settings.json?.data?.configValidation || {})
      .filter(([, value]) => value && value.ok === false)
      .map(([key]) => key);
    if (invalidConfigs.length) {
      pushResult(results, "fail", "dashboard.settings.validation", `配置校验失败: ${invalidConfigs.join(", ")}`);
    } else {
      pushResult(results, "pass", "dashboard.settings.validation", "配置校验通过");
    }
  } else if ((settings.status === 401 || settings.status === 403) && !dashboardToken) {
    pushResult(results, "warn", "dashboard.settings", "Dashboard API 启用了 RBAC，请设置 DASHBOARD_API_TOKEN");
  } else {
    pushResult(results, "warn", "dashboard.settings", "Dashboard settings 接口不可用", {
      status: settings.status,
      error: settings.error || settings.text,
    });
  }

  const notifyHealth = await fetchWithTimeout(
    buildHealthUrl(options.notifyUrl, "/healthz"),
    {},
    options.timeoutMs
  );
  if (notifyHealth.ok) {
    pushResult(results, "pass", "notify.healthz", `HTTP ${notifyHealth.status}`);
  } else {
    pushResult(results, "warn", "notify.healthz", "Notify Bridge 不可用（可选组件）", {
      status: notifyHealth.status,
      error: notifyHealth.error || notifyHealth.text,
    });
  }

  const notifyReady = await fetchWithTimeout(
    buildHealthUrl(options.notifyUrl, "/readyz"),
    {},
    options.timeoutMs
  );
  if (notifyReady.ok) {
    pushResult(results, "pass", "notify.readyz", `HTTP ${notifyReady.status}`);
  } else {
    pushResult(results, "warn", "notify.readyz", "Notify Bridge 未就绪（可选组件）", {
      status: notifyReady.status,
      error: notifyReady.error || notifyReady.text,
    });
  }

  const prometheusHealth = await fetchWithTimeout(
    buildHealthUrl(options.prometheusUrl, "/-/healthy"),
    {},
    options.timeoutMs
  );
  if (prometheusHealth.ok) {
    pushResult(results, "pass", "prometheus.health", `HTTP ${prometheusHealth.status}`);
  } else {
    pushResult(results, "warn", "prometheus.health", "Prometheus 不可达（如未启用监控栈可忽略）", {
      status: prometheusHealth.status,
      error: prometheusHealth.error || prometheusHealth.text,
    });
  }

  const grafanaHealth = await fetchWithTimeout(
    buildHealthUrl(options.grafanaUrl, "/api/health"),
    {},
    options.timeoutMs
  );
  if (grafanaHealth.ok) {
    pushResult(results, "pass", "grafana.health", `HTTP ${grafanaHealth.status}`);
  } else {
    pushResult(results, "warn", "grafana.health", "Grafana 不可达（如未启用监控栈可忽略）", {
      status: grafanaHealth.status,
      error: grafanaHealth.error || grafanaHealth.text,
    });
  }

  const targetList = Array.isArray(targetsFile.data) ? targetsFile.data : [];
  if (!targetList.length) {
    pushResult(results, "warn", "target.connectivity", "未发现本地 targets.json 目标，跳过目标连通诊断");
  } else {
    const diagnoseV1 = "/api/v1/targets/diagnose";
    const diagnoseLegacy = "/api/targets/diagnose";
    const sampleTargets = targetList.slice(0, 5);
    let failed = 0;
    for (const target of sampleTargets) {
      const body = { targetUrl: String(target?.url || "") };
      const diagnose = await fetchApiWithFallback(
        options.dashboardUrl,
        diagnoseV1,
        diagnoseLegacy,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...withApiHeaders(dashboardToken),
          },
          body: JSON.stringify(body),
        },
        Math.max(options.timeoutMs, 7000)
      );
      if (!diagnose.ok) {
        failed += 1;
        continue;
      }
      const okCount = Number(diagnose.json?.summary?.ok || 0);
      if (okCount < 1) {
        failed += 1;
      }
    }
    if (failed > 0) {
      pushResult(
        results,
        "warn",
        "target.connectivity",
        `目标诊断存在异常 ${failed}/${sampleTargets.length}（仅抽样前5个）`
      );
    } else {
      pushResult(results, "pass", "target.connectivity", `目标诊断通过（抽样 ${sampleTargets.length} 个）`);
    }
  }

  const summary = buildSummary(results);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          options,
          summary,
          results,
        },
        null,
        2
      )}\n`
    );
  } else {
    printResults(results);
    process.stdout.write(
      `\nSummary: PASS ${summary.pass} | WARN ${summary.warn} | FAIL ${summary.fail}\n`
    );
    process.stdout.write("Actions:\n");
    summary.suggestions.forEach((item, index) => {
      process.stdout.write(`${index + 1}. ${item}\n`);
    });
  }

  if (options.strict && summary.fail > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`[FAIL] doctor.runtime - ${error?.message || "unexpected error"}\n`);
  process.exitCode = 1;
});
