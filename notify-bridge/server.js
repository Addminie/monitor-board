const express = require("express");
const fs = require("fs");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 9300);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);
const NOTIFICATIONS_FILE = String(
  process.env.NOTIFICATIONS_FILE || "/app/config/notifications.json"
).trim();
const STATE_TTL_MS = Number(process.env.STATE_TTL_MS || 7 * 24 * 3600 * 1000);

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

const stateByBindingAlert = new Map();

function nowIso() {
  return new Date().toISOString();
}

function readJsonFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
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
    .map((binding, index) => normalizeBinding(binding, index, defaults))
    .filter(Boolean);

  return {
    enabled: parsed.enabled !== false,
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

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function bindingMatchesTarget(binding, event) {
  const candidateValues = [
    event.target,
    event.instance,
    event.url,
    event.alertname,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  return binding.targets.some((pattern) => {
    const normalized = String(pattern || "").trim();
    if (!normalized || normalized === "*") return true;

    if (!normalized.includes("*")) {
      const key = normalized.toLowerCase();
      return candidateValues.some((candidate) => candidate.toLowerCase() === key);
    }

    const re = wildcardToRegExp(normalized);
    return candidateValues.some((candidate) => re.test(candidate));
  });
}

function normalizeSeverity(value) {
  const key = String(value || "").trim().toLowerCase();
  if (["warn", "warning"].includes(key)) return "warn";
  if (["danger", "critical", "high", "error"].includes(key)) return "danger";
  if (["offline", "down", "unreachable"].includes(key)) return "offline";
  if (["ok", "resolved", "normal"].includes(key)) return "ok";
  return "danger";
}

function severityRank(severity) {
  return SEVERITY_RANK[severity] || 0;
}

function shouldNotifySeverity(binding, severity) {
  if (severity === "ok") return false;
  if (binding.severities.includes("all")) return true;
  return binding.severities.includes(severity);
}

function sha1(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

function parseAlertEvent(payloadAlert, payloadStatus) {
  const labels = payloadAlert?.labels && typeof payloadAlert.labels === "object"
    ? payloadAlert.labels
    : {};
  const annotations = payloadAlert?.annotations && typeof payloadAlert.annotations === "object"
    ? payloadAlert.annotations
    : {};

  const status = String(payloadAlert?.status || payloadStatus || "firing").trim().toLowerCase();
  const alertname = String(labels.alertname || "MonitorAlert").trim();
  const target = String(
    labels.target || labels.hostname || labels.instance || labels.job || "unknown-target"
  ).trim();
  const instance = String(labels.instance || "").trim();
  const url = String(labels.instance_url || labels.url || instance || "").trim();

  const severity = normalizeSeverity(labels.severity || labels.level || "danger");
  const summary = String(annotations.summary || annotations.description || alertname).trim();
  const description = String(annotations.description || "").trim();
  const startsAt = String(payloadAlert?.startsAt || nowIso()).trim();
  const fingerprint = String(payloadAlert?.fingerprint || "").trim() ||
    sha1(`${alertname}|${target}|${instance}|${payloadAlert?.generatorURL || ""}`);

  return {
    status,
    alertname,
    target,
    instance,
    url,
    severity,
    summary,
    description,
    startsAt,
    labels,
    annotations,
    fingerprint,
    reasonHash: sha1(`${severity}|${summary}|${description}`),
  };
}

function formatAlertMessage(eventType, binding, event, previousSeverity) {
  const titlePrefix =
    eventType === "recover"
      ? "[MonitorBoard][PROM][RECOVER]"
      : eventType === "test"
      ? "[MonitorBoard][PROM][TEST]"
      : "[MonitorBoard][PROM][ALERT]";

  const lines = [
    `${titlePrefix} ${event.target}`,
    `Binding: ${binding.name}`,
    `Alert: ${event.alertname}`,
    `Target: ${event.target}`,
    `Instance: ${event.instance || "-"}`,
    `Severity: ${String(event.severity || "danger").toUpperCase()}`,
  ];

  if (event.url) lines.push(`URL: ${event.url}`);

  if (eventType === "recover") {
    lines.push(`Recovered From: ${String(previousSeverity || "unknown").toUpperCase()}`);
  }

  if (event.summary) {
    lines.push("Summary:");
    lines.push(`- ${event.summary}`);
  }
  if (event.description && event.description !== event.summary) {
    lines.push("Description:");
    lines.push(`- ${event.description}`);
  }

  lines.push(`Time: ${event.startsAt || nowIso()}`);
  return lines.join("\n");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
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
  return { successCount, results };
}

async function processBindingEvent(binding, event) {
  const key = `${binding.id}::${event.fingerprint}`;
  const now = Date.now();
  const previous =
    stateByBindingAlert.get(key) ||
    ({
      status: "ok",
      lastSeverity: "ok",
      reasonHash: "",
      lastAlertAt: 0,
      lastRecoverAt: 0,
      lastSeenAt: 0,
    });

  const previousSeverity = previous.lastSeverity;

  if (event.status === "resolved") {
    if (previous.status !== "ok" && binding.notifyRecover) {
      const message = formatAlertMessage("recover", binding, event, previousSeverity);
      const dispatch = await dispatchMessage(binding, message);
      if (dispatch.successCount > 0) previous.lastRecoverAt = now;
      previous.lastDispatch = dispatch;
    }
    previous.status = "ok";
    previous.lastSeverity = "ok";
    previous.reasonHash = "";
    previous.lastSeenAt = now;
    stateByBindingAlert.set(key, previous);
    return { sent: previous.lastDispatch?.successCount || 0 };
  }

  if (!shouldNotifySeverity(binding, event.severity)) {
    previous.status = event.severity;
    previous.lastSeverity = event.severity;
    previous.reasonHash = event.reasonHash;
    previous.lastSeenAt = now;
    stateByBindingAlert.set(key, previous);
    return { sent: 0 };
  }

  const firstAlert = previous.status === "ok";
  const severityEscalated =
    severityRank(event.severity) > severityRank(previous.lastSeverity || "ok");
  const reasonChanged = previous.reasonHash !== event.reasonHash;
  const cooldownMs = binding.cooldownSec * 1000;
  const remindMs = binding.remindIntervalSec * 1000;
  const cooldownPassed = now - (previous.lastAlertAt || 0) >= cooldownMs;
  const remindDue = remindMs > 0 && now - (previous.lastAlertAt || 0) >= remindMs;

  const shouldSend =
    firstAlert || severityEscalated || (reasonChanged && cooldownPassed) || remindDue;

  let sent = 0;
  if (shouldSend) {
    const message = formatAlertMessage("alert", binding, event, previousSeverity);
    const dispatch = await dispatchMessage(binding, message);
    if (dispatch.successCount > 0) {
      previous.lastAlertAt = now;
      sent = dispatch.successCount;
    }
    previous.lastDispatch = dispatch;
  }

  previous.status = event.severity;
  previous.lastSeverity = event.severity;
  previous.reasonHash = event.reasonHash;
  previous.lastSeenAt = now;
  stateByBindingAlert.set(key, previous);
  return { sent };
}

function cleanupStates() {
  const now = Date.now();
  for (const [key, value] of stateByBindingAlert.entries()) {
    if (!value || !Number.isFinite(value.lastSeenAt)) {
      stateByBindingAlert.delete(key);
      continue;
    }
    if (now - value.lastSeenAt > Math.max(60000, STATE_TTL_MS)) {
      stateByBindingAlert.delete(key);
    }
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => {
  const notifications = loadNotifications();
  res.json({
    ok: true,
    enabled: notifications.enabled,
    bindings: notifications.bindings.length,
    stateEntries: stateByBindingAlert.size,
    timestamp: nowIso(),
  });
});

app.post("/api/alerts/webhook", async (req, res) => {
  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    const notifications = loadNotifications();

    if (!notifications.enabled || !notifications.bindings.length) {
      return res.json({
        accepted: alerts.length,
        processed: 0,
        sent: 0,
        skipped: alerts.length,
        reason: "notifications disabled or no bindings",
      });
    }

    let processed = 0;
    let sent = 0;

    for (const rawAlert of alerts) {
      const event = parseAlertEvent(rawAlert, payload.status);
      for (const binding of notifications.bindings) {
        if (!bindingMatchesTarget(binding, event)) continue;
        const result = await processBindingEvent(binding, event);
        processed += 1;
        sent += Number(result?.sent || 0);
      }
    }

    res.json({
      accepted: alerts.length,
      processed,
      sent,
      skipped: Math.max(0, alerts.length - processed),
      timestamp: nowIso(),
    });
  } catch (error) {
    console.error("webhook failed:", error?.message || error);
    res.status(500).json({ message: error?.message || "webhook failed" });
  }
});

app.post("/api/alerts/test", async (req, res) => {
  const notifications = loadNotifications();
  if (!notifications.enabled || !notifications.bindings.length) {
    return res.status(400).json({ message: "notifications disabled or no bindings configured" });
  }

  const bindingName = String(req.body?.binding || "").trim();
  const selectedBindings = notifications.bindings.filter((binding) =>
    bindingName ? binding.name === bindingName : true
  );
  if (!selectedBindings.length) {
    return res.status(404).json({ message: "binding not found" });
  }

  const severity = normalizeSeverity(req.body?.severity || "danger");
  const event = {
    status: "firing",
    alertname: String(req.body?.alertname || "ManualTest").trim(),
    target: String(req.body?.target || "manual-test").trim(),
    instance: String(req.body?.instance || "manual://test").trim(),
    url: String(req.body?.url || "manual://test").trim(),
    severity,
    summary: String(req.body?.message || "manual test alert").trim(),
    description: "",
    startsAt: nowIso(),
    labels: {},
    annotations: {},
    fingerprint: sha1(`manual|${Date.now()}|${Math.random()}`),
    reasonHash: sha1(`manual|${Date.now()}`),
  };

  const results = [];
  for (const binding of selectedBindings) {
    const message = formatAlertMessage("test", binding, event, "ok");
    const dispatch = await dispatchMessage(binding, message);
    results.push({
      binding: binding.name,
      successCount: dispatch.successCount,
      results: dispatch.results,
    });
  }

  res.json({ data: results });
});

setInterval(cleanupStates, 60 * 1000);

app.listen(PORT, () => {
  console.log(`monitor-notify-bridge running on http://0.0.0.0:${PORT}`);
  console.log(`notifications file: ${NOTIFICATIONS_FILE}`);
});
