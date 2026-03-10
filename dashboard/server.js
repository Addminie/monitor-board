const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  parsePaginationQuery,
  buildPaginatedResponse,
} = require("./lib/api-utils");

const PORT = Number(process.env.PORT || 9200);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);
const ALERT_POLL_MS = Number(process.env.ALERT_POLL_MS || 15000);
const ALERT_LOOP_ENABLED = String(process.env.ALERT_LOOP_ENABLED || "true") !== "false";
const ALERT_DEBOUNCE_FAIL_COUNT = Math.max(
  1,
  Math.floor(Number(process.env.ALERT_DEBOUNCE_FAIL_COUNT || 1) || 1)
);
const ALERT_DEBOUNCE_RECOVER_COUNT = Math.max(
  1,
  Math.floor(Number(process.env.ALERT_DEBOUNCE_RECOVER_COUNT || 1) || 1)
);
const NOTIFY_RETRY_COUNT = Math.max(0, Math.floor(Number(process.env.NOTIFY_RETRY_COUNT || 2) || 0));
const NOTIFY_RETRY_BACKOFF_MS = Math.max(
  200,
  Math.floor(Number(process.env.NOTIFY_RETRY_BACKOFF_MS || 1000) || 1000)
);
const DEADLETTER_FILE = String(
  process.env.DEADLETTER_FILE || path.join(__dirname, "logs", "dashboard-deadletter.jsonl")
).trim();
const AUDIT_LOG_FILE = String(
  process.env.AUDIT_LOG_FILE || path.join(__dirname, "logs", "dashboard-audit.jsonl")
).trim();
const AUDIT_MAX_READ = Math.max(50, Math.floor(Number(process.env.AUDIT_MAX_READ || 1000) || 1000));
const COLLECTION_CACHE_TTL_MS = Math.max(
  1000,
  Math.floor(Number(process.env.COLLECTION_CACHE_TTL_MS || Math.min(ALERT_POLL_MS, 5000)) || 3000)
);
const PROMETHEUS_HISTORY_ENABLED =
  String(process.env.PROMETHEUS_HISTORY_ENABLED || "false").toLowerCase() === "true";
const PROMETHEUS_BASE_URL = String(process.env.PROMETHEUS_BASE_URL || "http://prometheus:9090").trim();
const PROMETHEUS_QUERY_TIMEOUT_MS = Math.max(
  1000,
  Math.floor(Number(process.env.PROMETHEUS_QUERY_TIMEOUT_MS || 10000) || 10000)
);
const PROMETHEUS_TARGET_LABEL = String(process.env.PROMETHEUS_TARGET_LABEL || "target").trim() || "target";
const STARTED_AT = Date.now();
const SERVICE_NAME = "monitor-dashboard";
const EXIT_ON_UNCAUGHT_EXCEPTION =
  String(process.env.EXIT_ON_UNCAUGHT_EXCEPTION || "false").toLowerCase() === "true";
const RBAC_ENABLED = String(process.env.RBAC_ENABLED || "false").toLowerCase() === "true";
const RBAC_TOKENS_JSON = String(process.env.RBAC_TOKENS || "").trim();
const RBAC_TOKEN_READONLY = String(process.env.RBAC_TOKEN_READONLY || "").trim();
const RBAC_TOKEN_OPERATOR = String(process.env.RBAC_TOKEN_OPERATOR || "").trim();
const RBAC_TOKEN_ADMIN = String(process.env.RBAC_TOKEN_ADMIN || "").trim();
const STATE_PERSIST_ENABLED = String(process.env.STATE_PERSIST_ENABLED || "true") !== "false";
const STATE_DB_FILE = String(
  process.env.STATE_DB_FILE || path.join(__dirname, "data", "dashboard-state.db")
).trim();
const API_VERSION = "v1";
const API_PAGINATION_MAX = Math.max(
  50,
  Math.floor(Number(process.env.API_PAGINATION_MAX || 500) || 500)
);

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
  escalateAfterSec: 0,
  escalateIntervalSec: 1800,
  escalateMaxTimes: 3,
  escalateSeverities: ["danger", "offline"],
  messageLocale: "zh-CN",
  messageTemplates: {},
  bindings: [],
};

const MESSAGE_TEMPLATE_KEYS = ["alert", "recover", "escalate", "test"];
const MESSAGE_TEMPLATE_VARIABLES = [
  "titlePrefix",
  "bindingName",
  "targetName",
  "targetUrl",
  "severity",
  "previousSeverity",
  "escalationLevel",
  "unackedSec",
  "reasons",
  "metrics",
  "timestamp",
];
const MESSAGE_TEMPLATE_PRESETS = {
  "zh-CN": {
    alert:
      "{{titlePrefix}} {{targetName}}\n绑定: {{bindingName}}\n目标: {{targetName}}\n地址: {{targetUrl}}\n级别: {{severity}}\n原因:\n{{reasons}}\n指标:\n{{metrics}}\n时间: {{timestamp}}",
    recover:
      "{{titlePrefix}} {{targetName}}\n绑定: {{bindingName}}\n目标: {{targetName}}\n地址: {{targetUrl}}\n级别: {{severity}}\n恢复前级别: {{previousSeverity}}\n原因:\n{{reasons}}\n指标:\n{{metrics}}\n时间: {{timestamp}}",
    escalate:
      "{{titlePrefix}} {{targetName}}\n绑定: {{bindingName}}\n目标: {{targetName}}\n地址: {{targetUrl}}\n级别: {{severity}}\n升级等级: {{escalationLevel}}\n未确认时长: {{unackedSec}} 秒\n原因:\n{{reasons}}\n指标:\n{{metrics}}\n时间: {{timestamp}}",
    test:
      "{{titlePrefix}} {{targetName}}\n绑定: {{bindingName}}\n目标: {{targetName}}\n地址: {{targetUrl}}\n级别: {{severity}}\n原因:\n{{reasons}}\n指标:\n{{metrics}}\n时间: {{timestamp}}",
  },
  "en-US": {
    alert:
      "{{titlePrefix}} {{targetName}}\nBinding: {{bindingName}}\nTarget: {{targetName}}\nURL: {{targetUrl}}\nSeverity: {{severity}}\nReasons:\n{{reasons}}\nMetrics:\n{{metrics}}\nTime: {{timestamp}}",
    recover:
      "{{titlePrefix}} {{targetName}}\nBinding: {{bindingName}}\nTarget: {{targetName}}\nURL: {{targetUrl}}\nSeverity: {{severity}}\nRecovered From: {{previousSeverity}}\nReasons:\n{{reasons}}\nMetrics:\n{{metrics}}\nTime: {{timestamp}}",
    escalate:
      "{{titlePrefix}} {{targetName}}\nBinding: {{bindingName}}\nTarget: {{targetName}}\nURL: {{targetUrl}}\nSeverity: {{severity}}\nEscalation Level: {{escalationLevel}}\nUnacked For: {{unackedSec}}s\nReasons:\n{{reasons}}\nMetrics:\n{{metrics}}\nTime: {{timestamp}}",
    test:
      "{{titlePrefix}} {{targetName}}\nBinding: {{bindingName}}\nTarget: {{targetName}}\nURL: {{targetUrl}}\nSeverity: {{severity}}\nReasons:\n{{reasons}}\nMetrics:\n{{metrics}}\nTime: {{timestamp}}",
  },
};

const TARGET_META_FIELDS = ["env", "business", "room", "owner"];

const SEVERITY_RANK = {
  ok: 0,
  warn: 1,
  danger: 2,
  offline: 3,
};

const ROLE_LEVEL = {
  readonly: 1,
  operator: 2,
  admin: 3,
};

const app = express();
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_DIR = path.join(__dirname, "config");
const TARGETS_FILE = path.join(CONFIG_DIR, "targets.json");
const ALERTS_FILE = path.join(CONFIG_DIR, "alerts.json");
const NOTIFICATIONS_FILE = path.join(CONFIG_DIR, "notifications.json");
const CONFIG_BACKUP_DIR = String(
  process.env.CONFIG_BACKUP_DIR || path.join(CONFIG_DIR, "backups")
).trim();
const CONFIG_BACKUP_MAX = Math.max(
  1,
  Math.floor(Number(process.env.CONFIG_BACKUP_MAX || 20) || 20)
);

const alertStateByTarget = new Map();
const bindingStateByTarget = new Map();
const ackStateByTarget = new Map();
let alertPollInFlight = false;
const dispatchQueue = [];
let dispatchWorkerRunning = false;
const statusCollectionCache = {
  targetSignature: "",
  data: [],
  collectedAtMs: 0,
  inFlight: null,
  lastReason: "",
  lastError: "",
};
const historyStoreState = {
  enabled: PROMETHEUS_HISTORY_ENABLED,
  backend: PROMETHEUS_HISTORY_ENABLED ? "prometheus" : "none",
  baseUrl: PROMETHEUS_BASE_URL,
  targetLabel: PROMETHEUS_TARGET_LABEL,
  lastSuccessAt: 0,
  lastError: "",
  lastQueryAt: 0,
};
let rbacState = {
  enabled: RBAC_ENABLED,
  tokenToRole: new Map(),
  rolesConfigured: [],
  source: "env",
  errors: [],
};
const configValidation = {
  targets: { ok: true, source: "default", errors: [] },
  alerts: { ok: true, source: "default", errors: [] },
  notifications: { ok: true, source: "default", errors: [] },
};
let stateStore = {
  enabled: false,
  reason: "not_initialized",
  backend: "none",
  dbFile: STATE_DB_FILE,
  loadStmt: null,
  upsertStmt: null,
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

function initRbacState() {
  const roleToToken = {};
  const errors = [];
  if (RBAC_TOKENS_JSON) {
    try {
      const parsed = JSON.parse(RBAC_TOKENS_JSON);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        ["readonly", "operator", "admin"].forEach((role) => {
          const token = String(parsed[role] || "").trim();
          if (token) roleToToken[role] = token;
        });
      } else {
        errors.push("RBAC_TOKENS must be a JSON object");
      }
    } catch (error) {
      errors.push(`RBAC_TOKENS parse failed: ${error?.message || "invalid json"}`);
    }
  }

  if (RBAC_TOKEN_READONLY) roleToToken.readonly = RBAC_TOKEN_READONLY;
  if (RBAC_TOKEN_OPERATOR) roleToToken.operator = RBAC_TOKEN_OPERATOR;
  if (RBAC_TOKEN_ADMIN) roleToToken.admin = RBAC_TOKEN_ADMIN;

  const tokenToRole = new Map();
  Object.entries(roleToToken).forEach(([role, token]) => {
    if (!tokenToRole.has(token)) {
      tokenToRole.set(token, role);
    } else {
      errors.push(`duplicate token configured for multiple roles: ${role}`);
    }
  });

  const rolesConfigured = Object.keys(roleToToken).filter((role) => ROLE_LEVEL[role]);
  rbacState = {
    enabled: RBAC_ENABLED,
    tokenToRole,
    rolesConfigured: rolesConfigured.sort((a, b) => ROLE_LEVEL[a] - ROLE_LEVEL[b]),
    source: RBAC_TOKENS_JSON ? "RBAC_TOKENS + single vars" : "single vars",
    errors,
  };
  if (!RBAC_ENABLED) {
    rbacState.source = "disabled";
  }
  if (RBAC_ENABLED && !rbacState.rolesConfigured.length) {
    errors.push("RBAC is enabled but no tokens configured");
  }
}

function extractRequestToken(req) {
  const authHeader = String(req.headers?.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  const xToken = String(req.headers?.["x-api-token"] || "").trim();
  return xToken;
}

function authenticateApiRequest(req, res, next) {
  if (!rbacState.enabled) {
    req.auth = { role: "admin", source: "rbac_disabled" };
    return next();
  }

  const token = extractRequestToken(req);
  if (!token) {
    return sendApiError(res, 401, "AUTH_TOKEN_MISSING", "missing api token", {
      hint: "Use Authorization: Bearer <token>",
    });
  }

  const role = rbacState.tokenToRole.get(token);
  if (!role) {
    return sendApiError(res, 401, "AUTH_TOKEN_INVALID", "invalid api token");
  }

  req.auth = {
    role,
    source: "token",
  };
  return next();
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    if (!rbacState.enabled) return next();
    const grantedRole = String(req.auth?.role || "").trim().toLowerCase();
    if ((ROLE_LEVEL[grantedRole] || 0) < (ROLE_LEVEL[requiredRole] || 0)) {
      return sendApiError(res, 403, "RBAC_FORBIDDEN", "permission denied", {
        requiredRole,
        grantedRole: grantedRole || "none",
      });
    }
    return next();
  };
}

function getRequestIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").trim();
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return String(req.ip || req.socket?.remoteAddress || "").trim();
}

function appendAuditLog(entry) {
  try {
    const line = `${JSON.stringify(entry)}\n`;
    fs.mkdirSync(path.dirname(AUDIT_LOG_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_FILE, line, "utf8");
  } catch (error) {
    logEvent("error", "audit.write_failed", {
      file: AUDIT_LOG_FILE,
      error: serializeError(error),
    });
  }
}

function writeAuditEvent(req, action, payload = {}) {
  const entry = {
    ts: nowIso(),
    action: String(action || "").trim(),
    role: String(req?.auth?.role || "unknown"),
    ip: getRequestIp(req),
    method: String(req?.method || ""),
    path: String(req?.originalUrl || req?.url || ""),
    payload,
  };
  appendAuditLog(entry);
}

function readAuditEvents(limit = 200, action = "", offset = 0) {
  if (!fs.existsSync(AUDIT_LOG_FILE)) return [];
  const raw = fs.readFileSync(AUDIT_LOG_FILE, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const result = [];
  let skipped = 0;
  for (let i = lines.length - 1; i >= 0 && result.length < limit; i -= 1) {
    try {
      const item = JSON.parse(lines[i]);
      if (action && String(item?.action || "") !== action) continue;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      result.push(item);
    } catch (_error) {}
  }
  return result;
}

function countAuditEvents(action = "") {
  if (!fs.existsSync(AUDIT_LOG_FILE)) return 0;
  const raw = fs.readFileSync(AUDIT_LOG_FILE, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!action) return lines.length;
  let count = 0;
  lines.forEach((line) => {
    try {
      const item = JSON.parse(line);
      if (String(item?.action || "") === action) {
        count += 1;
      }
    } catch (_error) {}
  });
  return count;
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
      CREATE TABLE IF NOT EXISTS dashboard_state (
        kind TEXT NOT NULL,
        map_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, map_key)
      );
    `);
    const loadStmt = db.prepare(`
      SELECT kind, map_key AS mapKey, value_json AS valueJson
      FROM dashboard_state
    `);
    const upsertStmt = db.prepare(`
      INSERT INTO dashboard_state (kind, map_key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, map_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    stateStore = {
      enabled: true,
      reason: "ok",
      backend: "sqlite",
      dbFile: STATE_DB_FILE,
      loadStmt,
      upsertStmt,
      db,
    };
    logEvent("info", "state_store.ready", {
      backend: stateStore.backend,
      dbFile: STATE_DB_FILE,
    });
  } catch (error) {
    stateStore = {
      enabled: false,
      reason: serializeError(error),
      backend: "none",
      dbFile: STATE_DB_FILE,
      loadStmt: null,
      upsertStmt: null,
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

function persistStateEntry(kind, mapKey, value) {
  if (!stateStore.enabled || !stateStore.upsertStmt) return;
  try {
    stateStore.upsertStmt.run(kind, mapKey, JSON.stringify(value), nowIso());
  } catch (error) {
    logEvent("error", "state_store.persist_failed", {
      kind,
      mapKey,
      error: serializeError(error),
    });
  }
}

function removeStateEntry(kind, mapKey) {
  if (!stateStore.enabled || !stateStore.db) return;
  try {
    stateStore.db.prepare("DELETE FROM dashboard_state WHERE kind = ? AND map_key = ?").run(
      kind,
      mapKey
    );
  } catch (error) {
    logEvent("error", "state_store.delete_failed", {
      kind,
      mapKey,
      error: serializeError(error),
    });
  }
}

function setAlertState(targetUrl, value) {
  alertStateByTarget.set(targetUrl, value);
  persistStateEntry("alert", targetUrl, value);
}

function setBindingState(bindingKey, value) {
  bindingStateByTarget.set(bindingKey, value);
  persistStateEntry("binding", bindingKey, value);
}

function setAckState(targetUrl, value) {
  ackStateByTarget.set(targetUrl, value);
  persistStateEntry("ack", targetUrl, value);
}

function deleteAckState(targetUrl) {
  ackStateByTarget.delete(targetUrl);
  removeStateEntry("ack", targetUrl);
}

function restoreStateFromStore() {
  if (!stateStore.enabled || !stateStore.loadStmt) return;
  let alertCount = 0;
  let bindingCount = 0;
  let ackCount = 0;
  try {
    const rows = stateStore.loadStmt.all();
    rows.forEach((row) => {
      const kind = String(row?.kind || "");
      const mapKey = String(row?.mapKey || "");
      if (!mapKey) return;
      let value;
      try {
        value = JSON.parse(String(row?.valueJson || "null"));
      } catch (_error) {
        return;
      }
      if (!value || typeof value !== "object") return;
      if (kind === "alert") {
        alertStateByTarget.set(mapKey, value);
        alertCount += 1;
      } else if (kind === "binding") {
        bindingStateByTarget.set(mapKey, value);
        bindingCount += 1;
      } else if (kind === "ack") {
        ackStateByTarget.set(mapKey, value);
        ackCount += 1;
      }
    });
    logEvent("info", "state_store.restored", {
      alertEntries: alertCount,
      bindingEntries: bindingCount,
      ackEntries: ackCount,
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
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function setConfigValidationResult(kind, result) {
  configValidation[kind] = {
    ok: Boolean(result?.ok),
    source: String(result?.source || "unknown"),
    errors: Array.isArray(result?.errors) ? result.errors.slice(0, 20) : [],
    checkedAt: nowIso(),
  };
}

function validateThresholdPair(value, pathName) {
  const errors = [];
  if (!value || typeof value !== "object") {
    errors.push(`${pathName} must be an object`);
    return errors;
  }
  const warn = Number(value.warn);
  const danger = Number(value.danger);
  if (!Number.isFinite(warn)) errors.push(`${pathName}.warn must be a number`);
  if (!Number.isFinite(danger)) errors.push(`${pathName}.danger must be a number`);
  if (Number.isFinite(warn) && (warn < 0 || warn > 100)) {
    errors.push(`${pathName}.warn must be in [0,100]`);
  }
  if (Number.isFinite(danger) && (danger < 0 || danger > 100)) {
    errors.push(`${pathName}.danger must be in [0,100]`);
  }
  if (Number.isFinite(warn) && Number.isFinite(danger) && danger < warn) {
    errors.push(`${pathName}.danger must be >= ${pathName}.warn`);
  }
  return errors;
}

function validateTargetsConfig(raw) {
  const errors = [];
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["targets must be an array"] };
  }
  raw.forEach((item, index) => {
    const base = `targets[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${base} must be an object`);
      return;
    }
    const url = String(item.url || "").trim();
    if (!url) errors.push(`${base}.url is required`);
    if (item.name != null && typeof item.name !== "string") {
      errors.push(`${base}.name must be a string`);
    }
    if (item.token != null && typeof item.token !== "string") {
      errors.push(`${base}.token must be a string`);
    }
    if (item.tags != null) {
      if (!item.tags || typeof item.tags !== "object" || Array.isArray(item.tags)) {
        errors.push(`${base}.tags must be an object`);
      } else {
        TARGET_META_FIELDS.forEach((field) => {
          if (item.tags[field] != null && typeof item.tags[field] !== "string") {
            errors.push(`${base}.tags.${field} must be a string`);
          }
        });
      }
    }
    TARGET_META_FIELDS.forEach((field) => {
      if (item[field] != null && typeof item[field] !== "string") {
        errors.push(`${base}.${field} must be a string`);
      }
    });
  });
  return { ok: errors.length === 0, errors };
}

function validateAlertsConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["alerts must be an object"] };
  }
  errors.push(...validateThresholdPair(raw.cpu, "alerts.cpu"));
  errors.push(...validateThresholdPair(raw.mem, "alerts.mem"));
  errors.push(...validateThresholdPair(raw.disk, "alerts.disk"));
  const serviceFailedDanger = Number(raw.serviceFailedDanger);
  if (!Number.isFinite(serviceFailedDanger) || serviceFailedDanger < 0) {
    errors.push("alerts.serviceFailedDanger must be a non-negative number");
  }
  return { ok: errors.length === 0, errors };
}

function validateNotificationChannel(channel, pathName) {
  const errors = [];
  if (!channel || typeof channel !== "object") {
    errors.push(`${pathName} must be an object`);
    return errors;
  }
  const type = String(channel.type || "").trim().toLowerCase();
  if (!["wechat", "telegram", "dingtalk"].includes(type)) {
    errors.push(`${pathName}.type must be one of wechat/telegram/dingtalk`);
    return errors;
  }
  if (type === "wechat") {
    if (!String(channel.webhook || "").trim()) errors.push(`${pathName}.webhook is required`);
  }
  if (type === "telegram") {
    if (!String(channel.botToken || "").trim()) errors.push(`${pathName}.botToken is required`);
    if (!String(channel.chatId || "").trim()) errors.push(`${pathName}.chatId is required`);
  }
  if (type === "dingtalk") {
    if (!String(channel.webhook || "").trim()) errors.push(`${pathName}.webhook is required`);
  }
  if (channel.messageLocale != null) {
    const locale = String(channel.messageLocale || "").trim();
    if (!Object.prototype.hasOwnProperty.call(MESSAGE_TEMPLATE_PRESETS, locale)) {
      errors.push(`${pathName}.messageLocale must be one of zh-CN/en-US`);
    }
  }
  if (channel.messageTemplates != null) {
    if (
      !channel.messageTemplates ||
      typeof channel.messageTemplates !== "object" ||
      Array.isArray(channel.messageTemplates)
    ) {
      errors.push(`${pathName}.messageTemplates must be an object`);
    } else {
      MESSAGE_TEMPLATE_KEYS.forEach((key) => {
        if (channel.messageTemplates[key] == null) return;
        if (typeof channel.messageTemplates[key] !== "string") {
          errors.push(`${pathName}.messageTemplates.${key} must be a string`);
        }
      });
    }
  }
  return errors;
}

function validateNotificationSilence(silence, pathName) {
  const errors = [];
  if (!silence || typeof silence !== "object") {
    errors.push(`${pathName} must be an object`);
    return errors;
  }
  const endRaw = String(silence.endAt || silence.end || "").trim();
  if (!endRaw) {
    errors.push(`${pathName}.endAt is required`);
    return errors;
  }
  const endMs = Date.parse(endRaw);
  if (!Number.isFinite(endMs)) errors.push(`${pathName}.endAt must be ISO datetime`);
  const startRaw = String(silence.startAt || silence.start || "").trim();
  if (startRaw) {
    const startMs = Date.parse(startRaw);
    if (!Number.isFinite(startMs)) errors.push(`${pathName}.startAt must be ISO datetime`);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
      errors.push(`${pathName}.endAt must be greater than startAt`);
    }
  }
  return errors;
}

function normalizeMessageLocale(input, fallback = DEFAULT_NOTIFICATIONS.messageLocale) {
  const raw = String(input || "").trim();
  if (Object.prototype.hasOwnProperty.call(MESSAGE_TEMPLATE_PRESETS, raw)) {
    return raw;
  }
  return fallback;
}

function normalizeMessageTemplates(raw, locale) {
  const normalizedLocale = normalizeMessageLocale(locale);
  const preset = MESSAGE_TEMPLATE_PRESETS[normalizedLocale] || MESSAGE_TEMPLATE_PRESETS["zh-CN"];
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const templates = {};
  MESSAGE_TEMPLATE_KEYS.forEach((key) => {
    const value = String(source[key] || "").trim();
    templates[key] = value || preset[key];
  });
  return templates;
}

function validateNotificationsConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["notifications must be an object"] };
  }
  if (raw.enabled != null && typeof raw.enabled !== "boolean") {
    errors.push("notifications.enabled must be a boolean");
  }
  if (raw.cooldownSec != null) {
    const value = Number(raw.cooldownSec);
    if (!Number.isFinite(value) || value < 0) {
      errors.push("notifications.cooldownSec must be a non-negative number");
    }
  }
  if (raw.remindIntervalSec != null) {
    const value = Number(raw.remindIntervalSec);
    if (!Number.isFinite(value) || value < 0) {
      errors.push("notifications.remindIntervalSec must be a non-negative number");
    }
  }
  if (raw.escalateAfterSec != null) {
    const value = Number(raw.escalateAfterSec);
    if (!Number.isFinite(value) || value < 0) {
      errors.push("notifications.escalateAfterSec must be a non-negative number");
    }
  }
  if (raw.escalateIntervalSec != null) {
    const value = Number(raw.escalateIntervalSec);
    if (!Number.isFinite(value) || value < 0) {
      errors.push("notifications.escalateIntervalSec must be a non-negative number");
    }
  }
  if (raw.escalateMaxTimes != null) {
    const value = Number(raw.escalateMaxTimes);
    if (!Number.isFinite(value) || value < 0) {
      errors.push("notifications.escalateMaxTimes must be a non-negative number");
    }
  }
  if (raw.escalateSeverities != null) {
    if (!Array.isArray(raw.escalateSeverities)) {
      errors.push("notifications.escalateSeverities must be an array");
    } else {
      const allowed = new Set(["all", "offline", "danger", "warn"]);
      raw.escalateSeverities.forEach((item, index) => {
        const normalized = String(item || "").trim().toLowerCase();
        if (!allowed.has(normalized)) {
          errors.push(
            `notifications.escalateSeverities[${index}] must be one of all/offline/danger/warn`
          );
        }
      });
    }
  }
  if (raw.messageLocale != null) {
    const locale = String(raw.messageLocale || "").trim();
    if (!Object.prototype.hasOwnProperty.call(MESSAGE_TEMPLATE_PRESETS, locale)) {
      errors.push("notifications.messageLocale must be one of zh-CN/en-US");
    }
  }
  if (raw.messageTemplates != null) {
    if (
      !raw.messageTemplates ||
      typeof raw.messageTemplates !== "object" ||
      Array.isArray(raw.messageTemplates)
    ) {
      errors.push("notifications.messageTemplates must be an object");
    } else {
      MESSAGE_TEMPLATE_KEYS.forEach((key) => {
        if (raw.messageTemplates[key] == null) return;
        if (typeof raw.messageTemplates[key] !== "string") {
          errors.push(`notifications.messageTemplates.${key} must be a string`);
        }
      });
    }
  }
  const bindings = Array.isArray(raw.bindings) ? raw.bindings : null;
  if (!bindings) {
    errors.push("notifications.bindings must be an array");
  } else {
    bindings.forEach((binding, index) => {
      const base = `notifications.bindings[${index}]`;
      if (!binding || typeof binding !== "object") {
        errors.push(`${base} must be an object`);
        return;
      }
      const channels = Array.isArray(binding.channels) ? binding.channels : [];
      if (!channels.length) errors.push(`${base}.channels must contain at least one channel`);
      channels.forEach((channel, channelIndex) => {
        errors.push(
          ...validateNotificationChannel(channel, `${base}.channels[${channelIndex}]`)
        );
      });
      if (binding.silenceUntil != null) {
        const ts = Date.parse(String(binding.silenceUntil || "").trim());
        if (!Number.isFinite(ts)) errors.push(`${base}.silenceUntil must be ISO datetime`);
      }
      if (binding.escalateAfterSec != null) {
        const value = Number(binding.escalateAfterSec);
        if (!Number.isFinite(value) || value < 0) {
          errors.push(`${base}.escalateAfterSec must be a non-negative number`);
        }
      }
      if (binding.escalateIntervalSec != null) {
        const value = Number(binding.escalateIntervalSec);
        if (!Number.isFinite(value) || value < 0) {
          errors.push(`${base}.escalateIntervalSec must be a non-negative number`);
        }
      }
      if (binding.escalateMaxTimes != null) {
        const value = Number(binding.escalateMaxTimes);
        if (!Number.isFinite(value) || value < 0) {
          errors.push(`${base}.escalateMaxTimes must be a non-negative number`);
        }
      }
      if (binding.escalateSeverities != null) {
        if (!Array.isArray(binding.escalateSeverities)) {
          errors.push(`${base}.escalateSeverities must be an array`);
        } else {
          const allowed = new Set(["all", "offline", "danger", "warn"]);
          binding.escalateSeverities.forEach((item, severityIndex) => {
            const normalized = String(item || "").trim().toLowerCase();
            if (!allowed.has(normalized)) {
              errors.push(
                `${base}.escalateSeverities[${severityIndex}] must be one of all/offline/danger/warn`
              );
            }
          });
        }
      }
      if (binding.messageLocale != null) {
        const locale = String(binding.messageLocale || "").trim();
        if (!Object.prototype.hasOwnProperty.call(MESSAGE_TEMPLATE_PRESETS, locale)) {
          errors.push(`${base}.messageLocale must be one of zh-CN/en-US`);
        }
      }
      if (binding.messageTemplates != null) {
        if (
          !binding.messageTemplates ||
          typeof binding.messageTemplates !== "object" ||
          Array.isArray(binding.messageTemplates)
        ) {
          errors.push(`${base}.messageTemplates must be an object`);
        } else {
          MESSAGE_TEMPLATE_KEYS.forEach((key) => {
            if (binding.messageTemplates[key] == null) return;
            if (typeof binding.messageTemplates[key] !== "string") {
              errors.push(`${base}.messageTemplates.${key} must be a string`);
            }
          });
        }
      }
      if (binding.silences != null) {
        if (!Array.isArray(binding.silences)) {
          errors.push(`${base}.silences must be an array`);
        } else {
          binding.silences.forEach((silence, silenceIndex) => {
            errors.push(
              ...validateNotificationSilence(silence, `${base}.silences[${silenceIndex}]`)
            );
          });
        }
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function normalizeTargetMetaValue(input) {
  return String(input || "").trim();
}

function normalizeTargetMetadata(target) {
  const tags = target?.tags && typeof target.tags === "object" && !Array.isArray(target.tags)
    ? target.tags
    : {};
  const metadata = {};
  TARGET_META_FIELDS.forEach((field) => {
    const sourceValue = target?.[field] != null ? target[field] : tags?.[field];
    metadata[field] = normalizeTargetMetaValue(sourceValue);
  });
  return metadata;
}

function normalizeTarget(target) {
  if (!target) return null;
  const name = String(target.name || "").trim();
  const url = String(target.url || "").trim();
  if (!url) return null;
  const metadata = normalizeTargetMetadata(target);
  return {
    name: name || url,
    url,
    token: String(target.token || "").trim(),
    metadata,
    tags: metadata,
  };
}

function loadTargets() {
  const env = String(process.env.MONITOR_TARGETS || "").trim();
  if (env) {
    try {
      const parsed = JSON.parse(env);
      const valid = validateTargetsConfig(parsed);
      if (valid.ok) {
        setConfigValidationResult("targets", { ok: true, source: "env", errors: [] });
        return parsed;
      }
      setConfigValidationResult("targets", { ok: false, source: "env", errors: valid.errors });
      return [];
    } catch (error) {
      console.warn("MONITOR_TARGETS parse failed:", error.message);
      setConfigValidationResult("targets", {
        ok: false,
        source: "env",
        errors: [`MONITOR_TARGETS parse failed: ${error.message}`],
      });
      return [];
    }
  }
  const fileParsed = readJsonFileIfExists(TARGETS_FILE);
  if (fileParsed != null) {
    const valid = validateTargetsConfig(fileParsed);
    if (valid.ok) {
      setConfigValidationResult("targets", { ok: true, source: "file", errors: [] });
      return fileParsed;
    }
    setConfigValidationResult("targets", {
      ok: false,
      source: "file",
      errors: valid.errors.length ? valid.errors : ["targets.json invalid format"],
    });
    return [];
  }
  setConfigValidationResult("targets", { ok: true, source: "default", errors: [] });
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
      const parsed = JSON.parse(env);
      const valid = validateAlertsConfig(parsed);
      if (!valid.ok) {
        setConfigValidationResult("alerts", { ok: false, source: "env", errors: valid.errors });
        return normalizeAlerts(null);
      }
      setConfigValidationResult("alerts", { ok: true, source: "env", errors: [] });
      return normalizeAlerts(parsed);
    } catch (error) {
      console.warn("MONITOR_ALERTS parse failed:", error.message);
      setConfigValidationResult("alerts", {
        ok: false,
        source: "env",
        errors: [`MONITOR_ALERTS parse failed: ${error.message}`],
      });
      return normalizeAlerts(null);
    }
  }
  const fileParsed = readJsonFileIfExists(ALERTS_FILE);
  if (fileParsed != null) {
    const valid = validateAlertsConfig(fileParsed);
    if (!valid.ok) {
      setConfigValidationResult("alerts", { ok: false, source: "file", errors: valid.errors });
      return normalizeAlerts(null);
    }
    setConfigValidationResult("alerts", { ok: true, source: "file", errors: [] });
    return normalizeAlerts(fileParsed);
  }
  setConfigValidationResult("alerts", { ok: true, source: "default", errors: [] });
  return normalizeAlerts(null);
}

function normalizeChannel(channel, defaults = {}) {
  if (!channel || typeof channel !== "object") return null;
  const type = String(channel.type || "").trim().toLowerCase();
  const name = String(channel.name || type || "channel").trim();
  const inheritedLocale = normalizeMessageLocale(
    defaults.messageLocale,
    DEFAULT_NOTIFICATIONS.messageLocale
  );
  const inheritedTemplates = normalizeMessageTemplates(defaults.messageTemplates, inheritedLocale);
  const hasLocaleOverride = channel.messageLocale != null && String(channel.messageLocale).trim();
  const locale = normalizeMessageLocale(
    hasLocaleOverride ? channel.messageLocale : inheritedLocale,
    inheritedLocale
  );
  const channelTemplateSource =
    channel.messageTemplates &&
    typeof channel.messageTemplates === "object" &&
    !Array.isArray(channel.messageTemplates)
      ? channel.messageTemplates
      : {};
  const templates = normalizeMessageTemplates(
    hasLocaleOverride
      ? {
          ...MESSAGE_TEMPLATE_PRESETS[locale],
          ...channelTemplateSource,
        }
      : {
          ...inheritedTemplates,
          ...channelTemplateSource,
        },
    locale
  );
  const hasTemplateOverride =
    MESSAGE_TEMPLATE_KEYS.some((key) => String(channelTemplateSource[key] || "").trim());
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
      messageLocale: locale,
      messageTemplates: templates,
      hasTemplateOverride: Boolean(hasLocaleOverride || hasTemplateOverride),
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
      messageLocale: locale,
      messageTemplates: templates,
      hasTemplateOverride: Boolean(hasLocaleOverride || hasTemplateOverride),
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
      messageLocale: locale,
      messageTemplates: templates,
      hasTemplateOverride: Boolean(hasLocaleOverride || hasTemplateOverride),
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
  const cooldownSecRaw = Number(binding.cooldownSec);
  const remindSecRaw = Number(binding.remindIntervalSec);
  const escalateAfterSecRaw = Number(binding.escalateAfterSec);
  const escalateIntervalSecRaw = Number(binding.escalateIntervalSec);
  const escalateMaxTimesRaw = Number(binding.escalateMaxTimes);
  const escalateSeveritiesRaw = Array.isArray(binding.escalateSeverities)
    ? binding.escalateSeverities
    : defaults.escalateSeverities;
  const escalateSeverities = escalateSeveritiesRaw
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => ["all", "offline", "danger", "warn"].includes(item));
  const messageLocale = normalizeMessageLocale(binding.messageLocale, defaults.messageLocale);
  const messageTemplates = normalizeMessageTemplates(binding.messageTemplates, messageLocale);
  const channels = (Array.isArray(binding.channels) ? binding.channels : [])
    .map((item) =>
      normalizeChannel(item, {
        messageLocale,
        messageTemplates,
      })
    )
    .filter(Boolean);
  if (!channels.length) return null;
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
    escalateAfterSec:
      Number.isFinite(escalateAfterSecRaw) && escalateAfterSecRaw >= 0
        ? Math.floor(escalateAfterSecRaw)
        : defaults.escalateAfterSec,
    escalateIntervalSec:
      Number.isFinite(escalateIntervalSecRaw) && escalateIntervalSecRaw >= 0
        ? Math.floor(escalateIntervalSecRaw)
        : defaults.escalateIntervalSec,
    escalateMaxTimes:
      Number.isFinite(escalateMaxTimesRaw) && escalateMaxTimesRaw >= 0
        ? Math.floor(escalateMaxTimesRaw)
        : defaults.escalateMaxTimes,
    escalateSeverities: escalateSeverities.length
      ? escalateSeverities
      : defaults.escalateSeverities,
    messageLocale,
    messageTemplates,
    channels,
    silences,
  };
}

function normalizeNotifications(input) {
  const parsed = input && typeof input === "object" ? input : {};
  const cooldownSecRaw = Number(parsed.cooldownSec);
  const remindIntervalSecRaw = Number(parsed.remindIntervalSec);
  const escalateAfterSecRaw = Number(parsed.escalateAfterSec);
  const escalateIntervalSecRaw = Number(parsed.escalateIntervalSec);
  const escalateMaxTimesRaw = Number(parsed.escalateMaxTimes);
  const escalateSeveritiesRaw = Array.isArray(parsed.escalateSeverities)
    ? parsed.escalateSeverities
    : DEFAULT_NOTIFICATIONS.escalateSeverities;
  const escalateSeverities = escalateSeveritiesRaw
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => ["all", "offline", "danger", "warn"].includes(item));
  const messageLocale = normalizeMessageLocale(
    parsed.messageLocale,
    DEFAULT_NOTIFICATIONS.messageLocale
  );
  const messageTemplates = normalizeMessageTemplates(parsed.messageTemplates, messageLocale);
  const defaults = {
    cooldownSec:
      Number.isFinite(cooldownSecRaw) && cooldownSecRaw >= 0
        ? Math.floor(cooldownSecRaw)
        : DEFAULT_NOTIFICATIONS.cooldownSec,
    remindIntervalSec:
      Number.isFinite(remindIntervalSecRaw) && remindIntervalSecRaw >= 0
        ? Math.floor(remindIntervalSecRaw)
        : DEFAULT_NOTIFICATIONS.remindIntervalSec,
    escalateAfterSec:
      Number.isFinite(escalateAfterSecRaw) && escalateAfterSecRaw >= 0
        ? Math.floor(escalateAfterSecRaw)
        : DEFAULT_NOTIFICATIONS.escalateAfterSec,
    escalateIntervalSec:
      Number.isFinite(escalateIntervalSecRaw) && escalateIntervalSecRaw >= 0
        ? Math.floor(escalateIntervalSecRaw)
        : DEFAULT_NOTIFICATIONS.escalateIntervalSec,
    escalateMaxTimes:
      Number.isFinite(escalateMaxTimesRaw) && escalateMaxTimesRaw >= 0
        ? Math.floor(escalateMaxTimesRaw)
        : DEFAULT_NOTIFICATIONS.escalateMaxTimes,
    escalateSeverities: escalateSeverities.length
      ? escalateSeverities
      : DEFAULT_NOTIFICATIONS.escalateSeverities,
    messageLocale,
    messageTemplates,
  };

  const bindings = (Array.isArray(parsed.bindings) ? parsed.bindings : [])
    .map((item, index) => normalizeBinding(item, index, defaults))
    .filter(Boolean);

  return {
    enabled: parsed.enabled === true,
    cooldownSec: defaults.cooldownSec,
    remindIntervalSec: defaults.remindIntervalSec,
    escalateAfterSec: defaults.escalateAfterSec,
    escalateIntervalSec: defaults.escalateIntervalSec,
    escalateMaxTimes: defaults.escalateMaxTimes,
    escalateSeverities: defaults.escalateSeverities,
    messageLocale: defaults.messageLocale,
    messageTemplates: defaults.messageTemplates,
    bindings,
  };
}

function loadNotifications() {
  const env = String(process.env.MONITOR_NOTIFICATIONS || "").trim();
  if (env) {
    try {
      const parsed = JSON.parse(env);
      const valid = validateNotificationsConfig(parsed);
      if (!valid.ok) {
        setConfigValidationResult("notifications", {
          ok: false,
          source: "env",
          errors: valid.errors,
        });
        return normalizeNotifications(DEFAULT_NOTIFICATIONS);
      }
      setConfigValidationResult("notifications", { ok: true, source: "env", errors: [] });
      return normalizeNotifications(parsed);
    } catch (error) {
      console.warn("MONITOR_NOTIFICATIONS parse failed:", error.message);
      setConfigValidationResult("notifications", {
        ok: false,
        source: "env",
        errors: [`MONITOR_NOTIFICATIONS parse failed: ${error.message}`],
      });
      return normalizeNotifications(DEFAULT_NOTIFICATIONS);
    }
  }
  const fileParsed = readJsonFileIfExists(NOTIFICATIONS_FILE);
  if (fileParsed != null) {
    const valid = validateNotificationsConfig(fileParsed);
    if (!valid.ok) {
      setConfigValidationResult("notifications", {
        ok: false,
        source: "file",
        errors: valid.errors,
      });
      return normalizeNotifications(DEFAULT_NOTIFICATIONS);
    }
    setConfigValidationResult("notifications", { ok: true, source: "file", errors: [] });
    return normalizeNotifications(fileParsed);
  }
  setConfigValidationResult("notifications", {
    ok: true,
    source: "default",
    errors: [],
  });
  return normalizeNotifications(DEFAULT_NOTIFICATIONS);
}

function getConfigTypeDescriptor(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "targets") {
    return {
      type: normalized,
      filePath: TARGETS_FILE,
      validate: validateTargetsConfig,
      reload: loadTargets,
    };
  }
  if (normalized === "alerts") {
    return {
      type: normalized,
      filePath: ALERTS_FILE,
      validate: validateAlertsConfig,
      reload: loadAlerts,
    };
  }
  if (normalized === "notifications") {
    return {
      type: normalized,
      filePath: NOTIFICATIONS_FILE,
      validate: validateNotificationsConfig,
      reload: loadNotifications,
    };
  }
  return null;
}

function ensureConfigDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

function listConfigBackups(type) {
  if (!fs.existsSync(CONFIG_BACKUP_DIR)) return [];
  const prefix = `${type}-`;
  return fs
    .readdirSync(CONFIG_BACKUP_DIR, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.startsWith(prefix) && item.name.endsWith(".json"))
    .map((item) => {
      const fullPath = path.join(CONFIG_BACKUP_DIR, item.name);
      const stat = fs.statSync(fullPath);
      return {
        file: item.name,
        path: fullPath,
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function pruneBackups(type) {
  const backups = listConfigBackups(type);
  const stale = backups.slice(CONFIG_BACKUP_MAX);
  stale.forEach((item) => {
    try {
      fs.unlinkSync(item.path);
    } catch (_error) {}
  });
}

function backupCurrentConfig(type, filePath, reason) {
  if (!fs.existsSync(filePath)) return null;
  ensureConfigDirs();
  const fileName = `${type}-${backupTimestamp()}.json`;
  const backupPath = path.join(CONFIG_BACKUP_DIR, fileName);
  fs.copyFileSync(filePath, backupPath);
  pruneBackups(type);
  logEvent("info", "config.backup_created", {
    type,
    reason: String(reason || "update"),
    backupFile: fileName,
  });
  return fileName;
}

function getConfigPayload(body) {
  if (body && Object.prototype.hasOwnProperty.call(body, "data")) {
    return body.data;
  }
  return body;
}

function configEnvOverrideName(type) {
  if (type === "targets") return "MONITOR_TARGETS";
  if (type === "alerts") return "MONITOR_ALERTS";
  if (type === "notifications") return "MONITOR_NOTIFICATIONS";
  return "";
}

function isConfigEnvOverrideActive(type) {
  const envName = configEnvOverrideName(type);
  if (!envName) return false;
  return String(process.env[envName] || "").trim().length > 0;
}

function writeConfigWithBackup(type, payload, reason = "update") {
  const descriptor = getConfigTypeDescriptor(type);
  if (!descriptor) {
    return { ok: false, status: 404, message: "unsupported config type" };
  }
  if (isConfigEnvOverrideActive(descriptor.type)) {
    const envName = configEnvOverrideName(descriptor.type);
    return {
      ok: false,
      status: 409,
      message: `config is overridden by ${envName}, file update is blocked`,
    };
  }

  const validation = descriptor.validate(payload);
  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      message: "config validation failed",
      errors: validation.errors,
    };
  }

  try {
    ensureConfigDirs();
    const backupFile = backupCurrentConfig(descriptor.type, descriptor.filePath, reason);
    fs.writeFileSync(descriptor.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    descriptor.reload();
    logEvent("info", "config.updated", {
      type: descriptor.type,
      filePath: descriptor.filePath,
      reason,
      backupFile: backupFile || "",
    });
    return {
      ok: true,
      type: descriptor.type,
      filePath: descriptor.filePath,
      backupFile,
    };
  } catch (error) {
    logEvent("error", "config.update_failed", {
      type: descriptor.type,
      filePath: descriptor.filePath,
      reason,
      error: serializeError(error),
    });
    return {
      ok: false,
      status: 500,
      message: error?.message || "failed to save config",
    };
  }
}

function parseStringList(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function loadRawConfigForEdit(type) {
  const descriptor = getConfigTypeDescriptor(type);
  if (!descriptor) return null;
  const envName = configEnvOverrideName(type);
  if (isConfigEnvOverrideActive(type)) {
    return {
      blocked: true,
      status: 409,
      message: `config is overridden by ${envName}, file edit is blocked`,
      data: null,
    };
  }
  const fileParsed = readJsonFileIfExists(descriptor.filePath);
  if (fileParsed != null) {
    return { blocked: false, data: fileParsed };
  }
  if (type === "targets") return { blocked: false, data: [] };
  if (type === "alerts") return { blocked: false, data: normalizeAlerts(null) };
  if (type === "notifications") return { blocked: false, data: DEFAULT_NOTIFICATIONS };
  return { blocked: false, data: null };
}

function mergeTargetsByUrl(baseTargets, incomingTargets) {
  const next = [];
  const indexByUrl = new Map();
  baseTargets.forEach((item) => {
    const url = String(item?.url || "").trim().toLowerCase();
    if (!url) return;
    indexByUrl.set(url, next.length);
    next.push(item);
  });
  incomingTargets.forEach((item) => {
    const url = String(item?.url || "").trim().toLowerCase();
    if (!url) return;
    if (indexByUrl.has(url)) {
      next[indexByUrl.get(url)] = item;
      return;
    }
    indexByUrl.set(url, next.length);
    next.push(item);
  });
  return next;
}

function patchTargetMetadataItem(target, patch) {
  const next = { ...(target || {}) };
  TARGET_META_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) return;
    const value = String(patch[field] || "").trim();
    if (value) {
      next[field] = value;
      return;
    }
    delete next[field];
  });
  return next;
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

async function fetchProbe(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        data = null;
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - startedAt,
      data,
      error: res.ok ? null : (data?.message || `HTTP ${res.status}`),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      data: null,
      error: error?.message || "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseDurationSeconds(input, fallbackSec) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return fallbackSec;
  const matched = raw.match(/^(\d+)(s|m|h|d)$/);
  if (!matched) return fallbackSec;
  const amount = Number(matched[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallbackSec;
  const unit = matched[2];
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 3600;
  return amount * 86400;
}

function normalizeHistoryRange(rawRange) {
  const seconds = parseDurationSeconds(rawRange, 24 * 3600);
  return {
    raw: String(rawRange || "24h").trim() || "24h",
    seconds: Math.max(60, Math.min(90 * 86400, seconds)),
  };
}

function normalizeHistoryStep(rawStep) {
  const seconds = parseDurationSeconds(rawStep, 60);
  return {
    raw: String(rawStep || "60s").trim() || "60s",
    seconds: Math.max(15, Math.min(86400, seconds)),
  };
}

function parseTargetFilterInput(rawInput) {
  const normalized = String(rawInput || "").trim();
  if (!normalized || normalized === "*" || normalized.toLowerCase() === "all") return [];
  const dedup = new Set();
  return normalized
    .split(",")
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (dedup.has(key)) return false;
      dedup.add(key);
      return true;
    });
}

function escapePrometheusLabelRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPrometheusTargetSelector(targets) {
  if (!Array.isArray(targets) || !targets.length) return "";
  const regex = targets.map((item) => escapePrometheusLabelRegex(item)).join("|");
  return `{${PROMETHEUS_TARGET_LABEL}=~"${regex}"}`;
}

function buildPrometheusHistoryQueries(selector) {
  const cpuMetric = `monitor_cpu_usage_percent${selector}`;
  const memMetric = `monitor_memory_usage_percent${selector}`;
  const diskMetric = `monitor_disk_usage_percent${selector}`;
  const rxMetric = `monitor_network_rx_bytes_per_second${selector}`;
  const txMetric = `monitor_network_tx_bytes_per_second${selector}`;
  return {
    cpu: `avg(${cpuMetric})`,
    mem: `avg(${memMetric})`,
    disk: `max(${diskMetric})`,
    net: `(sum(${rxMetric}) + sum(${txMetric}))`,
  };
}

async function fetchPrometheusQueryRange(query, startSec, endSec, stepSec) {
  const base = PROMETHEUS_BASE_URL.replace(/\/$/, "");
  const url =
    `${base}/api/v1/query_range?query=${encodeURIComponent(query)}` +
    `&start=${encodeURIComponent(String(startSec))}` +
    `&end=${encodeURIComponent(String(endSec))}` +
    `&step=${encodeURIComponent(String(stepSec))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMETHEUS_QUERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `prometheus http ${response.status}`);
    }
    if (payload?.status !== "success") {
      throw new Error(payload?.error || "prometheus query failed");
    }
    return payload?.data?.result || [];
  } finally {
    clearTimeout(timer);
  }
}

function extractPrometheusSeries(resultRows) {
  if (!Array.isArray(resultRows) || !resultRows.length) return [];
  const first = resultRows[0];
  const values = Array.isArray(first?.values) ? first.values : [];
  return values.map((item) => {
    const tsSec = Number(Array.isArray(item) ? item[0] : NaN);
    const value = Number(Array.isArray(item) ? item[1] : NaN);
    return {
      tsMs: Number.isFinite(tsSec) ? Math.floor(tsSec * 1000) : 0,
      value: Number.isFinite(value) ? value : null,
    };
  });
}

function buildHistorySeriesPayload(rowsByMetric) {
  const firstAvailable = Object.values(rowsByMetric).find((rows) => Array.isArray(rows) && rows.length);
  const baseSeries = extractPrometheusSeries(firstAvailable || []);
  const timestampsMs = baseSeries.map((item) => item.tsMs);
  const labels = timestampsMs.map((tsMs) => new Date(tsMs).toISOString());

  const mapMetricValues = (rows) => {
    const list = extractPrometheusSeries(rows);
    if (!list.length) return timestampsMs.map(() => null);
    const values = new Map(list.map((item) => [item.tsMs, item.value]));
    return timestampsMs.map((ts) => (values.has(ts) ? values.get(ts) : null));
  };

  return {
    timestampsMs,
    labels,
    cpu: mapMetricValues(rowsByMetric.cpu),
    mem: mapMetricValues(rowsByMetric.mem),
    disk: mapMetricValues(rowsByMetric.disk),
    net: mapMetricValues(rowsByMetric.net),
  };
}

async function queryPrometheusHistorySummary(options = {}) {
  if (!PROMETHEUS_HISTORY_ENABLED) {
    const error = new Error("prometheus history is disabled");
    error.statusCode = 400;
    throw error;
  }

  const range = normalizeHistoryRange(options.range);
  const step = normalizeHistoryStep(options.step);
  const targets = parseTargetFilterInput(options.targets);
  const selector = buildPrometheusTargetSelector(targets);
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = Number.isFinite(Number(options.endSec))
    ? Math.floor(Number(options.endSec))
    : nowSec;
  const startSec = endSec - range.seconds;
  const queries = buildPrometheusHistoryQueries(selector);

  historyStoreState.lastQueryAt = Date.now();
  try {
    const [cpuRows, memRows, diskRows, netRows] = await Promise.all([
      fetchPrometheusQueryRange(queries.cpu, startSec, endSec, step.seconds),
      fetchPrometheusQueryRange(queries.mem, startSec, endSec, step.seconds),
      fetchPrometheusQueryRange(queries.disk, startSec, endSec, step.seconds),
      fetchPrometheusQueryRange(queries.net, startSec, endSec, step.seconds),
    ]);
    const series = buildHistorySeriesPayload({
      cpu: cpuRows,
      mem: memRows,
      disk: diskRows,
      net: netRows,
    });
    historyStoreState.lastSuccessAt = Date.now();
    historyStoreState.lastError = "";
    return {
      source: "prometheus",
      range: `${range.seconds}s`,
      step: `${step.seconds}s`,
      targets,
      window: {
        startSec,
        endSec,
      },
      series,
    };
  } catch (error) {
    historyStoreState.lastError = serializeError(error);
    throw error;
  }
}

function getHistoryStoreInfo() {
  return {
    enabled: historyStoreState.enabled,
    backend: historyStoreState.backend,
    baseUrl: historyStoreState.baseUrl,
    targetLabel: historyStoreState.targetLabel,
    queryTimeoutMs: PROMETHEUS_QUERY_TIMEOUT_MS,
    lastSuccessAt: historyStoreState.lastSuccessAt
      ? new Date(historyStoreState.lastSuccessAt).toISOString()
      : null,
    lastQueryAt: historyStoreState.lastQueryAt
      ? new Date(historyStoreState.lastQueryAt).toISOString()
      : null,
    lastError: historyStoreState.lastError || "",
  };
}

function diagnoseCategory(status) {
  if (status.ok) return "ok";
  if (status.status === 401 || status.status === 403) return "auth";
  if (status.status >= 400) return "api";
  return "network";
}

function diagnoseSuggestion(category, targetHasToken) {
  if (category === "auth") {
    return targetHasToken
      ? "检查 target token 是否正确、是否过期"
      : "目标可能要求鉴权，请补充 token";
  }
  if (category === "network") return "检查目标地址、端口、防火墙与网络连通性";
  if (category === "api") return "检查 Agent 进程是否正常、接口路径是否正确";
  return "连接正常";
}

async function diagnoseTarget(target) {
  const statusUrl = buildStatusUrl(target.url);
  const headers = {};
  if (target.token) headers.Authorization = `Bearer ${target.token}`;

  const probeWithToken = await fetchProbe(statusUrl, { headers });
  let category = diagnoseCategory(probeWithToken);
  let message = probeWithToken.ok ? "ok" : (probeWithToken.error || "probe failed");

  let probeWithoutToken = null;
  if (target.token && (category === "auth" || category === "api")) {
    probeWithoutToken = await fetchProbe(statusUrl, {});
    if (!probeWithToken.ok && probeWithoutToken.ok) {
      category = "auth";
      message = "token invalid or mismatched";
    }
  }

  return {
    name: target.name,
    url: target.url,
    metadata: target.metadata || {},
    tags: target.metadata || {},
    statusUrl,
    ok: category === "ok",
    category,
    httpStatus: probeWithToken.status,
    latencyMs: probeWithToken.latencyMs,
    message,
    suggestion: diagnoseSuggestion(category, Boolean(target.token)),
    checkedAt: nowIso(),
    probes: {
      withToken: probeWithToken,
      withoutToken: probeWithoutToken,
    },
  };
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
          metadata: target.metadata || {},
          tags: target.metadata || {},
          status: data,
          error: null,
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        return {
          name: target.name,
          url: target.url,
          metadata: target.metadata || {},
          tags: target.metadata || {},
          status: null,
          error: error?.message || "fetch failed",
          fetchedAt: new Date().toISOString(),
        };
      }
    })
  );
  return results;
}

function buildTargetSignature(targets) {
  if (!Array.isArray(targets) || !targets.length) return "";
  return targets
    .map((item) => `${item.url || ""}|${item.token || ""}|${item.name || ""}`)
    .sort((a, b) => a.localeCompare(b))
    .join("||");
}

function getCollectionCacheInfo(nowMs = Date.now()) {
  const ageMs =
    Number.isFinite(statusCollectionCache.collectedAtMs) && statusCollectionCache.collectedAtMs > 0
      ? Math.max(0, nowMs - statusCollectionCache.collectedAtMs)
      : null;
  return {
    ttlMs: COLLECTION_CACHE_TTL_MS,
    hasData: Array.isArray(statusCollectionCache.data) && statusCollectionCache.data.length > 0,
    inFlight: Boolean(statusCollectionCache.inFlight),
    collectedAt: statusCollectionCache.collectedAtMs
      ? new Date(statusCollectionCache.collectedAtMs).toISOString()
      : null,
    ageMs,
    lastReason: statusCollectionCache.lastReason || "",
    lastError: statusCollectionCache.lastError || "",
  };
}

async function collectTargetStatusesShared(targets, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const reason = String(options.reason || "api").trim() || "api";
  if (!Array.isArray(targets) || !targets.length) return [];

  const signature = buildTargetSignature(targets);
  const nowMs = Date.now();
  const cacheAgeMs =
    statusCollectionCache.collectedAtMs > 0 ? nowMs - statusCollectionCache.collectedAtMs : Infinity;
  const cacheFresh =
    statusCollectionCache.targetSignature === signature && cacheAgeMs <= COLLECTION_CACHE_TTL_MS;

  if (!forceRefresh && cacheFresh && Array.isArray(statusCollectionCache.data)) {
    return statusCollectionCache.data;
  }

  if (statusCollectionCache.inFlight && statusCollectionCache.targetSignature === signature) {
    return statusCollectionCache.inFlight;
  }

  statusCollectionCache.targetSignature = signature;
  const task = collectTargetStatuses(targets)
    .then((data) => {
      statusCollectionCache.data = data;
      statusCollectionCache.collectedAtMs = Date.now();
      statusCollectionCache.lastReason = reason;
      statusCollectionCache.lastError = "";
      return data;
    })
    .catch((error) => {
      statusCollectionCache.lastError = serializeError(error);
      throw error;
    })
    .finally(() => {
      statusCollectionCache.inFlight = null;
    });
  statusCollectionCache.inFlight = task;
  return task;
}

function buildTargetMetadataSummary(targets) {
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  const options = {};
  const counts = {};
  TARGET_META_FIELDS.forEach((field) => {
    const valueMap = new Map();
    normalizedTargets.forEach((target) => {
      const value = String(target?.metadata?.[field] || "").trim();
      if (!value) return;
      valueMap.set(value, (valueMap.get(value) || 0) + 1);
    });
    options[field] = Array.from(valueMap.keys()).sort((a, b) => String(a).localeCompare(String(b)));
    counts[field] = Array.from(valueMap.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  });
  return {
    totalTargets: normalizedTargets.length,
    options,
    counts,
  };
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

function matchesTargetPatterns(target, patterns) {
  const targetName = String(target?.name || "");
  const targetUrl = String(target?.url || "");
  return patterns.some((pattern) => {
    if (!pattern || pattern === "*") return true;
    if (!pattern.includes("*")) {
      return pattern.toLowerCase() === targetName.toLowerCase() ||
        pattern.toLowerCase() === targetUrl.toLowerCase();
    }
    const re = wildcardToRegExp(pattern);
    return re.test(targetName) || re.test(targetUrl);
  });
}

function bindingMatchesTarget(binding, target) {
  return matchesTargetPatterns(target, binding.targets);
}

function severityRank(severity) {
  return SEVERITY_RANK[severity] || 0;
}

function shouldNotifySeverity(binding, severity) {
  if (severity === "ok") return false;
  if (binding.severities.includes("all")) return true;
  return binding.severities.includes(severity);
}

function shouldEscalateSeverity(binding, severity) {
  if (severity === "ok") return false;
  const list = Array.isArray(binding?.escalateSeverities)
    ? binding.escalateSeverities
    : DEFAULT_NOTIFICATIONS.escalateSeverities;
  if (list.includes("all")) return true;
  return list.includes(severity);
}

function getBindingStatesByTargetUrl(targetUrl) {
  const normalized = String(targetUrl || "").trim();
  if (!normalized) return [];
  const suffix = `::${normalized}`;
  const list = [];
  for (const [mapKey, value] of bindingStateByTarget.entries()) {
    if (!String(mapKey || "").endsWith(suffix)) continue;
    if (!value || typeof value !== "object") continue;
    list.push(value);
  }
  return list;
}

function buildTargetEscalationSnapshot(targetUrl, acked = false) {
  const states = getBindingStatesByTargetUrl(targetUrl);
  if (!states.length) return null;
  const now = Date.now();
  let level = 0;
  let activeBindings = 0;
  let escalatableBindings = 0;
  let nextAt = 0;
  let lastEscalateAt = 0;

  states.forEach((item) => {
    const count = Math.max(0, Number(item?.escalateCount || 0));
    const lastAt = Number(item?.lastEscalateAt || 0);
    level = Math.max(level, count);
    if (Number.isFinite(lastAt) && lastAt > 0) {
      lastEscalateAt = Math.max(lastEscalateAt, lastAt);
    }

    const active = item?.isActive === true && String(item?.status || "").toLowerCase() !== "ok";
    if (!active) return;
    activeBindings += 1;
    if (acked) return;

    const afterSec = Math.max(0, Number(item?.escalateAfterSec || 0));
    if (afterSec <= 0) return;
    const intervalSec = Math.max(
      60,
      Number(item?.escalateIntervalSec || 0) || DEFAULT_NOTIFICATIONS.escalateIntervalSec
    );
    const maxTimes = Math.max(0, Number(item?.escalateMaxTimes || 0));
    if (maxTimes > 0 && count >= maxTimes) return;

    const firstActiveAt = Number(item?.firstActiveAt || item?.lastAlertAt || 0);
    if (!Number.isFinite(firstActiveAt) || firstActiveAt <= 0) return;
    let candidate = firstActiveAt + afterSec * 1000;
    if (count > 0 && Number.isFinite(lastAt) && lastAt > 0) {
      candidate = lastAt + intervalSec * 1000;
    }
    if (!Number.isFinite(candidate) || candidate <= 0) return;
    escalatableBindings += 1;
    if (!nextAt || candidate < nextAt) nextAt = candidate;
  });

  return {
    active: activeBindings > 0,
    level,
    activeBindings,
    escalatableBindings,
    nextAt: nextAt || null,
    lastEscalateAt: lastEscalateAt || null,
    acked: Boolean(acked),
    timestamp: nowIso(),
  };
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

function getBindingSilence(binding, target, severity, timestampMs = Date.now()) {
  const silences = Array.isArray(binding?.silences) ? binding.silences : [];
  for (const silence of silences) {
    if (!isSilenceWindowActive(silence, timestampMs)) continue;
    if (!shouldSilenceSeverity(silence, severity)) continue;
    if (!matchesTargetPatterns(target, silence.targets)) continue;
    return {
      silenced: true,
      name: silence.name || silence.id || "silence-window",
      endAt: silence.endAt || "",
    };
  }
  return { silenced: false, name: "", endAt: "" };
}

function renderMessageTemplate(template, variables) {
  const source = String(template || "");
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_matched, key) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

function formatAlertMessage(eventType, binding, target, analysis, previousSeverity, options = {}) {
  const channel = options?.channel || null;
  const titlePrefix =
    eventType === "recover"
      ? "[MonitorBoard][RECOVER]"
      : eventType === "test"
      ? "[MonitorBoard][TEST]"
      : eventType === "escalate"
      ? "[MonitorBoard][ESCALATE]"
      : "[MonitorBoard][ALERT]";
  const bindingLocale = normalizeMessageLocale(
    binding?.messageLocale,
    DEFAULT_NOTIFICATIONS.messageLocale
  );
  const bindingTemplates = normalizeMessageTemplates(binding?.messageTemplates, bindingLocale);
  const hasChannelLocaleOverride =
    channel?.messageLocale != null && String(channel.messageLocale || "").trim();
  const locale = normalizeMessageLocale(channel?.messageLocale, bindingLocale);
  const channelTemplateSource =
    channel?.messageTemplates &&
    typeof channel.messageTemplates === "object" &&
    !Array.isArray(channel.messageTemplates)
      ? channel.messageTemplates
      : {};
  const templates = normalizeMessageTemplates(
    hasChannelLocaleOverride
      ? {
          ...MESSAGE_TEMPLATE_PRESETS[locale],
          ...channelTemplateSource,
        }
      : channel?.messageTemplates
        ? {
            ...bindingTemplates,
            ...channelTemplateSource,
          }
        : bindingTemplates,
    locale
  );
  const metricsTitle = locale === "zh-CN" ? "指标" : "Metrics";
  const reasonsTitle = locale === "zh-CN" ? "原因" : "Reasons";
  const templateDefault = normalizeMessageTemplates(
    hasChannelLocaleOverride
      ? {
          ...MESSAGE_TEMPLATE_PRESETS[locale],
          ...channelTemplateSource,
        }
      : bindingTemplates,
    locale
  );
  const reasons = Array.isArray(analysis?.reasons) ? analysis.reasons : [];
  const reasonLines = reasons
    .map((item) => String(item?.text || "").trim())
    .filter(Boolean)
    .map((item) => `- ${item}`);
  if (!reasonLines.length && eventType === "test") {
    reasonLines.push(locale === "zh-CN" ? "- 手动测试通知" : "- Manual test notification");
  }
  if (!reasonLines.length) {
    reasonLines.push("-");
  }

  const metrics = analysis?.metrics && typeof analysis.metrics === "object" ? analysis.metrics : {};
  const metricLines = [];
  const cpu = metrics.cpu;
  const mem = metrics.mem;
  const disk = metrics.disk;
  const failedServices = metrics.failedServices;
  if (cpu != null) {
    metricLines.push(
      locale === "zh-CN" ? `- CPU: ${cpu.toFixed(1)}%` : `- CPU: ${cpu.toFixed(1)}%`
    );
  }
  if (mem != null) {
    metricLines.push(
      locale === "zh-CN" ? `- 内存: ${mem.toFixed(1)}%` : `- Memory: ${mem.toFixed(1)}%`
    );
  }
  if (disk != null) {
    metricLines.push(
      locale === "zh-CN" ? `- 磁盘: ${disk.toFixed(1)}%` : `- Disk: ${disk.toFixed(1)}%`
    );
  }
  if (failedServices != null) {
    metricLines.push(
      locale === "zh-CN"
        ? `- 故障服务数: ${failedServices}`
        : `- Failed Services: ${failedServices}`
    );
  }
  if (!metricLines.length) {
    metricLines.push("-");
  }

  const level = Number(options.escalationLevel || 0);
  const overdueMs = Number(options.overdueMs || 0);
  const variables = {
    titlePrefix,
    eventType: String(eventType || "alert"),
    bindingName: String(binding?.name || ""),
    targetName: String(target?.name || ""),
    targetUrl: String(target?.url || ""),
    severity: String(analysis?.severity || "unknown").toUpperCase(),
    previousSeverity: String(previousSeverity || "unknown").toUpperCase(),
    escalationLevel: String(level > 0 ? level : 1),
    unackedSec:
      Number.isFinite(overdueMs) && overdueMs > 0 ? String(Math.floor(overdueMs / 1000)) : "0",
    reasons: reasonLines.join("\n"),
    metrics: metricLines.join("\n"),
    timestamp: String(analysis?.timestamp || new Date().toISOString()),
  };
  const eventKey =
    eventType === "recover" || eventType === "test" || eventType === "escalate"
      ? eventType
      : "alert";
  const template = templates[eventKey] || templateDefault[eventKey] || templates.alert;
  const rendered = renderMessageTemplate(template, variables).trim();
  if (rendered) return rendered;

  const fallbackLines = [
    `${titlePrefix} ${variables.targetName}`,
    `Binding: ${variables.bindingName}`,
    `Target: ${variables.targetName}`,
    `URL: ${variables.targetUrl}`,
    `Severity: ${variables.severity}`,
    reasonsTitle + ":",
    variables.reasons,
    metricsTitle + ":",
    variables.metrics,
    `Time: ${variables.timestamp}`,
  ];
  return fallbackLines.join("\n");
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

async function dispatchMessage(binding, message, meta = {}, options = {}) {
  const messageBuilder =
    options && typeof options.messageBuilder === "function" ? options.messageBuilder : null;
  const fallbackMessage = String(message || "").trim();
  const results = [];
  for (const channel of binding.channels) {
    let channelMessage = fallbackMessage;
    if (messageBuilder) {
      channelMessage = String(messageBuilder(channel) || "").trim() || fallbackMessage;
    }
    if (!channelMessage) {
      channelMessage = "[MonitorBoard] empty message";
    }
    const sendResult = await sendToChannelWithRetry(channel, channelMessage);
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
        messagePreview: channelMessage.slice(0, 280),
        meta,
      });
    }
  }
  const successCount = results.filter((item) => item.ok).length;
  return { results, successCount };
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
      const dispatch = await dispatchMessage(job.binding, job.message, job.meta, job.options);
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

function enqueueDispatchMessage(binding, message, meta = {}, options = {}) {
  return new Promise((resolve) => {
    dispatchQueue.push({ binding, message, meta, options, resolve });
    runDispatchWorker();
  });
}

async function processBindingForTarget(binding, targetEntry, analysis) {
  const key = `${binding.id}::${targetEntry.url}`;
  const now = Date.now();
  const ack = ackStateByTarget.get(targetEntry.url);
  const acked = Boolean(ack?.acked);
  const previous =
    bindingStateByTarget.get(key) ||
    ({
      status: "ok",
      lastSeverity: "ok",
      reasonHash: "",
      lastAlertAt: 0,
      lastRecoverAt: 0,
      failCount: 0,
      recoverCount: 0,
      isActive: false,
      lastSilencedAt: 0,
      lastSilence: "",
      firstActiveAt: 0,
      lastEscalateAt: 0,
      escalateCount: 0,
      bindingName: binding.name,
      escalateAfterSec: Number(binding.escalateAfterSec || 0),
      escalateIntervalSec: Number(binding.escalateIntervalSec || 0),
      escalateMaxTimes: Number(binding.escalateMaxTimes || 0),
      escalateSeverities: Array.isArray(binding.escalateSeverities)
        ? binding.escalateSeverities
        : [],
    });
  previous.firstActiveAt = Number(previous.firstActiveAt || 0);
  previous.lastEscalateAt = Number(previous.lastEscalateAt || 0);
  previous.escalateCount = Number(previous.escalateCount || 0);
  previous.bindingName = String(binding.name || previous.bindingName || "");
  previous.escalateAfterSec = Math.max(0, Number(binding.escalateAfterSec || 0));
  previous.escalateIntervalSec = Math.max(0, Number(binding.escalateIntervalSec || 0));
  previous.escalateMaxTimes = Math.max(0, Number(binding.escalateMaxTimes || 0));
  previous.escalateSeverities = Array.isArray(binding.escalateSeverities)
    ? binding.escalateSeverities
    : [];

  const previousSeverity = previous.lastSeverity;
  const silence = getBindingSilence(binding, targetEntry, analysis.severity, now);
  if (silence.silenced) {
    previous.lastSilencedAt = now;
    previous.lastSilence = `${silence.name} until ${silence.endAt || "n/a"}`;
  } else {
    previous.lastSilence = "";
  }

  if (analysis.severity === "ok") {
    previous.failCount = 0;

    if (previous.isActive) {
      previous.recoverCount = Number(previous.recoverCount || 0) + 1;
      if (previous.recoverCount >= ALERT_DEBOUNCE_RECOVER_COUNT) {
        if (binding.notifyRecover && !silence.silenced && !acked) {
          const message = formatAlertMessage(
            "recover",
            binding,
            targetEntry,
            analysis,
            previousSeverity
          );
          const dispatch = await enqueueDispatchMessage(binding, message, {
            eventType: "recover",
            targetName: targetEntry.name,
            targetUrl: targetEntry.url,
            severity: analysis.severity,
          }, {
            messageBuilder: (channel) =>
              formatAlertMessage("recover", binding, targetEntry, analysis, previousSeverity, {
                channel,
              }),
          });
          if (dispatch.successCount > 0) previous.lastRecoverAt = now;
          previous.lastDispatch = dispatch;
        }
        previous.status = "ok";
        previous.lastSeverity = "ok";
        previous.reasonHash = "";
        previous.recoverCount = 0;
        previous.isActive = false;
        previous.firstActiveAt = 0;
        previous.lastEscalateAt = 0;
        previous.escalateCount = 0;
      }
    } else {
      previous.recoverCount = 0;
      previous.status = "ok";
      previous.lastSeverity = "ok";
      previous.reasonHash = "";
      previous.firstActiveAt = 0;
      previous.lastEscalateAt = 0;
      previous.escalateCount = 0;
    }

    setBindingState(key, previous);
    return;
  }

  previous.recoverCount = 0;
  previous.failCount = Number(previous.failCount || 0) + 1;

  if (!shouldNotifySeverity(binding, analysis.severity)) {
    previous.status = analysis.severity;
    previous.lastSeverity = analysis.severity;
    previous.reasonHash = analysis.reasonHash;
    setBindingState(key, previous);
    return;
  }

  const firstAlert = !previous.isActive && previous.failCount >= ALERT_DEBOUNCE_FAIL_COUNT;
  if (!previous.isActive && !firstAlert) {
    previous.status = analysis.severity;
    previous.lastSeverity = analysis.severity;
    previous.reasonHash = analysis.reasonHash;
    setBindingState(key, previous);
    return;
  }

  if (acked) {
    previous.isActive = false;
    previous.firstActiveAt = 0;
    previous.lastEscalateAt = 0;
    previous.escalateCount = 0;
    previous.status = analysis.severity;
    previous.lastSeverity = analysis.severity;
    previous.reasonHash = analysis.reasonHash;
    setBindingState(key, previous);
    return;
  }

  const severityEscalated =
    severityRank(analysis.severity) > severityRank(previous.lastSeverity || "ok");
  const reasonChanged = previous.reasonHash !== analysis.reasonHash;
  const cooldownMs = binding.cooldownSec * 1000;
  const remindMs = binding.remindIntervalSec * 1000;
  const cooldownPassed = now - (previous.lastAlertAt || 0) >= cooldownMs;
  const remindDue = remindMs > 0 && now - (previous.lastAlertAt || 0) >= remindMs;

  const shouldSend =
    firstAlert || severityEscalated || (reasonChanged && cooldownPassed) || remindDue;

  if (shouldSend && !silence.silenced) {
    const message = formatAlertMessage("alert", binding, targetEntry, analysis, previousSeverity);
    const dispatch = await enqueueDispatchMessage(binding, message, {
      eventType: "alert",
      targetName: targetEntry.name,
      targetUrl: targetEntry.url,
      severity: analysis.severity,
    }, {
      messageBuilder: (channel) =>
        formatAlertMessage("alert", binding, targetEntry, analysis, previousSeverity, {
          channel,
        }),
    });
    if (dispatch.successCount > 0) previous.lastAlertAt = now;
    previous.lastDispatch = dispatch;
  }

  if (firstAlert) {
    previous.isActive = !silence.silenced;
    if (previous.isActive) {
      previous.firstActiveAt = now;
      previous.lastEscalateAt = 0;
      previous.escalateCount = 0;
    }
  } else if (previous.isActive) {
    previous.isActive = true;
    if (!Number.isFinite(previous.firstActiveAt) || previous.firstActiveAt <= 0) {
      previous.firstActiveAt = Number(previous.lastAlertAt || now);
    }
  }

  const escalateAfterMs = Math.max(0, Number(binding.escalateAfterSec || 0)) * 1000;
  const escalateIntervalMs = Math.max(60, Number(binding.escalateIntervalSec || 0)) * 1000;
  const escalateMaxTimes = Math.max(0, Number(binding.escalateMaxTimes || 0));
  const shouldEscalate =
    previous.isActive &&
    !acked &&
    !silence.silenced &&
    escalateAfterMs > 0 &&
    shouldEscalateSeverity(binding, analysis.severity);

  if (shouldEscalate) {
    const activeSince = Number(previous.firstActiveAt || previous.lastAlertAt || now);
    const overdueMs = now - activeSince;
    const intervalPassed =
      previous.lastEscalateAt <= 0 || now - previous.lastEscalateAt >= escalateIntervalMs;
    const quotaAvailable =
      escalateMaxTimes <= 0 || Number(previous.escalateCount || 0) < escalateMaxTimes;
    if (overdueMs >= escalateAfterMs && intervalPassed && quotaAvailable) {
      const level = Number(previous.escalateCount || 0) + 1;
      const message = formatAlertMessage(
        "escalate",
        binding,
        targetEntry,
        analysis,
        previousSeverity,
        { escalationLevel: level, overdueMs }
      );
      const dispatch = await enqueueDispatchMessage(binding, message, {
        eventType: "escalate",
        targetName: targetEntry.name,
        targetUrl: targetEntry.url,
        severity: analysis.severity,
        escalationLevel: level,
        overdueMs,
      }, {
        messageBuilder: (channel) =>
          formatAlertMessage("escalate", binding, targetEntry, analysis, previousSeverity, {
            escalationLevel: level,
            overdueMs,
            channel,
          }),
      });
      if (dispatch.successCount > 0) {
        previous.lastEscalateAt = now;
        previous.escalateCount = level;
      }
      previous.lastDispatch = dispatch;
    }
  }
  previous.status = analysis.severity;
  previous.lastSeverity = analysis.severity;
  previous.reasonHash = analysis.reasonHash;
  setBindingState(key, previous);
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
    const statuses = await collectTargetStatusesShared(targets, { reason: "alert-loop" });

    for (const entry of statuses) {
      const analysis = analyzeTarget(entry, alerts);
      const ack = ackStateByTarget.get(entry.url) || null;
      setAlertState(entry.url, {
        name: entry.name,
        url: entry.url,
        severity: analysis.severity,
        summary: analysis.summary,
        reasons: analysis.reasons,
        metrics: analysis.metrics,
        ack: ack && ack.acked ? ack : null,
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
    logEvent("info", "alert_loop.disabled", { reason: "ALERT_LOOP_ENABLED=false" });
    return;
  }
  setTimeout(() => {
    runAlertCheck();
  }, 3000);
  setInterval(() => {
    runAlertCheck();
  }, Math.max(3000, ALERT_POLL_MS));
}

installProcessGuards();
initRbacState();
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
  alertPollMs: ALERT_POLL_MS,
  alertLoopEnabled: ALERT_LOOP_ENABLED,
  debounceFailCount: ALERT_DEBOUNCE_FAIL_COUNT,
  debounceRecoverCount: ALERT_DEBOUNCE_RECOVER_COUNT,
  notifyRetryCount: NOTIFY_RETRY_COUNT,
  notifyRetryBackoffMs: NOTIFY_RETRY_BACKOFF_MS,
  deadletterFile: DEADLETTER_FILE,
  auditLogFile: AUDIT_LOG_FILE,
  auditMaxRead: AUDIT_MAX_READ,
  collectionCacheTtlMs: COLLECTION_CACHE_TTL_MS,
  prometheusHistoryEnabled: PROMETHEUS_HISTORY_ENABLED,
  prometheusBaseUrl: PROMETHEUS_BASE_URL,
  prometheusQueryTimeoutMs: PROMETHEUS_QUERY_TIMEOUT_MS,
  prometheusTargetLabel: PROMETHEUS_TARGET_LABEL,
  statePersistEnabled: STATE_PERSIST_ENABLED,
  stateStoreBackend: stateStore.backend,
  stateDbFile: stateStore.dbFile,
  apiVersion: API_VERSION,
  apiPaginationMax: API_PAGINATION_MAX,
  configBackupDir: CONFIG_BACKUP_DIR,
  configBackupMax: CONFIG_BACKUP_MAX,
  rbacEnabled: rbacState.enabled,
  rbacRolesConfigured: rbacState.rolesConfigured,
  rbacErrors: rbacState.errors,
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/echarts", express.static(path.join(__dirname, "node_modules", "echarts", "dist")));
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
app.use("/api", authenticateApiRequest);

app.get("/healthz", (_req, res) => {
  const collectionCache = getCollectionCacheInfo();
  const historyStore = getHistoryStoreInfo();
  res.json({
    ok: true,
    service: "monitor-dashboard",
    alertLoopEnabled: ALERT_LOOP_ENABLED,
    statePersistEnabled: STATE_PERSIST_ENABLED,
    stateStoreBackend: stateStore.backend,
    rbacEnabled: rbacState.enabled,
    rbacRolesConfigured: rbacState.rolesConfigured,
    rbacErrors: rbacState.errors,
    auditLogFile: AUDIT_LOG_FILE,
    alertStateEntries: alertStateByTarget.size,
    bindingStateEntries: bindingStateByTarget.size,
    ackStateEntries: ackStateByTarget.size,
    dispatchQueueLength: dispatchQueue.length,
    collectionCache,
    historyStore,
    uptimeSec: Math.floor(process.uptime()),
    startedAt: new Date(STARTED_AT).toISOString(),
    timestamp: nowIso(),
  });
});

app.get("/readyz", (_req, res) => {
  try {
    if (STATE_PERSIST_ENABLED && !stateStore.enabled) {
      return res.status(503).json({
        ok: false,
        service: "monitor-dashboard",
        message: "state store not ready",
        stateStoreBackend: stateStore.backend,
        stateStoreReason: stateStore.reason,
        timestamp: nowIso(),
      });
    }
    if (rbacState.enabled && !rbacState.rolesConfigured.length) {
      return res.status(503).json({
        ok: false,
        service: "monitor-dashboard",
        message: "rbac enabled but no tokens configured",
        rbacErrors: rbacState.errors,
        timestamp: nowIso(),
      });
    }
    fs.accessSync(PUBLIC_DIR, fs.constants.R_OK);
    fs.accessSync(CONFIG_DIR, fs.constants.R_OK);
    const targets = loadTargets().map(normalizeTarget).filter(Boolean);
    const alerts = loadAlerts();
    const notifications = loadNotifications();
    const collectionCache = getCollectionCacheInfo();
    const historyStore = getHistoryStoreInfo();
    const invalidConfigs = Object.entries(configValidation)
      .filter(([, value]) => !value.ok)
      .map(([name, value]) => ({
        name,
        source: value.source,
        errors: value.errors,
      }));
    if (invalidConfigs.length) {
      return res.status(503).json({
        ok: false,
        service: "monitor-dashboard",
        message: "config validation failed",
        invalidConfigs,
        timestamp: nowIso(),
      });
    }
    res.json({
      ok: true,
      service: "monitor-dashboard",
      targets: targets.length,
      notificationsEnabled: notifications.enabled,
      notificationBindings: notifications.bindings.length,
      alertThresholdsLoaded: !!alerts,
      stateStoreBackend: stateStore.backend,
      stateDbFile: stateStore.dbFile,
      rbacEnabled: rbacState.enabled,
      rbacRolesConfigured: rbacState.rolesConfigured,
      collectionCache,
      historyStore,
      timestamp: nowIso(),
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      service: "monitor-dashboard",
      message: error?.message || "dashboard not ready",
      timestamp: nowIso(),
    });
  }
});

app.get("/api/auth/me", requireRole("readonly"), (req, res) => {
  return res.json({
    data: {
      role: req.auth?.role || "admin",
      rbacEnabled: rbacState.enabled,
      rolesConfigured: rbacState.rolesConfigured,
      apiVersion: req.apiVersion || "legacy",
    },
  });
});

app.get("/api/targets", requireRole("readonly"), (req, res) => {
  const targets = loadTargets().map(normalizeTarget).filter(Boolean).map((item) => ({
    name: item.name,
    url: item.url,
    metadata: item.metadata || {},
    tags: item.metadata || {},
  }));
  const paginationQuery = parsePaginationQuery(req.query, {
    defaultPageSize: Math.max(20, Math.min(200, targets.length || 50)),
    maxPageSize: API_PAGINATION_MAX,
  });
  const paged = buildPaginatedResponse(targets, paginationQuery);
  res.json({
    data: paged.items,
    count: paged.items.length,
    total: paged.pagination.total,
    pagination: paged.pagination,
  });
});

app.get("/api/settings", requireRole("readonly"), (_req, res) => {
  const targets = loadTargets();
  const normalizedTargets = targets.map(normalizeTarget).filter(Boolean);
  const alerts = loadAlerts();
  const notifications = loadNotifications();
  const targetMetadata = buildTargetMetadataSummary(normalizedTargets);
  const collectionCache = getCollectionCacheInfo();
  const historyStore = getHistoryStoreInfo();
  res.json({
    data: {
      alerts,
      debounce: {
        failCount: ALERT_DEBOUNCE_FAIL_COUNT,
        recoverCount: ALERT_DEBOUNCE_RECOVER_COUNT,
      },
      refreshOptionsMs: [5000, 10000, 30000, 60000],
      configValidation,
      configBackup: {
        dir: CONFIG_BACKUP_DIR,
        maxKeep: CONFIG_BACKUP_MAX,
      },
      rbac: {
        enabled: rbacState.enabled,
        rolesConfigured: rbacState.rolesConfigured,
      },
      audit: {
        logFile: AUDIT_LOG_FILE,
        maxRead: AUDIT_MAX_READ,
      },
      api: {
        defaultVersion: "legacy",
        supportedVersions: ["legacy", API_VERSION],
        paginationMax: API_PAGINATION_MAX,
        errorEnvelope: true,
      },
      collectionCache,
      history: historyStore,
      notifications: {
        enabled: notifications.enabled,
        bindingCount: notifications.bindings.length,
        targetCount: normalizedTargets.length,
        messageLocale: notifications.messageLocale,
        messageLocales: Object.keys(MESSAGE_TEMPLATE_PRESETS),
        messageTemplateKeys: MESSAGE_TEMPLATE_KEYS,
        messageTemplateVariables: MESSAGE_TEMPLATE_VARIABLES,
        channelTemplateOverride: true,
        escalation: {
          defaultAfterSec: notifications.escalateAfterSec,
          defaultIntervalSec: notifications.escalateIntervalSec,
          defaultMaxTimes: notifications.escalateMaxTimes,
          defaultSeverities: notifications.escalateSeverities,
        },
      },
      targetMetadata,
    },
  });
});

app.get("/api/history/summary", requireRole("readonly"), async (req, res) => {
  try {
    const data = await queryPrometheusHistorySummary({
      range: req.query?.range,
      step: req.query?.step,
      targets: req.query?.targets,
      endSec: req.query?.endSec,
    });
    return res.json({ data, history: getHistoryStoreInfo() });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 502;
    const message = error?.message || "history query failed";
    const history = getHistoryStoreInfo();
    return res.status(statusCode).json({
      message,
      history,
      error: {
        code: "HISTORY_QUERY_FAILED",
        message,
        details: {
          history,
        },
      },
    });
  }
});

app.get("/api/audit/logs", requireRole("admin"), (req, res) => {
  const paginationQuery = parsePaginationQuery(req.query, {
    defaultPageSize: 200,
    maxPageSize: AUDIT_MAX_READ,
  });
  const action = String(req.query?.action || "").trim();
  const data = readAuditEvents(paginationQuery.pageSize, action, paginationQuery.offset);
  const total = countAuditEvents(action);
  return res.json({
    data,
    count: data.length,
    total,
    pagination: {
      page: paginationQuery.page,
      pageSize: paginationQuery.pageSize,
      offset: paginationQuery.offset,
      total,
      totalPages: total ? Math.ceil(total / paginationQuery.pageSize) : 0,
    },
    action: action || "all",
    file: AUDIT_LOG_FILE,
  });
});

app.get("/api/audit/export", requireRole("admin"), (_req, res) => {
  if (!fs.existsSync(AUDIT_LOG_FILE)) {
    return sendApiError(res, 404, "AUDIT_LOG_NOT_FOUND", "audit log not found");
  }
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="dashboard-audit.jsonl"');
  return res.send(fs.readFileSync(AUDIT_LOG_FILE, "utf8"));
});

app.get("/api/config/backups", requireRole("admin"), (req, res) => {
  const type = String(req.query?.type || "").trim().toLowerCase();
  if (!type) {
    return sendApiError(
      res,
      400,
      "CONFIG_TYPE_REQUIRED",
      "type is required (targets/alerts/notifications)"
    );
  }
  const descriptor = getConfigTypeDescriptor(type);
  if (!descriptor) {
    return sendApiError(res, 404, "CONFIG_TYPE_UNSUPPORTED", "unsupported config type");
  }
  const data = listConfigBackups(descriptor.type).map((item) => ({
    file: item.file,
    updatedAt: item.updatedAt,
    size: item.size,
  }));
  const paginationQuery = parsePaginationQuery(req.query, {
    defaultPageSize: Math.max(20, Math.min(100, data.length || 20)),
    maxPageSize: Math.max(50, CONFIG_BACKUP_MAX),
  });
  const paged = buildPaginatedResponse(data, paginationQuery);
  return res.json({
    data: paged.items,
    count: paged.items.length,
    total: paged.pagination.total,
    pagination: paged.pagination,
    type: descriptor.type,
    backupDir: CONFIG_BACKUP_DIR,
    maxKeep: CONFIG_BACKUP_MAX,
  });
});

app.get("/api/config/:type", requireRole("admin"), (req, res) => {
  const type = String(req.params?.type || "").trim().toLowerCase();
  const descriptor = getConfigTypeDescriptor(type);
  if (!descriptor) {
    return sendApiError(res, 404, "CONFIG_TYPE_UNSUPPORTED", "unsupported config type");
  }
  const raw = loadRawConfigForEdit(descriptor.type);
  if (!raw) {
    return sendApiError(res, 500, "CONFIG_LOAD_FAILED", "failed to load config");
  }
  if (raw.blocked) {
    return sendApiError(
      res,
      raw.status || 409,
      "CONFIG_EDIT_BLOCKED",
      raw.message || "config edit is blocked",
      {
        type: descriptor.type,
        envName: configEnvOverrideName(descriptor.type),
      }
    );
  }
  const data = raw.data;
  const validation = descriptor.validate(data);
  return res.json({
    type: descriptor.type,
    data,
    source: configValidation[descriptor.type]?.source || "file",
    validation: {
      ok: validation.ok,
      errors: Array.isArray(validation.errors) ? validation.errors : [],
    },
    filePath: descriptor.filePath,
  });
});

app.post("/api/config/:type/validate", requireRole("admin"), (req, res) => {
  const type = String(req.params?.type || "").trim().toLowerCase();
  const descriptor = getConfigTypeDescriptor(type);
  if (!descriptor) {
    return sendApiError(res, 404, "CONFIG_TYPE_UNSUPPORTED", "unsupported config type");
  }
  const payload = getConfigPayload(req.body);
  const validation = descriptor.validate(payload);
  return res.json({
    type: descriptor.type,
    ok: validation.ok,
    errors: Array.isArray(validation.errors) ? validation.errors : [],
    envOverride: {
      active: isConfigEnvOverrideActive(descriptor.type),
      envName: configEnvOverrideName(descriptor.type) || null,
    },
  });
});

app.put("/api/config/:type", requireRole("admin"), (req, res) => {
  const type = String(req.params?.type || "").trim().toLowerCase();
  const payload = getConfigPayload(req.body);
  const result = writeConfigWithBackup(type, payload, "api-save");
  if (!result.ok) {
    writeAuditEvent(req, "config.update.failed", {
      type,
      message: result.message || "failed to save config",
      errors: Array.isArray(result.errors) ? result.errors : [],
    });
    return sendApiError(
      res,
      result.status || 500,
      "CONFIG_UPDATE_FAILED",
      result.message || "failed to save config",
      Array.isArray(result.errors) ? { errors: result.errors } : null
    );
  }
  writeAuditEvent(req, "config.update", {
    type: result.type,
    filePath: result.filePath,
    backupFile: result.backupFile || null,
  });
  return res.json({
    ok: true,
    type: result.type,
    filePath: result.filePath,
    backupFile: result.backupFile || null,
    validation: configValidation[result.type],
  });
});

app.post("/api/config/rollback", requireRole("admin"), (req, res) => {
  const type = String(req.body?.type || "").trim().toLowerCase();
  const backupFile = path.basename(String(req.body?.backupFile || "").trim());
  if (!type || !backupFile) {
    return sendApiError(res, 400, "CONFIG_ROLLBACK_PARAMS_REQUIRED", "type and backupFile are required");
  }

  const descriptor = getConfigTypeDescriptor(type);
  if (!descriptor) {
    return sendApiError(res, 404, "CONFIG_TYPE_UNSUPPORTED", "unsupported config type");
  }
  if (!backupFile.startsWith(`${descriptor.type}-`) || !backupFile.endsWith(".json")) {
    return sendApiError(res, 400, "CONFIG_BACKUP_FILE_INVALID", "invalid backup file name");
  }

  const backupPath = path.join(CONFIG_BACKUP_DIR, backupFile);
  if (!fs.existsSync(backupPath)) {
    return sendApiError(res, 404, "CONFIG_BACKUP_NOT_FOUND", "backup file not found");
  }

  try {
    const backupRaw = fs.readFileSync(backupPath, "utf8");
    const backupPayload = JSON.parse(backupRaw);
    const validation = descriptor.validate(backupPayload);
    if (!validation.ok) {
      return sendApiError(
        res,
        400,
        "CONFIG_BACKUP_INVALID",
        "backup config is invalid and cannot rollback",
        {
          errors: validation.errors,
        }
      );
    }

    ensureConfigDirs();
    const rollbackBackupFile = backupCurrentConfig(descriptor.type, descriptor.filePath, "rollback");
    fs.writeFileSync(descriptor.filePath, `${JSON.stringify(backupPayload, null, 2)}\n`, "utf8");
    descriptor.reload();
    logEvent("info", "config.rollback", {
      type: descriptor.type,
      fromBackup: backupFile,
      rollbackBackupFile: rollbackBackupFile || "",
    });
    writeAuditEvent(req, "config.rollback", {
      type: descriptor.type,
      fromBackup: backupFile,
      rollbackBackupFile: rollbackBackupFile || null,
    });
    return res.json({
      ok: true,
      type: descriptor.type,
      restoredFrom: backupFile,
      rollbackBackupFile: rollbackBackupFile || null,
      validation: configValidation[descriptor.type],
    });
  } catch (error) {
    writeAuditEvent(req, "config.rollback.failed", {
      type: descriptor.type,
      backupFile,
      message: error?.message || "rollback failed",
    });
    return sendApiError(res, 500, "CONFIG_ROLLBACK_FAILED", error?.message || "rollback failed");
  }
});

app.get("/api/targets/export", requireRole("admin"), (req, res) => {
  const includeToken = String(req.query?.includeToken || "").toLowerCase() === "true";
  const targets = loadTargets()
    .map(normalizeTarget)
    .filter(Boolean)
    .map((target) => ({
      name: target.name,
      url: target.url,
      token: includeToken ? target.token : undefined,
      env: target.metadata?.env || "",
      business: target.metadata?.business || "",
      room: target.metadata?.room || "",
      owner: target.metadata?.owner || "",
    }));
  const paginationQuery = parsePaginationQuery(req.query, {
    defaultPageSize: Math.max(20, Math.min(500, targets.length || 50)),
    maxPageSize: API_PAGINATION_MAX,
  });
  const paged = buildPaginatedResponse(targets, paginationQuery);
  return res.json({
    data: paged.items,
    count: paged.items.length,
    total: paged.pagination.total,
    pagination: paged.pagination,
    includeToken,
  });
});

app.post("/api/targets/import", requireRole("admin"), (req, res) => {
  const mode = String(req.body?.mode || "replace").trim().toLowerCase();
  if (!["replace", "merge"].includes(mode)) {
    return sendApiError(res, 400, "IMPORT_MODE_INVALID", "mode must be replace or merge");
  }
  const inputTargets = Array.isArray(req.body)
    ? req.body
    : Array.isArray(req.body?.targets)
      ? req.body.targets
      : null;
  if (!inputTargets) {
    return sendApiError(res, 400, "TARGETS_REQUIRED", "targets array is required");
  }
  const incomingValidation = validateTargetsConfig(inputTargets);
  if (!incomingValidation.ok) {
    return sendApiError(res, 400, "TARGETS_VALIDATION_FAILED", "targets validation failed", {
      errors: incomingValidation.errors,
    });
  }

  let nextTargets = inputTargets;
  if (mode === "merge") {
    const raw = loadRawConfigForEdit("targets");
    if (!raw || raw.blocked) {
      return sendApiError(
        res,
        raw?.status || 500,
        "TARGETS_LOAD_FAILED",
        raw?.message || "load targets failed"
      );
    }
    const existingTargets = Array.isArray(raw.data) ? raw.data : [];
    nextTargets = mergeTargetsByUrl(existingTargets, inputTargets);
  }

  const result = writeConfigWithBackup("targets", nextTargets, `bulk-import-${mode}`);
  if (!result.ok) {
    return sendApiError(
      res,
      result.status || 500,
      "TARGETS_IMPORT_FAILED",
      result.message || "targets import failed",
      Array.isArray(result.errors) ? { errors: result.errors } : null
    );
  }

  writeAuditEvent(req, "targets.bulk_import", {
    mode,
    importedCount: inputTargets.length,
    finalCount: nextTargets.length,
    backupFile: result.backupFile || null,
  });

  return res.json({
    ok: true,
    mode,
    importedCount: inputTargets.length,
    finalCount: nextTargets.length,
    backupFile: result.backupFile || null,
  });
});

app.patch("/api/targets/bulk/metadata", requireRole("admin"), (req, res) => {
  const patch = req.body?.patch && typeof req.body.patch === "object" ? req.body.patch : null;
  if (!patch) {
    return sendApiError(res, 400, "PATCH_REQUIRED", "patch object is required");
  }

  const patchValidation = {};
  TARGET_META_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) return;
    const value = patch[field];
    if (value != null && typeof value !== "string") patchValidation[field] = "must be string or empty";
  });
  if (Object.keys(patchValidation).length) {
    return sendApiError(res, 400, "PATCH_VALIDATION_FAILED", "patch validation failed", {
      errors: patchValidation,
    });
  }

  const targetUrls = parseStringList(req.body?.targetUrls || []);
  const targetNames = parseStringList(req.body?.targetNames || []);
  const urlSet = new Set(targetUrls.map((item) => item.toLowerCase()));
  const nameSet = new Set(targetNames.map((item) => item.toLowerCase()));

  const raw = loadRawConfigForEdit("targets");
  if (!raw || raw.blocked) {
    return sendApiError(
      res,
      raw?.status || 500,
      "TARGETS_LOAD_FAILED",
      raw?.message || "load targets failed"
    );
  }
  const currentTargets = Array.isArray(raw.data) ? raw.data : [];
  if (!currentTargets.length) {
    return sendApiError(res, 404, "TARGETS_NOT_FOUND", "no targets configured");
  }

  let matchedCount = 0;
  const nextTargets = currentTargets.map((item) => {
    const url = String(item?.url || "").trim().toLowerCase();
    const name = String(item?.name || "").trim().toLowerCase();
    const matched =
      (!urlSet.size && !nameSet.size) || urlSet.has(url) || (name && nameSet.has(name));
    if (!matched) return item;
    matchedCount += 1;
    return patchTargetMetadataItem(item, patch);
  });

  if (!matchedCount) {
    return sendApiError(res, 404, "TARGET_NOT_MATCHED", "no target matched selectors");
  }

  const result = writeConfigWithBackup("targets", nextTargets, "bulk-metadata-patch");
  if (!result.ok) {
    return sendApiError(
      res,
      result.status || 500,
      "TARGETS_PATCH_FAILED",
      result.message || "targets patch failed",
      Array.isArray(result.errors) ? { errors: result.errors } : null
    );
  }

  writeAuditEvent(req, "targets.bulk_patch_metadata", {
    matchedCount,
    selectors: {
      targetUrls,
      targetNames,
    },
    patch,
    backupFile: result.backupFile || null,
  });

  return res.json({
    ok: true,
    matchedCount,
    backupFile: result.backupFile || null,
  });
});

app.patch("/api/alerts/bulk-thresholds", requireRole("admin"), (req, res) => {
  const current = loadRawConfigForEdit("alerts");
  if (!current || current.blocked) {
    return sendApiError(
      res,
      current?.status || 500,
      "ALERTS_LOAD_FAILED",
      current?.message || "load alerts failed"
    );
  }
  const base = normalizeAlerts(current.data);
  const patch = req.body && typeof req.body === "object" ? req.body : {};
  const next = {
    ...base,
    cpu: patch.cpu ? { ...base.cpu, ...patch.cpu } : base.cpu,
    mem: patch.mem ? { ...base.mem, ...patch.mem } : base.mem,
    disk: patch.disk ? { ...base.disk, ...patch.disk } : base.disk,
    serviceFailedDanger:
      patch.serviceFailedDanger != null ? patch.serviceFailedDanger : base.serviceFailedDanger,
  };

  const result = writeConfigWithBackup("alerts", next, "bulk-thresholds-patch");
  if (!result.ok) {
    return sendApiError(
      res,
      result.status || 500,
      "ALERTS_PATCH_FAILED",
      result.message || "alerts patch failed",
      Array.isArray(result.errors) ? { errors: result.errors } : null
    );
  }
  writeAuditEvent(req, "alerts.bulk_thresholds_patch", {
    patch,
    backupFile: result.backupFile || null,
  });
  return res.json({
    ok: true,
    alerts: normalizeAlerts(next),
    backupFile: result.backupFile || null,
  });
});

app.patch("/api/notifications/bulk/targets", requireRole("admin"), (req, res) => {
  const mode = String(req.body?.mode || "replace").trim().toLowerCase();
  if (!["replace", "append", "remove"].includes(mode)) {
    return sendApiError(res, 400, "BULK_MODE_INVALID", "mode must be replace/append/remove");
  }
  const targets = parseStringList(req.body?.targets || []);
  if (mode !== "remove" && !targets.length) {
    return sendApiError(res, 400, "TARGETS_REQUIRED", "targets array is required");
  }

  const raw = loadRawConfigForEdit("notifications");
  if (!raw || raw.blocked) {
    return sendApiError(
      res,
      raw?.status || 500,
      "NOTIFICATIONS_LOAD_FAILED",
      raw?.message || "load notifications failed"
    );
  }
  const source = raw.data && typeof raw.data === "object" ? raw.data : DEFAULT_NOTIFICATIONS;
  const bindings = Array.isArray(source.bindings) ? source.bindings : [];
  if (!bindings.length) {
    return sendApiError(res, 404, "NOTIFICATION_BINDINGS_NOT_FOUND", "no notification bindings configured");
  }

  const bindingNames = parseStringList(req.body?.bindingNames || []);
  const nameSet = new Set(bindingNames.map((item) => item.toLowerCase()));

  let updatedBindings = 0;
  const nextBindings = bindings.map((binding) => {
    const name = String(binding?.name || "").trim();
    const matched = !nameSet.size || nameSet.has(name.toLowerCase());
    if (!matched) return binding;

    const currentTargets = parseStringList(Array.isArray(binding.targets) ? binding.targets : ["*"]);
    let nextTargets = currentTargets;
    if (mode === "replace") {
      nextTargets = targets.slice();
    } else if (mode === "append") {
      nextTargets = parseStringList(currentTargets.concat(targets));
    } else if (mode === "remove") {
      const removeSet = new Set(targets.map((item) => item.toLowerCase()));
      nextTargets = currentTargets.filter((item) => !removeSet.has(item.toLowerCase()));
    }
    if (!nextTargets.length) nextTargets = ["*"];
    updatedBindings += 1;
    return {
      ...binding,
      targets: nextTargets,
    };
  });

  if (!updatedBindings) {
    return sendApiError(
      res,
      404,
      "NOTIFICATION_BINDING_NOT_MATCHED",
      "no notification binding matched selectors"
    );
  }

  const nextNotifications = {
    ...source,
    bindings: nextBindings,
  };
  const result = writeConfigWithBackup("notifications", nextNotifications, `bulk-notify-targets-${mode}`);
  if (!result.ok) {
    return sendApiError(
      res,
      result.status || 500,
      "NOTIFICATIONS_PATCH_FAILED",
      result.message || "notifications patch failed",
      Array.isArray(result.errors) ? { errors: result.errors } : null
    );
  }

  writeAuditEvent(req, "notifications.bulk_targets_patch", {
    mode,
    updatedBindings,
    bindingNames,
    targets,
    backupFile: result.backupFile || null,
  });

  return res.json({
    ok: true,
    mode,
    updatedBindings,
    backupFile: result.backupFile || null,
  });
});

app.get("/api/targets/status", requireRole("readonly"), async (req, res) => {
  const targets = loadTargets().map(normalizeTarget).filter(Boolean);
  const paginationQuery = parsePaginationQuery(req.query, {
    defaultPageSize: Math.max(20, Math.min(200, targets.length || 50)),
    maxPageSize: API_PAGINATION_MAX,
  });
  if (!targets.length) {
    const emptyPage = buildPaginatedResponse([], paginationQuery);
    return res.json({
      data: emptyPage.items,
      count: 0,
      total: 0,
      pagination: emptyPage.pagination,
      cache: {
        ...getCollectionCacheInfo(),
        forceRefresh: false,
      },
    });
  }
  const refreshRaw = String(req.query?.refresh || "").trim().toLowerCase();
  const forceRefresh = refreshRaw === "1" || refreshRaw === "true" || refreshRaw === "yes";
  const data = await collectTargetStatusesShared(targets, {
    forceRefresh,
    reason: forceRefresh ? "api-refresh" : "api",
  });
  const paged = buildPaginatedResponse(data, paginationQuery);
  res.json({
    data: paged.items,
    count: paged.items.length,
    total: paged.pagination.total,
    pagination: paged.pagination,
    cache: {
      ...getCollectionCacheInfo(),
      forceRefresh,
    },
  });
});

app.post("/api/targets/diagnose", requireRole("operator"), async (req, res) => {
  const targetUrl = String(req.body?.targetUrl || "").trim();
  const targets = loadTargets().map(normalizeTarget).filter(Boolean);
  const selected = targetUrl ? targets.filter((item) => item.url === targetUrl) : targets;
  if (!selected.length) {
    return sendApiError(res, 404, "TARGET_NOT_FOUND", "target not found");
  }

  const data = await Promise.all(selected.map((item) => diagnoseTarget(item)));
  const paginationQuery = parsePaginationQuery(req.query, {
    defaultPageSize: Math.max(10, Math.min(100, data.length || 10)),
    maxPageSize: API_PAGINATION_MAX,
  });
  const paged = buildPaginatedResponse(data, paginationQuery);
  const summary = {
    total: paged.pagination.total,
    ok: data.filter((item) => item.ok).length,
    failed: data.filter((item) => !item.ok).length,
  };
  return res.json({
    data: paged.items,
    summary,
    pagination: paged.pagination,
  });
});

app.get("/api/alerts/state", requireRole("readonly"), (req, res) => {
  const data = Array.from(alertStateByTarget.values()).map((item) => {
    const ack = ackStateByTarget.get(item.url) || null;
    const acked = Boolean(ack && ack.acked);
    return {
      ...item,
      ack: acked ? ack : null,
      escalation: buildTargetEscalationSnapshot(item.url, acked),
    };
  });
  const paginationQuery = parsePaginationQuery(req.query, {
    defaultPageSize: Math.max(20, Math.min(200, data.length || 20)),
    maxPageSize: API_PAGINATION_MAX,
  });
  const paged = buildPaginatedResponse(data, paginationQuery);
  res.json({
    data: paged.items,
    count: paged.items.length,
    total: paged.pagination.total,
    pagination: paged.pagination,
  });
});

app.get("/api/alerts/acks", requireRole("readonly"), (req, res) => {
  const data = Array.from(ackStateByTarget.values())
    .filter((item) => item && item.acked)
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.ackedAt || 0) || 0;
      const tb = Date.parse(b.updatedAt || b.ackedAt || 0) || 0;
      return tb - ta;
    });
  const paginationQuery = parsePaginationQuery(req.query, {
    defaultPageSize: Math.max(20, Math.min(200, data.length || 20)),
    maxPageSize: API_PAGINATION_MAX,
  });
  const paged = buildPaginatedResponse(data, paginationQuery);
  res.json({
    data: paged.items,
    count: paged.items.length,
    total: paged.pagination.total,
    pagination: paged.pagination,
  });
});

app.post("/api/alerts/acks", requireRole("operator"), (req, res) => {
  const targetUrl = String(req.body?.targetUrl || "").trim();
  if (!targetUrl) {
    return sendApiError(res, 400, "TARGET_URL_REQUIRED", "targetUrl is required");
  }
  const targetName = String(req.body?.targetName || "").trim();
  const owner = String(req.body?.owner || "").trim();
  const note = String(req.body?.note || "").trim();
  const now = nowIso();
  const previous = ackStateByTarget.get(targetUrl);
  const next = {
    targetUrl,
    targetName: targetName || previous?.targetName || targetUrl,
    owner,
    note,
    acked: true,
    ackedAt: previous?.ackedAt || now,
    updatedAt: now,
  };
  setAckState(targetUrl, next);
  writeAuditEvent(req, "alerts.ack", {
    targetUrl,
    targetName: next.targetName,
    owner,
    note,
  });
  return res.json({ data: next });
});

app.post("/api/alerts/unack", requireRole("operator"), (req, res) => {
  const targetUrl = String(req.body?.targetUrl || "").trim();
  if (!targetUrl) {
    return sendApiError(res, 400, "TARGET_URL_REQUIRED", "targetUrl is required");
  }
  deleteAckState(targetUrl);
  writeAuditEvent(req, "alerts.unack", {
    targetUrl,
    source: "post",
  });
  return res.json({ ok: true, targetUrl });
});

app.delete("/api/alerts/acks", requireRole("operator"), (req, res) => {
  const fromQuery = String(req.query?.targetUrl || "").trim();
  const fromBody = String(req.body?.targetUrl || "").trim();
  const targetUrl = fromQuery || fromBody;
  if (!targetUrl) {
    return sendApiError(res, 400, "TARGET_URL_REQUIRED", "targetUrl is required");
  }
  deleteAckState(targetUrl);
  writeAuditEvent(req, "alerts.unack", {
    targetUrl,
    source: "delete",
  });
  return res.json({ ok: true, targetUrl });
});

app.post("/api/alerts/test", requireRole("operator"), async (req, res) => {
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
  const channelName = String(req.body?.channel || "").trim();
  const channelTypeRaw = String(req.body?.channelType || "").trim().toLowerCase();
  const allowedChannelTypes = ["wechat", "telegram", "dingtalk"];
  if (channelTypeRaw && !allowedChannelTypes.includes(channelTypeRaw)) {
    return sendApiError(res, 400, "CHANNEL_TYPE_INVALID", "channelType must be wechat/telegram/dingtalk");
  }
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
    return sendApiError(res, 404, "BINDING_NOT_FOUND", "binding not found");
  }

  const results = [];
  let matchedChannelCount = 0;
  for (const binding of selectedBindings) {
    const channels = Array.isArray(binding.channels) ? binding.channels : [];
    const filteredChannels = channels.filter((channel) => {
      const byName = !channelName || String(channel?.name || "").trim().toLowerCase() === channelName.toLowerCase();
      const byType = !channelTypeRaw || String(channel?.type || "").trim().toLowerCase() === channelTypeRaw;
      return byName && byType;
    });
    if (!filteredChannels.length) {
      continue;
    }
    matchedChannelCount += filteredChannels.length;
    const scopedBinding = {
      ...binding,
      channels: filteredChannels,
    };
    const message = formatAlertMessage("test", binding, targetEntry, analysis, "ok");
    const dispatch = await enqueueDispatchMessage(scopedBinding, message, {
      eventType: "test",
      targetName: targetEntry.name,
      targetUrl: targetEntry.url,
      severity: analysis.severity,
    }, {
      messageBuilder: (channel) =>
        formatAlertMessage("test", binding, targetEntry, analysis, "ok", {
          channel,
        }),
    });
    results.push({
      binding: binding.name,
      channelCount: filteredChannels.length,
      successCount: dispatch.successCount,
      results: dispatch.results,
    });
  }
  if (!matchedChannelCount) {
    return sendApiError(
      res,
      404,
      "CHANNEL_NOT_FOUND",
      "channel not found in selected bindings",
      {
        binding: bindingName || "*",
        channel: channelName || null,
        channelType: channelTypeRaw || null,
      }
    );
  }
  writeAuditEvent(req, "alerts.test", {
    binding: bindingName || "*",
    channel: channelName || "*",
    channelType: channelTypeRaw || null,
    matchedChannelCount,
    target: targetEntry.name,
    severity: analysis.severity,
    dispatchCount: results.length,
  });
  res.json({ data: results });
});

app.listen(PORT, () => {
  logEvent("info", "startup.ready", { listen: `http://0.0.0.0:${PORT}` });
  startAlertLoop();
});
