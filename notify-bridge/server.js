const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 9300);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);
const NOTIFICATIONS_FILE = String(
  process.env.NOTIFICATIONS_FILE || "/app/config/notifications.json"
).trim();
const STATE_TTL_MS = Number(process.env.STATE_TTL_MS || 7 * 24 * 3600 * 1000);
const STARTED_AT = Date.now();
const SERVICE_NAME = "monitor-notify-bridge";
const EXIT_ON_UNCAUGHT_EXCEPTION =
  String(process.env.EXIT_ON_UNCAUGHT_EXCEPTION || "false").toLowerCase() === "true";
const NOTIFY_RETRY_COUNT = Math.max(0, Math.floor(Number(process.env.NOTIFY_RETRY_COUNT || 2) || 0));
const NOTIFY_RETRY_BACKOFF_MS = Math.max(
  200,
  Math.floor(Number(process.env.NOTIFY_RETRY_BACKOFF_MS || 1000) || 1000)
);
const DEADLETTER_FILE = String(
  process.env.DEADLETTER_FILE || path.join(__dirname, "logs", "notify-bridge-deadletter.jsonl")
).trim();
const STATE_PERSIST_ENABLED = String(process.env.STATE_PERSIST_ENABLED || "true") !== "false";
const STATE_DB_FILE = String(
  process.env.STATE_DB_FILE || path.join(__dirname, "data", "notify-bridge-state.db")
).trim();
const API_VERSION = "v1";

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
const dispatchQueue = [];
let dispatchWorkerRunning = false;
let stateStore = {
  enabled: false,
  reason: "not_initialized",
  backend: "none",
  dbFile: STATE_DB_FILE,
  loadStmt: null,
  upsertStmt: null,
  deleteStmt: null,
  db: null,
};

function nowIso() {
  return new Date().toISOString();
}

function serializeError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.stack || error.message || error);
}

function logEvent(level, event, details = {}) {
  const payload = {
    ts: nowIso(),
    level,
    service: SERVICE_NAME,
    event,
    ...details,
  };
  const line = JSON.stringify(payload);
  if (level === "error" || level === "fatal") {
    console.error(line);
    return;
  }
  console.log(line);
}

function sendApiError(res, status, code, message, details = null) {
  const errorPayload = {
    code: String(code || "INTERNAL_ERROR"),
    message: String(message || "request failed"),
  };
  if (details && typeof details === "object") {
    errorPayload.details = details;
  }
  return res.status(status).json({
    message: errorPayload.message,
    error: errorPayload,
  });
}

function installProcessGuards() {
  process.on("unhandledRejection", (reason) => {
    logEvent("error", "process.unhandled_rejection", { error: serializeError(reason) });
  });
  process.on("uncaughtException", (error) => {
    logEvent("fatal", "process.uncaught_exception", { error: serializeError(error) });
    if (EXIT_ON_UNCAUGHT_EXCEPTION) {
      setTimeout(() => process.exit(1), 200).unref();
    }
  });
}

function initStateStore() {
  if (!STATE_PERSIST_ENABLED) {
    stateStore = {
      enabled: false,
      reason: "disabled_by_env",
      backend: "none",
      dbFile: STATE_DB_FILE,
      loadStmt: null,
      upsertStmt: null,
      deleteStmt: null,
      db: null,
    };
    logEvent("info", "state_store.disabled", { dbFile: STATE_DB_FILE });
    return;
  }
  try {
    const { DatabaseSync } = require("node:sqlite");
    const dir = path.dirname(STATE_DB_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(STATE_DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS notify_bridge_state (
        map_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const loadStmt = db.prepare(`
      SELECT map_key AS mapKey, value_json AS valueJson
      FROM notify_bridge_state
    `);
    const upsertStmt = db.prepare(`
      INSERT INTO notify_bridge_state (map_key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(map_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    const deleteStmt = db.prepare(`
      DELETE FROM notify_bridge_state WHERE map_key = ?
    `);
    stateStore = {
      enabled: true,
      reason: "ok",
      backend: "sqlite",
      dbFile: STATE_DB_FILE,
      loadStmt,
      upsertStmt,
      deleteStmt,
      db,
    };
    logEvent("info", "state_store.ready", {
      backend: stateStore.backend,
      dbFile: stateStore.dbFile,
    });
  } catch (error) {
    stateStore = {
      enabled: false,
      reason: serializeError(error),
      backend: "none",
      dbFile: STATE_DB_FILE,
      loadStmt: null,
      upsertStmt: null,
      deleteStmt: null,
      db: null,
    };
    logEvent("error", "state_store.init_failed", {
      dbFile: STATE_DB_FILE,
      error: serializeError(error),
    });
  }
}

function closeStateStore() {
  if (!stateStore.enabled || !stateStore.db) return;
  try {
    stateStore.db.close();
  } catch (_error) {}
}

function persistStateEntry(mapKey, value) {
  if (!stateStore.enabled || !stateStore.upsertStmt) return;
  try {
    stateStore.upsertStmt.run(mapKey, JSON.stringify(value), nowIso());
  } catch (error) {
    logEvent("error", "state_store.persist_failed", {
      mapKey,
      error: serializeError(error),
    });
  }
}

function removeStateEntry(mapKey) {
  if (!stateStore.enabled || !stateStore.deleteStmt) return;
  try {
    stateStore.deleteStmt.run(mapKey);
  } catch (error) {
    logEvent("error", "state_store.delete_failed", {
      mapKey,
      error: serializeError(error),
    });
  }
}

function setBindingAlertState(mapKey, value) {
  stateByBindingAlert.set(mapKey, value);
  persistStateEntry(mapKey, value);
}

function deleteBindingAlertState(mapKey) {
  stateByBindingAlert.delete(mapKey);
  removeStateEntry(mapKey);
}

function restoreStateFromStore() {
  if (!stateStore.enabled || !stateStore.loadStmt) return;
  try {
    const rows = stateStore.loadStmt.all();
    let count = 0;
    rows.forEach((row) => {
      const key = String(row?.mapKey || "");
      if (!key) return;
      let value;
      try {
        value = JSON.parse(String(row?.valueJson || "null"));
      } catch (_error) {
        return;
      }
      if (!value || typeof value !== "object") return;
      stateByBindingAlert.set(key, value);
      count += 1;
    });
    logEvent("info", "state_store.restored", {
      stateEntries: count,
      dbFile: stateStore.dbFile,
    });
  } catch (error) {
    logEvent("error", "state_store.restore_failed", {
      dbFile: stateStore.dbFile,
      error: serializeError(error),
    });
  }
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

function normalizeBindingSilence(input, index) {
  if (!input || typeof input !== "object") return null;
  if (input.enabled === false) return null;

  const endRaw = String(input.endAt || input.end || "").trim();
  if (!endRaw) return null;
  const endMs = Date.parse(endRaw);
  if (!Number.isFinite(endMs)) return null;

  const startRaw = String(input.startAt || input.start || "").trim();
  const startMs = startRaw ? Date.parse(startRaw) : null;
  if (startRaw && !Number.isFinite(startMs)) return null;
  if (Number.isFinite(startMs) && endMs <= startMs) return null;

  const targetsRaw = Array.isArray(input.targets) ? input.targets : ["*"];
  const targets = targetsRaw.map((item) => String(item).trim()).filter(Boolean);
  const severitiesRaw = Array.isArray(input.severities) ? input.severities : ["all"];
  const severities = severitiesRaw
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => ["all", "offline", "danger", "warn"].includes(item));

  return {
    id: String(input.id || `silence-${index + 1}`),
    name: String(input.name || `silence-${index + 1}`),
    startAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : "",
    endAt: new Date(endMs).toISOString(),
    startMs: Number.isFinite(startMs) ? startMs : null,
    endMs,
    targets: targets.length ? targets : ["*"],
    severities: severities.length ? severities : ["all"],
  };
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
  const silenceItems = Array.isArray(binding.silences) ? binding.silences : [];
  if (binding.silenceUntil != null) {
    silenceItems.push({
      name: "silenceUntil",
      endAt: binding.silenceUntil,
      targets: Array.isArray(binding.silenceTargets) ? binding.silenceTargets : ["*"],
      severities: Array.isArray(binding.silenceSeverities)
        ? binding.silenceSeverities
        : ["all"],
    });
  }
  const silences = silenceItems
    .map((item, silenceIndex) => normalizeBindingSilence(item, silenceIndex))
    .filter(Boolean);

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
    silences,
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

function checkNotificationsConfigReady() {
  const env = String(process.env.MONITOR_NOTIFICATIONS || "").trim();
  if (env) {
    try {
      JSON.parse(env);
      return { ok: true, source: "env", detail: "MONITOR_NOTIFICATIONS" };
    } catch (error) {
      return {
        ok: false,
        source: "env",
        detail: "MONITOR_NOTIFICATIONS",
        message: error?.message || "invalid MONITOR_NOTIFICATIONS",
      };
    }
  }

  if (fs.existsSync(NOTIFICATIONS_FILE)) {
    try {
      JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, "utf8"));
      return { ok: true, source: "file", detail: NOTIFICATIONS_FILE };
    } catch (error) {
      return {
        ok: false,
        source: "file",
        detail: NOTIFICATIONS_FILE,
        message: error?.message || "invalid notifications file",
      };
    }
  }

  return { ok: true, source: "default", detail: "built-in defaults" };
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function eventCandidateValues(event) {
  return [
    event.target,
    event.instance,
    event.url,
    event.alertname,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function matchesCandidatePatterns(candidateValues, patterns) {
  return patterns.some((pattern) => {
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

function bindingMatchesTarget(binding, event) {
  const candidateValues = eventCandidateValues(event);
  return matchesCandidatePatterns(candidateValues, binding.targets);
}

function isSilenceWindowActive(silence, timestampMs) {
  if (!silence) return false;
  if (silence.startMs != null && timestampMs < silence.startMs) return false;
  return timestampMs <= silence.endMs;
}

function shouldSilenceSeverity(silence, severity) {
  if (!silence) return false;
  if (silence.severities.includes("all")) return true;
  return silence.severities.includes(severity);
}

function getBindingSilence(binding, event, severity, timestampMs = Date.now()) {
  const candidateValues = eventCandidateValues(event);
  const silences = Array.isArray(binding?.silences) ? binding.silences : [];
  for (const silence of silences) {
    if (!isSilenceWindowActive(silence, timestampMs)) continue;
    if (!shouldSilenceSeverity(silence, severity)) continue;
    if (!matchesCandidatePatterns(candidateValues, silence.targets)) continue;
    return {
      silenced: true,
      name: silence.name || silence.id || "silence-window",
      endAt: silence.endAt || "",
    };
  }
  return { silenced: false, name: "", endAt: "" };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendDeadLetter(entry) {
  try {
    const line = `${JSON.stringify(entry)}\n`;
    fs.mkdirSync(path.dirname(DEADLETTER_FILE), { recursive: true });
    fs.appendFileSync(DEADLETTER_FILE, line, "utf8");
  } catch (error) {
    logEvent("error", "dead_letter.write_failed", {
      file: DEADLETTER_FILE,
      error: serializeError(error),
    });
  }
}

async function sendToChannelWithRetry(channel, message) {
  let attempt = 0;
  let lastError = null;
  while (attempt <= NOTIFY_RETRY_COUNT) {
    attempt += 1;
    try {
      await sendToChannel(channel, message);
      return { ok: true, attempts: attempt, error: null };
    } catch (error) {
      lastError = error;
      if (attempt > NOTIFY_RETRY_COUNT) break;
      const delay = NOTIFY_RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  return {
    ok: false,
    attempts: attempt,
    error: lastError?.message || "send failed",
  };
}

async function dispatchMessage(binding, message, meta = {}) {
  const results = [];
  for (const channel of binding.channels) {
    const sendResult = await sendToChannelWithRetry(channel, message);
    const row = {
      channel: channel.name,
      type: channel.type,
      ok: sendResult.ok,
      attempts: sendResult.attempts,
      error: sendResult.error,
    };
    results.push(row);
    if (!sendResult.ok) {
      appendDeadLetter({
        ts: nowIso(),
        source: SERVICE_NAME,
        binding: binding.name,
        channel: channel.name,
        channelType: channel.type,
        attempts: sendResult.attempts,
        error: sendResult.error,
        meta,
      });
    }
  }
  const successCount = results.filter((item) => item.ok).length;
  return { successCount, results };
}

function runDispatchWorker() {
  if (dispatchWorkerRunning) return;
  dispatchWorkerRunning = true;
  const next = async () => {
    const job = dispatchQueue.shift();
    if (!job) {
      dispatchWorkerRunning = false;
      return;
    }
    try {
      const dispatch = await dispatchMessage(job.binding, job.message, job.meta);
      job.resolve(dispatch);
    } catch (error) {
      job.resolve({
        results: [],
        successCount: 0,
        error: error?.message || "dispatch failed",
      });
    }
    setImmediate(next);
  };
  setImmediate(next);
}

function enqueueDispatchMessage(binding, message, meta = {}) {
  return new Promise((resolve) => {
    dispatchQueue.push({ binding, message, meta, resolve });
    runDispatchWorker();
  });
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
      lastSilencedAt: 0,
      lastSilence: "",
      isActive: false,
    });

  const previousSeverity = previous.lastSeverity;
  const silence = getBindingSilence(binding, event, event.severity, now);
  if (silence.silenced) {
    previous.lastSilencedAt = now;
    previous.lastSilence = `${silence.name} until ${silence.endAt || "n/a"}`;
  } else {
    previous.lastSilence = "";
  }

  if (event.status === "resolved") {
    if (previous.status !== "ok" && binding.notifyRecover && !silence.silenced) {
      const message = formatAlertMessage("recover", binding, event, previousSeverity);
      const dispatch = await enqueueDispatchMessage(binding, message, {
        eventType: "recover",
        target: event.target,
        instance: event.instance,
        alertname: event.alertname,
        severity: event.severity,
      });
      if (dispatch.successCount > 0) previous.lastRecoverAt = now;
      previous.lastDispatch = dispatch;
    }
    previous.status = "ok";
    previous.lastSeverity = "ok";
    previous.reasonHash = "";
    previous.lastSeenAt = now;
    previous.isActive = false;
    setBindingAlertState(key, previous);
    return { sent: previous.lastDispatch?.successCount || 0 };
  }

  if (!shouldNotifySeverity(binding, event.severity)) {
    previous.status = event.severity;
    previous.lastSeverity = event.severity;
    previous.reasonHash = event.reasonHash;
    previous.lastSeenAt = now;
    setBindingAlertState(key, previous);
    return { sent: 0 };
  }

  const firstActiveAlert = !previous.isActive;
  const severityEscalated =
    severityRank(event.severity) > severityRank(previous.lastSeverity || "ok");
  const reasonChanged = previous.reasonHash !== event.reasonHash;
  const cooldownMs = binding.cooldownSec * 1000;
  const remindMs = binding.remindIntervalSec * 1000;
  const cooldownPassed = now - (previous.lastAlertAt || 0) >= cooldownMs;
  const remindDue = remindMs > 0 && now - (previous.lastAlertAt || 0) >= remindMs;

  const shouldSend =
    firstActiveAlert || severityEscalated || (reasonChanged && cooldownPassed) || remindDue;

  let sent = 0;
  if (shouldSend && !silence.silenced) {
    const message = formatAlertMessage("alert", binding, event, previousSeverity);
    const dispatch = await enqueueDispatchMessage(binding, message, {
      eventType: "alert",
      target: event.target,
      instance: event.instance,
      alertname: event.alertname,
      severity: event.severity,
    });
    if (dispatch.successCount > 0) {
      previous.lastAlertAt = now;
      sent = dispatch.successCount;
    }
    previous.lastDispatch = dispatch;
  }

  if (firstActiveAlert) {
    previous.isActive = !silence.silenced;
  } else if (previous.isActive) {
    previous.isActive = true;
  }

  previous.status = event.severity;
  previous.lastSeverity = event.severity;
  previous.reasonHash = event.reasonHash;
  previous.lastSeenAt = now;
  setBindingAlertState(key, previous);
  return { sent };
}

function cleanupStates() {
  const now = Date.now();
  for (const [key, value] of stateByBindingAlert.entries()) {
    if (!value || !Number.isFinite(value.lastSeenAt)) {
      deleteBindingAlertState(key);
      continue;
    }
    if (now - value.lastSeenAt > Math.max(60000, STATE_TTL_MS)) {
      deleteBindingAlertState(key);
    }
  }
}

const app = express();
installProcessGuards();
initStateStore();
restoreStateFromStore();
process.on("exit", closeStateStore);
process.on("SIGINT", () => {
  closeStateStore();
  process.exit(0);
});
process.on("SIGTERM", () => {
  closeStateStore();
  process.exit(0);
});

logEvent("info", "startup.config", {
  port: PORT,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  stateTtlMs: STATE_TTL_MS,
  notificationsFile: NOTIFICATIONS_FILE,
  notifyRetryCount: NOTIFY_RETRY_COUNT,
  notifyRetryBackoffMs: NOTIFY_RETRY_BACKOFF_MS,
  deadletterFile: DEADLETTER_FILE,
  statePersistEnabled: STATE_PERSIST_ENABLED,
  stateStoreBackend: stateStore.backend,
  stateDbFile: stateStore.dbFile,
  apiVersion: API_VERSION,
});
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const requestUrl = String(req.url || "");
  if (requestUrl === `/api/${API_VERSION}` || requestUrl.startsWith(`/api/${API_VERSION}/`)) {
    req.apiVersion = API_VERSION;
    req.url = requestUrl.replace(`/api/${API_VERSION}`, "/api");
  } else if (requestUrl === "/api" || requestUrl.startsWith("/api/")) {
    req.apiVersion = "legacy";
  }
  return next();
});
app.use((req, res, next) => {
  const requestUrl = String(req.url || "");
  if (requestUrl === "/api" || requestUrl.startsWith("/api/")) {
    res.setHeader("X-API-Version", req.apiVersion || "legacy");
  }
  return next();
});

app.get("/healthz", (_req, res) => {
  const notifications = loadNotifications();
  res.json({
    ok: true,
    service: "monitor-notify-bridge",
    enabled: notifications.enabled,
    bindings: notifications.bindings.length,
    stateEntries: stateByBindingAlert.size,
    statePersistEnabled: STATE_PERSIST_ENABLED,
    stateStoreBackend: stateStore.backend,
    dispatchQueueLength: dispatchQueue.length,
    uptimeSec: Math.floor(process.uptime()),
    startedAt: new Date(STARTED_AT).toISOString(),
    timestamp: nowIso(),
  });
});

app.get("/readyz", (_req, res) => {
  if (STATE_PERSIST_ENABLED && !stateStore.enabled) {
    return res.status(503).json({
      ok: false,
      service: "monitor-notify-bridge",
      message: "state store not ready",
      stateStoreBackend: stateStore.backend,
      stateStoreReason: stateStore.reason,
      timestamp: nowIso(),
    });
  }
  const config = checkNotificationsConfigReady();
  if (!config.ok) {
    return res.status(503).json({
      ok: false,
      service: "monitor-notify-bridge",
      message: config.message || "notify-bridge not ready",
      configSource: config.source,
      configDetail: config.detail,
      timestamp: nowIso(),
    });
  }
  const notifications = loadNotifications();
  return res.json({
    ok: true,
    service: "monitor-notify-bridge",
    configSource: config.source,
    configDetail: config.detail,
    bindings: notifications.bindings.length,
    stateStoreBackend: stateStore.backend,
    stateDbFile: stateStore.dbFile,
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
    logEvent("error", "webhook.failed", { error: serializeError(error) });
    return sendApiError(res, 500, "WEBHOOK_FAILED", error?.message || "webhook failed");
  }
});

app.post("/api/alerts/test", async (req, res) => {
  const notifications = loadNotifications();
  if (!notifications.enabled || !notifications.bindings.length) {
    return sendApiError(
      res,
      400,
      "NOTIFICATIONS_DISABLED",
      "notifications disabled or no bindings configured"
    );
  }

  const bindingName = String(req.body?.binding || "").trim();
  const selectedBindings = notifications.bindings.filter((binding) =>
    bindingName ? binding.name === bindingName : true
  );
  if (!selectedBindings.length) {
    return sendApiError(res, 404, "BINDING_NOT_FOUND", "binding not found");
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
    const dispatch = await enqueueDispatchMessage(binding, message, {
      eventType: "test",
      target: event.target,
      instance: event.instance,
      alertname: event.alertname,
      severity: event.severity,
    });
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
  logEvent("info", "startup.ready", { listen: `http://0.0.0.0:${PORT}` });
  logEvent("info", "config.notifications_file", { path: NOTIFICATIONS_FILE });
});
