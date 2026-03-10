const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 9200);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);
const ALERT_POLL_MS = Number(process.env.ALERT_POLL_MS || 15000);
const ALERT_LOOP_ENABLED = String(process.env.ALERT_LOOP_ENABLED || "true") !== "false";

const DEFAULT_ALERTS = {
  cpu: { warn: 85, danger: 95 },
  mem: { warn: 85, danger: 95 },
  disk: { warn: 80, danger: 90 },
  serviceFailedDanger: 1,
};

const DEFAULT_NOTIFICATIONS = {
  enabled: false,
  cooldownSec: 300,
  remindIntervalSec: 0,
  bindings: [],
};

const SEVERITY_RANK = {
  ok: 0,
  warn: 1,
  danger: 2,
  offline: 3,
};

const app = express();
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_DIR = path.join(__dirname, "config");
const TARGETS_FILE = path.join(CONFIG_DIR, "targets.json");
const ALERTS_FILE = path.join(CONFIG_DIR, "alerts.json");
const NOTIFICATIONS_FILE = path.join(CONFIG_DIR, "notifications.json");

const alertStateByTarget = new Map();
const bindingStateByTarget = new Map();
let alertPollInFlight = false;

function readJsonFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function normalizeTarget(target) {
  if (!target) return null;
  const name = String(target.name || "").trim();
  const url = String(target.url || "").trim();
  if (!url) return null;
  return {
    name: name || url,
    url,
    token: String(target.token || "").trim(),
  };
}

function loadTargets() {
  const env = String(process.env.MONITOR_TARGETS || "").trim();
  if (env) {
    try {
      const parsed = JSON.parse(env);
      if (Array.isArray(parsed)) return parsed;
    } catch (error) {
      console.warn("MONITOR_TARGETS parse failed:", error.message);
    }
  }
  const fileParsed = readJsonFileIfExists(TARGETS_FILE);
  if (Array.isArray(fileParsed)) return fileParsed;
  if (fileParsed != null) {
    console.warn("targets.json parse failed or invalid format");
  }
  return [];
}

function normalizePair(value, fallback) {
  let warn = Number(value?.warn);
  let danger = Number(value?.danger);
  if (!Number.isFinite(warn)) warn = fallback.warn;
  if (!Number.isFinite(danger)) danger = fallback.danger;
  warn = Math.max(0, Math.min(100, warn));
  danger = Math.max(0, Math.min(100, danger));
  if (danger < warn) {
    const temp = warn;
    warn = danger;
    danger = temp;
  }
  return { warn, danger };
}

function normalizeAlerts(input) {
  const parsed = input && typeof input === "object" ? input : {};
  const serviceFailedDanger = Number(parsed.serviceFailedDanger);
  return {
    cpu: normalizePair(parsed.cpu, DEFAULT_ALERTS.cpu),
    mem: normalizePair(parsed.mem, DEFAULT_ALERTS.mem),
    disk: normalizePair(parsed.disk, DEFAULT_ALERTS.disk),
    serviceFailedDanger:
      Number.isFinite(serviceFailedDanger) && serviceFailedDanger >= 0
        ? Math.floor(serviceFailedDanger)
        : DEFAULT_ALERTS.serviceFailedDanger,
  };
}

function loadAlerts() {
  const env = String(process.env.MONITOR_ALERTS || "").trim();
  if (env) {
    try {
      return normalizeAlerts(JSON.parse(env));
    } catch (error) {
      console.warn("MONITOR_ALERTS parse failed:", error.message);
    }
  }
  const fileParsed = readJsonFileIfExists(ALERTS_FILE);
  if (fileParsed != null) {
    return normalizeAlerts(fileParsed);
  }
  return normalizeAlerts(null);
}

function normalizeChannel(channel) {
  if (!channel || typeof channel !== "object") return null;
  const type = String(channel.type || "").trim().toLowerCase();
  const name = String(channel.name || type || "channel").trim();
  if (type === "wechat") {
    const webhook = String(channel.webhook || "").trim();
    if (!webhook) return null;
    return {
      type,
      name,
      webhook,
      mentionedMobileList: Array.isArray(channel.mentionedMobileList)
        ? channel.mentionedMobileList.map((item) => String(item).trim()).filter(Boolean)
        : [],
      mentionedList: Array.isArray(channel.mentionedList)
        ? channel.mentionedList.map((item) => String(item).trim()).filter(Boolean)
        : [],
    };
  }
  if (type === "telegram") {
    const botToken = String(channel.botToken || "").trim();
    const chatId = String(channel.chatId || "").trim();
    if (!botToken || !chatId) return null;
    return {
      type,
      name,
      botToken,
      chatId,
      topicId: channel.topicId != null ? String(channel.topicId).trim() : "",
    };
  }
  if (type === "dingtalk") {
    const webhook = String(channel.webhook || "").trim();
    if (!webhook) return null;
    return {
      type,
      name,
      webhook,
      secret: String(channel.secret || "").trim(),
      atMobiles: Array.isArray(channel.atMobiles)
        ? channel.atMobiles.map((item) => String(item).trim()).filter(Boolean)
        : [],
      isAtAll: !!channel.isAtAll,
    };
  }
  return null;
}

function normalizeBinding(binding, index, defaults) {
  if (!binding || typeof binding !== "object") return null;
  if (binding.enabled === false) return null;
  const name = String(binding.name || `binding-${index + 1}`).trim();
  const targetsRaw = Array.isArray(binding.targets) ? binding.targets : ["*"];
  const targets = targetsRaw.map((item) => String(item).trim()).filter(Boolean);
  const severitiesRaw = Array.isArray(binding.severities)
    ? binding.severities
    : ["offline", "danger"];
  const severities = severitiesRaw
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => ["all", "offline", "danger", "warn"].includes(item));
  const channels = (Array.isArray(binding.channels) ? binding.channels : [])
    .map(normalizeChannel)
    .filter(Boolean);
  if (!channels.length) return null;

  const cooldownSecRaw = Number(binding.cooldownSec);
  const remindSecRaw = Number(binding.remindIntervalSec);

  return {
    id: `${name}#${index}`,
    name,
    targets: targets.length ? targets : ["*"],
    severities: severities.length ? severities : ["offline", "danger"],
    notifyRecover: binding.notifyRecover !== false,
    cooldownSec:
      Number.isFinite(cooldownSecRaw) && cooldownSecRaw >= 0
        ? Math.floor(cooldownSecRaw)
        : defaults.cooldownSec,
    remindIntervalSec:
      Number.isFinite(remindSecRaw) && remindSecRaw >= 0
        ? Math.floor(remindSecRaw)
        : defaults.remindIntervalSec,
    channels,
  };
}

function normalizeNotifications(input) {
  const parsed = input && typeof input === "object" ? input : {};
  const cooldownSecRaw = Number(parsed.cooldownSec);
  const remindIntervalSecRaw = Number(parsed.remindIntervalSec);
  const defaults = {
    cooldownSec:
      Number.isFinite(cooldownSecRaw) && cooldownSecRaw >= 0
        ? Math.floor(cooldownSecRaw)
        : DEFAULT_NOTIFICATIONS.cooldownSec,
    remindIntervalSec:
      Number.isFinite(remindIntervalSecRaw) && remindIntervalSecRaw >= 0
        ? Math.floor(remindIntervalSecRaw)
        : DEFAULT_NOTIFICATIONS.remindIntervalSec,
  };

  const bindings = (Array.isArray(parsed.bindings) ? parsed.bindings : [])
    .map((item, index) => normalizeBinding(item, index, defaults))
    .filter(Boolean);

  return {
    enabled: parsed.enabled === true,
    cooldownSec: defaults.cooldownSec,
    remindIntervalSec: defaults.remindIntervalSec,
    bindings,
  };
}

function loadNotifications() {
  const env = String(process.env.MONITOR_NOTIFICATIONS || "").trim();
  if (env) {
    try {
      return normalizeNotifications(JSON.parse(env));
    } catch (error) {
      console.warn("MONITOR_NOTIFICATIONS parse failed:", error.message);
    }
  }
  const fileParsed = readJsonFileIfExists(NOTIFICATIONS_FILE);
  if (fileParsed != null) {
    return normalizeNotifications(fileParsed);
  }
  return normalizeNotifications(DEFAULT_NOTIFICATIONS);
}

function buildStatusUrl(targetUrl) {
  if (!targetUrl) return "";
  if (targetUrl.includes("/api/monitor/status")) return targetUrl;
  return targetUrl.replace(/\/$/, "") + "/api/monitor/status";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function collectTargetStatuses(targets) {
  if (!targets.length) return [];
  const results = await Promise.all(
    targets.map(async (target) => {
      const statusUrl = buildStatusUrl(target.url);
      const headers = {};
      if (target.token) headers.Authorization = `Bearer ${target.token}`;
      try {
        const data = await fetchWithTimeout(statusUrl, { headers });
        return {
          name: target.name,
          url: target.url,
          status: data,
          error: null,
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        return {
          name: target.name,
          url: target.url,
          status: null,
          error: error?.message || "fetch failed",
          fetchedAt: new Date().toISOString(),
        };
      }
    })
  );
  return results;
}

function computeDiskMaxPercent(status) {
  const items = Array.isArray(status?.disk?.items) ? status.disk.items : [];
  let max = null;
  items.forEach((item) => {
    const value = Number(String(item.usePercent || "").replace("%", ""));
    if (Number.isFinite(value)) {
      max = max == null ? value : Math.max(max, value);
    }
  });
  return max;
}

function highestSeverity(reasons) {
  if (!reasons.length) return "ok";
  let severity = "ok";
  reasons.forEach((item) => {
    if ((SEVERITY_RANK[item.severity] || 0) > (SEVERITY_RANK[severity] || 0)) {
      severity = item.severity;
    }
  });
  return severity;
}

function analyzeTarget(entry, alerts) {
  if (!entry || !entry.status) {
    const reasonText = entry?.error || "target unreachable";
    const summary = `offline: ${reasonText}`;
    const reasonHash = crypto.createHash("sha1").update(summary).digest("hex");
    return {
      severity: "offline",
      reasons: [{ severity: "offline", text: reasonText }],
      summary,
      reasonHash,
      metrics: {},
      timestamp: entry?.fetchedAt || new Date().toISOString(),
    };
  }

  const status = entry.status;
  const cpu = Number(status.cpu?.usagePercent);
  const mem = Number(status.memory?.usagePercent);
  const disk = Number(computeDiskMaxPercent(status));
  const failedServices = Number(status.services?.failed);
  const reasons = [];

  if (Number.isFinite(cpu)) {
    if (cpu >= alerts.cpu.danger) {
      reasons.push({
        severity: "danger",
        text: `CPU ${cpu.toFixed(1)}% >= ${alerts.cpu.danger}%`,
      });
    } else if (cpu >= alerts.cpu.warn) {
      reasons.push({
        severity: "warn",
        text: `CPU ${cpu.toFixed(1)}% >= ${alerts.cpu.warn}%`,
      });
    }
  }

  if (Number.isFinite(mem)) {
    if (mem >= alerts.mem.danger) {
      reasons.push({
        severity: "danger",
        text: `Memory ${mem.toFixed(1)}% >= ${alerts.mem.danger}%`,
      });
    } else if (mem >= alerts.mem.warn) {
      reasons.push({
        severity: "warn",
        text: `Memory ${mem.toFixed(1)}% >= ${alerts.mem.warn}%`,
      });
    }
  }

  if (Number.isFinite(disk)) {
    if (disk >= alerts.disk.danger) {
      reasons.push({
        severity: "danger",
        text: `Disk ${disk.toFixed(1)}% >= ${alerts.disk.danger}%`,
      });
    } else if (disk >= alerts.disk.warn) {
      reasons.push({
        severity: "warn",
        text: `Disk ${disk.toFixed(1)}% >= ${alerts.disk.warn}%`,
      });
    }
  }

  if (Number.isFinite(failedServices) && failedServices >= alerts.serviceFailedDanger) {
    reasons.push({
      severity: "danger",
      text: `Failed services ${failedServices} >= ${alerts.serviceFailedDanger}`,
    });
  }

  const severity = highestSeverity(reasons);
  const summary = reasons.length ? reasons.map((item) => item.text).join("; ") : "healthy";
  const reasonHash = crypto
    .createHash("sha1")
    .update(`${severity}|${summary}`)
    .digest("hex");

  return {
    severity,
    reasons,
    summary,
    reasonHash,
    metrics: {
      cpu: Number.isFinite(cpu) ? cpu : null,
      mem: Number.isFinite(mem) ? mem : null,
      disk: Number.isFinite(disk) ? disk : null,
      failedServices: Number.isFinite(failedServices) ? failedServices : null,
      load1:
        Array.isArray(status.system?.loadAvg) && Number.isFinite(status.system.loadAvg[0])
          ? status.system.loadAvg[0]
          : null,
      netRxBytesSec: Number(status.network?.rxBytesSec) || 0,
      netTxBytesSec: Number(status.network?.txBytesSec) || 0,
    },
    timestamp: status.timestamp || entry.fetchedAt || new Date().toISOString(),
  };
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function bindingMatchesTarget(binding, target) {
  const targetName = String(target.name || "");
  const targetUrl = String(target.url || "");
  return binding.targets.some((pattern) => {
    if (!pattern || pattern === "*") return true;
    if (!pattern.includes("*")) {
      return pattern.toLowerCase() === targetName.toLowerCase() ||
        pattern.toLowerCase() === targetUrl.toLowerCase();
    }
    const re = wildcardToRegExp(pattern);
    return re.test(targetName) || re.test(targetUrl);
  });
}

function severityRank(severity) {
  return SEVERITY_RANK[severity] || 0;
}

function shouldNotifySeverity(binding, severity) {
  if (severity === "ok") return false;
  if (binding.severities.includes("all")) return true;
  return binding.severities.includes(severity);
}

function formatAlertMessage(eventType, binding, target, analysis, previousSeverity) {
  const titlePrefix =
    eventType === "recover"
      ? "[MonitorBoard][RECOVER]"
      : eventType === "test"
      ? "[MonitorBoard][TEST]"
      : "[MonitorBoard][ALERT]";
  const lines = [
    `${titlePrefix} ${target.name}`,
    `Binding: ${binding.name}`,
    `Target: ${target.name}`,
    `URL: ${target.url}`,
    `Severity: ${analysis.severity.toUpperCase()}`,
  ];

  if (eventType === "recover") {
    lines.push(`Recovered From: ${String(previousSeverity || "unknown").toUpperCase()}`);
  }

  if (analysis.reasons.length) {
    lines.push("Reasons:");
    analysis.reasons.forEach((item) => {
      lines.push(`- ${item.text}`);
    });
  } else if (eventType === "test") {
    lines.push("Reasons:");
    lines.push("- Manual test notification");
  }

  if (analysis.metrics && Object.keys(analysis.metrics).length) {
    const cpu = analysis.metrics.cpu;
    const mem = analysis.metrics.mem;
    const disk = analysis.metrics.disk;
    const failedServices = analysis.metrics.failedServices;
    if (cpu != null) lines.push(`CPU: ${cpu.toFixed(1)}%`);
    if (mem != null) lines.push(`Memory: ${mem.toFixed(1)}%`);
    if (disk != null) lines.push(`Disk: ${disk.toFixed(1)}%`);
    if (failedServices != null) lines.push(`Failed Services: ${failedServices}`);
  }

  lines.push(`Time: ${analysis.timestamp || new Date().toISOString()}`);
  return lines.join("\n");
}

async function postJson(url, payload) {
  return fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    REQUEST_TIMEOUT_MS
  );
}

async function sendWeChat(channel, message) {
  const payload = {
    msgtype: "text",
    text: {
      content: message,
      mentioned_mobile_list: channel.mentionedMobileList,
      mentioned_list: channel.mentionedList,
    },
  };
  await postJson(channel.webhook, payload);
}

function signDingTalk(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = encodeURIComponent(
    crypto.createHmac("sha256", secret).update(stringToSign).digest("base64")
  );
  const separator = webhook.includes("?") ? "&" : "?";
  return `${webhook}${separator}timestamp=${timestamp}&sign=${sign}`;
}

async function sendDingTalk(channel, message) {
  const signedWebhook = signDingTalk(channel.webhook, channel.secret);
  const payload = {
    msgtype: "text",
    text: { content: message },
    at: {
      atMobiles: channel.atMobiles,
      isAtAll: channel.isAtAll,
    },
  };
  await postJson(signedWebhook, payload);
}

async function sendTelegram(channel, message) {
  const url = `https://api.telegram.org/bot${channel.botToken}/sendMessage`;
  const payload = {
    chat_id: channel.chatId,
    text: message,
    disable_web_page_preview: true,
  };
  if (channel.topicId) {
    payload.message_thread_id = Number(channel.topicId) || channel.topicId;
  }
  await postJson(url, payload);
}

async function sendToChannel(channel, message) {
  if (channel.type === "wechat") return sendWeChat(channel, message);
  if (channel.type === "dingtalk") return sendDingTalk(channel, message);
  if (channel.type === "telegram") return sendTelegram(channel, message);
  throw new Error(`unsupported channel type: ${channel.type}`);
}

async function dispatchMessage(binding, message) {
  const results = [];
  for (const channel of binding.channels) {
    try {
      await sendToChannel(channel, message);
      results.push({ channel: channel.name, type: channel.type, ok: true, error: null });
    } catch (error) {
      results.push({
        channel: channel.name,
        type: channel.type,
        ok: false,
        error: error?.message || "send failed",
      });
    }
  }
  const successCount = results.filter((item) => item.ok).length;
  return { results, successCount };
}

async function processBindingForTarget(binding, targetEntry, analysis) {
  const key = `${binding.id}::${targetEntry.url}`;
  const now = Date.now();
  const previous =
    bindingStateByTarget.get(key) ||
    ({
      status: "ok",
      lastSeverity: "ok",
      reasonHash: "",
      lastAlertAt: 0,
      lastRecoverAt: 0,
    });

  const previousSeverity = previous.lastSeverity;

  if (analysis.severity === "ok") {
    if (previous.status !== "ok" && binding.notifyRecover) {
      const message = formatAlertMessage("recover", binding, targetEntry, analysis, previousSeverity);
      const dispatch = await dispatchMessage(binding, message);
      if (dispatch.successCount > 0) previous.lastRecoverAt = now;
      previous.lastDispatch = dispatch;
    }
    previous.status = "ok";
    previous.lastSeverity = "ok";
    previous.reasonHash = "";
    bindingStateByTarget.set(key, previous);
    return;
  }

  if (!shouldNotifySeverity(binding, analysis.severity)) {
    bindingStateByTarget.set(key, previous);
    return;
  }

  const firstAlert = previous.status === "ok";
  const severityEscalated =
    severityRank(analysis.severity) > severityRank(previous.lastSeverity || "ok");
  const reasonChanged = previous.reasonHash !== analysis.reasonHash;
  const cooldownMs = binding.cooldownSec * 1000;
  const remindMs = binding.remindIntervalSec * 1000;
  const cooldownPassed = now - (previous.lastAlertAt || 0) >= cooldownMs;
  const remindDue = remindMs > 0 && now - (previous.lastAlertAt || 0) >= remindMs;

  const shouldSend =
    firstAlert || severityEscalated || (reasonChanged && cooldownPassed) || remindDue;

  if (shouldSend) {
    const message = formatAlertMessage("alert", binding, targetEntry, analysis, previousSeverity);
    const dispatch = await dispatchMessage(binding, message);
    if (dispatch.successCount > 0) previous.lastAlertAt = now;
    previous.lastDispatch = dispatch;
  }

  previous.status = analysis.severity;
  previous.lastSeverity = analysis.severity;
  previous.reasonHash = analysis.reasonHash;
  bindingStateByTarget.set(key, previous);
}

async function runAlertCheck() {
  if (alertPollInFlight) return;
  alertPollInFlight = true;
  try {
    const notifications = loadNotifications();
    if (!notifications.enabled || !notifications.bindings.length) return;

    const targets = loadTargets().map(normalizeTarget).filter(Boolean);
    if (!targets.length) return;

    const alerts = loadAlerts();
    const statuses = await collectTargetStatuses(targets);

    for (const entry of statuses) {
      const analysis = analyzeTarget(entry, alerts);
      alertStateByTarget.set(entry.url, {
        name: entry.name,
        url: entry.url,
        severity: analysis.severity,
        summary: analysis.summary,
        reasons: analysis.reasons,
        metrics: analysis.metrics,
        timestamp: analysis.timestamp,
        fetchedAt: entry.fetchedAt,
      });

      for (const binding of notifications.bindings) {
        if (!bindingMatchesTarget(binding, entry)) continue;
        await processBindingForTarget(binding, entry, analysis);
      }
    }
  } catch (error) {
    console.error("alert loop failed:", error?.message || error);
  } finally {
    alertPollInFlight = false;
  }
}

function startAlertLoop() {
  if (!ALERT_LOOP_ENABLED) {
    console.log("alert loop disabled by ALERT_LOOP_ENABLED=false");
    return;
  }
  setTimeout(() => {
    runAlertCheck();
  }, 3000);
  setInterval(() => {
    runAlertCheck();
  }, Math.max(3000, ALERT_POLL_MS));
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/echarts", express.static(path.join(__dirname, "node_modules", "echarts", "dist")));

app.get("/api/targets", (_req, res) => {
  const targets = loadTargets().map(normalizeTarget).filter(Boolean);
  res.json({ data: targets.map((item) => ({ name: item.name, url: item.url })) });
});

app.get("/api/settings", (_req, res) => {
  const notifications = loadNotifications();
  res.json({
    data: {
      alerts: loadAlerts(),
      refreshOptionsMs: [5000, 10000, 30000, 60000],
      notifications: {
        enabled: notifications.enabled,
        bindingCount: notifications.bindings.length,
      },
    },
  });
});

app.get("/api/targets/status", async (_req, res) => {
  const targets = loadTargets().map(normalizeTarget).filter(Boolean);
  if (!targets.length) return res.json({ data: [] });
  const data = await collectTargetStatuses(targets);
  res.json({ data });
});

app.get("/api/alerts/state", (_req, res) => {
  const data = Array.from(alertStateByTarget.values());
  res.json({ data, count: data.length });
});

app.post("/api/alerts/test", async (req, res) => {
  const notifications = loadNotifications();
  if (!notifications.enabled || !notifications.bindings.length) {
    return res.status(400).json({ message: "notifications disabled or no bindings configured" });
  }

  const bindingName = String(req.body?.binding || "").trim();
  const targetName = String(req.body?.target || "manual-test").trim();
  const targetUrl = String(req.body?.url || "manual://test").trim();
  const customMessage = String(req.body?.message || "").trim();
  const severity = String(req.body?.severity || "danger").trim().toLowerCase();
  const validSeverity = ["warn", "danger", "offline"].includes(severity) ? severity : "danger";

  const analysis = {
    severity: validSeverity,
    reasons: [
      {
        severity: validSeverity,
        text: customMessage || "manual test alert",
      },
    ],
    summary: customMessage || "manual test alert",
    reasonHash: crypto.createHash("sha1").update(customMessage || "manual test alert").digest("hex"),
    metrics: {},
    timestamp: new Date().toISOString(),
  };

  const targetEntry = {
    name: targetName,
    url: targetUrl,
  };

  const selectedBindings = notifications.bindings.filter((binding) =>
    bindingName ? binding.name === bindingName : true
  );
  if (!selectedBindings.length) {
    return res.status(404).json({ message: "binding not found" });
  }

  const results = [];
  for (const binding of selectedBindings) {
    const message = formatAlertMessage("test", binding, targetEntry, analysis, "ok");
    const dispatch = await dispatchMessage(binding, message);
    results.push({
      binding: binding.name,
      successCount: dispatch.successCount,
      results: dispatch.results,
    });
  }
  res.json({ data: results });
});

app.listen(PORT, () => {
  console.log(`monitor-dashboard running on http://0.0.0.0:${PORT}`);
  startAlertLoop();
});
