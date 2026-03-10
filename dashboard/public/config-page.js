function get(id) {
  return document.getElementById(id);
}

function cloneJson(input) {
  return JSON.parse(JSON.stringify(input));
}

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function splitList(input) {
  return String(input || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitAnyList(input) {
  if (Array.isArray(input)) return input.map((item) => String(item || "").trim()).filter(Boolean);
  return splitList(input);
}

function uniqueList(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).filter((item) => {
    const normalized = String(item || "").trim();
    if (!normalized) return false;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (["wechat", "telegram", "dingtalk"].includes(value)) return value;
  return "wechat";
}

function normalizeSeverityList(values, fallback) {
  const allowed = new Set(["warn", "danger", "offline", "all"]);
  const next = uniqueList(splitAnyList(values)).filter((item) => allowed.has(item));
  return next.length ? next : fallback.slice();
}

const MESSAGE_TEMPLATE_KEYS = ["alert", "recover", "escalate", "test"];
const MESSAGE_TEMPLATE_PRESETS = {
  "zh-CN": {
    alert:
      "{{titlePrefix}} {{targetName}}\n绑定: {{bindingName}}\n地址: {{targetUrl}}\n级别: {{severity}}\n原因:\n{{reasons}}\n指标:\n{{metrics}}\n时间: {{timestamp}}",
    recover:
      "{{titlePrefix}} {{targetName}}\n绑定: {{bindingName}}\n地址: {{targetUrl}}\n级别: {{severity}}\n恢复前级别: {{previousSeverity}}\n原因:\n{{reasons}}\n指标:\n{{metrics}}\n时间: {{timestamp}}",
    escalate:
      "{{titlePrefix}} {{targetName}}\n绑定: {{bindingName}}\n地址: {{targetUrl}}\n级别: {{severity}}\n升级等级: {{escalationLevel}}\n未确认时长: {{unackedSec}} 秒\n原因:\n{{reasons}}\n指标:\n{{metrics}}\n时间: {{timestamp}}",
    test:
      "{{titlePrefix}} {{targetName}}\n绑定: {{bindingName}}\n地址: {{targetUrl}}\n级别: {{severity}}\n原因:\n{{reasons}}\n指标:\n{{metrics}}\n时间: {{timestamp}}",
  },
  "en-US": {
    alert:
      "{{titlePrefix}} {{targetName}}\nBinding: {{bindingName}}\nURL: {{targetUrl}}\nSeverity: {{severity}}\nReasons:\n{{reasons}}\nMetrics:\n{{metrics}}\nTime: {{timestamp}}",
    recover:
      "{{titlePrefix}} {{targetName}}\nBinding: {{bindingName}}\nURL: {{targetUrl}}\nSeverity: {{severity}}\nRecovered From: {{previousSeverity}}\nReasons:\n{{reasons}}\nMetrics:\n{{metrics}}\nTime: {{timestamp}}",
    escalate:
      "{{titlePrefix}} {{targetName}}\nBinding: {{bindingName}}\nURL: {{targetUrl}}\nSeverity: {{severity}}\nEscalation Level: {{escalationLevel}}\nUnacked For: {{unackedSec}}s\nReasons:\n{{reasons}}\nMetrics:\n{{metrics}}\nTime: {{timestamp}}",
    test:
      "{{titlePrefix}} {{targetName}}\nBinding: {{bindingName}}\nURL: {{targetUrl}}\nSeverity: {{severity}}\nReasons:\n{{reasons}}\nMetrics:\n{{metrics}}\nTime: {{timestamp}}",
  },
};

function normalizeMessageLocale(input) {
  const locale = String(input || "").trim();
  if (Object.prototype.hasOwnProperty.call(MESSAGE_TEMPLATE_PRESETS, locale)) return locale;
  return "zh-CN";
}

function getTemplatePreset(locale) {
  const normalizedLocale = normalizeMessageLocale(locale);
  return MESSAGE_TEMPLATE_PRESETS[normalizedLocale] || MESSAGE_TEMPLATE_PRESETS["zh-CN"];
}

function normalizeMessageTemplates(input, locale) {
  const normalizedLocale = normalizeMessageLocale(locale);
  const preset = getTemplatePreset(normalizedLocale);
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const next = {};
  MESSAGE_TEMPLATE_KEYS.forEach((key) => {
    const value = String(source[key] || "").trim();
    next[key] = value || preset[key];
  });
  return next;
}

function sanitizeMessageTemplates(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const next = {};
  MESSAGE_TEMPLATE_KEYS.forEach((key) => {
    const value = String(source[key] || "").trim();
    if (value) next[key] = value;
  });
  return next;
}

function createDefaultChannel(type, index) {
  const channelType = normalizeType(type);
  const name = `${channelType}-${index + 1}`;
  if (channelType === "telegram") return { type: "telegram", name, botToken: "", chatId: "" };
  if (channelType === "dingtalk") return { type: "dingtalk", name, webhook: "", secret: "", atMobiles: [], isAtAll: false };
  return { type: "wechat", name, webhook: "", mentionedMobileList: [], mentionedList: [] };
}

function normalizeChannel(channel, index) {
  const source = channel && typeof channel === "object" ? channel : {};
  const type = normalizeType(source.type);
  const next = { ...source, type, name: String(source.name || "").trim() || `${type}-${index + 1}` };
  const hasMessageLocale = source.messageLocale != null && String(source.messageLocale || "").trim();
  const channelTemplates = sanitizeMessageTemplates(source.messageTemplates);
  if (hasMessageLocale) {
    next.messageLocale = normalizeMessageLocale(source.messageLocale);
  } else {
    delete next.messageLocale;
  }
  if (Object.keys(channelTemplates).length) {
    next.messageTemplates = channelTemplates;
  } else {
    delete next.messageTemplates;
  }
  if (type === "telegram") {
    next.botToken = String(source.botToken || "").trim();
    next.chatId = String(source.chatId || "").trim();
    if (source.topicId != null && String(source.topicId).trim()) next.topicId = String(source.topicId).trim();
    else delete next.topicId;
  } else if (type === "dingtalk") {
    next.webhook = String(source.webhook || "").trim();
    if (source.secret != null && String(source.secret).trim()) next.secret = String(source.secret).trim();
    else delete next.secret;
    next.atMobiles = uniqueList(splitAnyList(source.atMobiles));
    next.isAtAll = source.isAtAll === true;
  } else {
    next.webhook = String(source.webhook || "").trim();
    next.mentionedMobileList = uniqueList(splitAnyList(source.mentionedMobileList));
    next.mentionedList = uniqueList(splitAnyList(source.mentionedList));
  }
  return next;
}

function createDefaultBinding(index) {
  return {
    name: `binding-${index + 1}`,
    enabled: true,
    targets: ["*"],
    severities: ["danger", "offline"],
    notifyRecover: true,
    channels: [createDefaultChannel("wechat", 0)],
  };
}

function normalizeBinding(binding, index) {
  const source = binding && typeof binding === "object" ? binding : {};
  const channelsRaw = Array.isArray(source.channels) ? source.channels : [];
  const channels = (channelsRaw.length ? channelsRaw : [createDefaultChannel("wechat", 0)]).map((item, channelIndex) =>
    normalizeChannel(item, channelIndex)
  );
  const next = {
    ...source,
    name: String(source.name || "").trim() || `binding-${index + 1}`,
    enabled: source.enabled !== false,
    targets: uniqueList(splitAnyList(source.targets)).length ? uniqueList(splitAnyList(source.targets)) : ["*"],
    severities: normalizeSeverityList(source.severities, ["danger", "offline"]),
    notifyRecover: source.notifyRecover !== false,
    channels,
  };
  if (source.escalateAfterSec != null) next.escalateAfterSec = Math.max(0, Math.floor(Number(source.escalateAfterSec) || 0));
  else delete next.escalateAfterSec;
  if (source.escalateIntervalSec != null) next.escalateIntervalSec = Math.max(60, Math.floor(Number(source.escalateIntervalSec) || 0));
  else delete next.escalateIntervalSec;
  if (source.escalateMaxTimes != null) next.escalateMaxTimes = Math.max(0, Math.floor(Number(source.escalateMaxTimes) || 0));
  else delete next.escalateMaxTimes;
  if (source.escalateSeverities != null) next.escalateSeverities = normalizeSeverityList(source.escalateSeverities, ["danger", "offline"]);
  else delete next.escalateSeverities;
  return next;
}

function normalizeNotificationsConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  const bindingsRaw = Array.isArray(source.bindings) ? source.bindings : [];
  const bindings = (bindingsRaw.length ? bindingsRaw : [createDefaultBinding(0)]).map((item, index) => normalizeBinding(item, index));
  const messageLocale = normalizeMessageLocale(source.messageLocale);
  const messageTemplates = sanitizeMessageTemplates(source.messageTemplates);
  return {
    ...source,
    enabled: source.enabled !== false,
    cooldownSec: Math.max(0, Math.floor(Number(source.cooldownSec) || 0)),
    remindIntervalSec: Math.max(0, Math.floor(Number(source.remindIntervalSec) || 0)),
    messageLocale,
    messageTemplates,
    bindings,
  };
}

const editorState = {
  loaded: false,
  config: null,
  originalConfig: null,
  selectedBindingIndex: 0,
  selectedChannelIndex: 0,
  backups: [],
};
const TEMPLATE_PREVIEW_HISTORY_KEY = "monitor.templatePreviewHistory";
const TEMPLATE_PREVIEW_HISTORY_MAX = 20;
const CONFIG_GUIDE_MODE_KEY = "monitor.configGuideMode";
const CONFIG_GUIDE_STEP_KEY = "monitor.configGuideStep";
const templatePreviewState = {
  history: [],
};
const guideState = {
  mode: "novice",
  step: 1,
  showAdvanced: false,
  cards: [],
};
const GUIDE_STEP_CARD_INDEX = {
  1: 3,
  2: 4,
  3: 5,
  4: 6,
};
const GUIDE_STEP_LABEL = {
  1: "步骤 1：填写通知参数",
  2: "步骤 2：生成并检查 JSON",
  3: "步骤 3：发送测试通知",
  4: "步骤 4：查看接口结果",
};

function normalizeGuideMode(mode) {
  return String(mode || "").trim().toLowerCase() === "full" ? "full" : "novice";
}

function normalizeGuideStep(step) {
  const value = Math.floor(Number(step));
  if (Number.isFinite(value) && value >= 1 && value <= 4) return value;
  return 1;
}

function getGuideCards() {
  return Array.from(document.querySelectorAll(".config-wrap > .config-card")).filter(
    (card) => card.dataset.guideShell !== "true"
  );
}

function ensureGuideShell() {
  const wrap = document.querySelector(".config-wrap");
  if (!wrap) return null;
  const existed = document.getElementById("config-guide-shell");
  if (existed) return existed;
  const shell = document.createElement("section");
  shell.id = "config-guide-shell";
  shell.dataset.guideShell = "true";
  shell.className = "config-card guide-shell";
  shell.innerHTML = `
    <div class="config-title">小白引导模式</div>
    <div class="guide-toolbar">
      <button id="guide-mode-toggle" class="button" type="button">切换到完整模式</button>
      <button class="button guide-step-btn" type="button" data-guide-step="1">1. 填参数</button>
      <button class="button guide-step-btn" type="button" data-guide-step="2">2. 生成 JSON</button>
      <button class="button guide-step-btn" type="button" data-guide-step="3">3. 测试发送</button>
      <button class="button guide-step-btn" type="button" data-guide-step="4">4. 看结果</button>
      <button id="guide-advanced-toggle" class="button" type="button">显示高级功能</button>
    </div>
    <div id="guide-summary" class="guide-summary">-</div>
  `;
  wrap.insertBefore(shell, wrap.firstChild);
  return shell;
}

function setGuideMode(mode) {
  guideState.mode = normalizeGuideMode(mode);
  localStorage.setItem(CONFIG_GUIDE_MODE_KEY, guideState.mode);
}

function setGuideStep(step) {
  guideState.step = normalizeGuideStep(step);
  localStorage.setItem(CONFIG_GUIDE_STEP_KEY, String(guideState.step));
}

function renderGuideLayout() {
  const modeToggle = document.getElementById("guide-mode-toggle");
  const advancedToggle = document.getElementById("guide-advanced-toggle");
  const summary = document.getElementById("guide-summary");
  const stepButtons = Array.from(document.querySelectorAll(".guide-step-btn"));
  const showSet = new Set();
  if (guideState.mode === "full") {
    guideState.cards.forEach((_card, index) => showSet.add(index));
    guideState.showAdvanced = true;
  } else {
    showSet.add(0);
    showSet.add(GUIDE_STEP_CARD_INDEX[guideState.step]);
    if (guideState.showAdvanced) {
      showSet.add(1);
      showSet.add(2);
    }
  }
  guideState.cards.forEach((card, index) => {
    card.classList.toggle("guide-hidden", !showSet.has(index));
  });
  if (modeToggle) {
    modeToggle.textContent =
      guideState.mode === "full" ? "切换到小白模式" : "切换到完整模式";
  }
  if (advancedToggle) {
    advancedToggle.disabled = guideState.mode === "full";
    advancedToggle.textContent =
      guideState.mode === "full"
        ? "完整模式已显示高级功能"
        : guideState.showAdvanced
          ? "隐藏高级功能"
          : "显示高级功能";
  }
  stepButtons.forEach((button) => {
    const step = normalizeGuideStep(button.dataset.guideStep);
    const active = step === guideState.step;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "step" : "false");
  });
  if (summary) {
    if (guideState.mode === "full") {
      summary.textContent = "当前为完整模式：显示全部配置模块。";
    } else {
      const stepText = GUIDE_STEP_LABEL[guideState.step] || GUIDE_STEP_LABEL[1];
      const advancedText = guideState.showAdvanced
        ? "高级模块已展开。"
        : "高级模块已收起。";
      summary.textContent = `${stepText}。${advancedText}`;
    }
  }
}

function initGuideMode() {
  ensureGuideShell();
  guideState.cards = getGuideCards();
  setGuideMode(localStorage.getItem(CONFIG_GUIDE_MODE_KEY) || "novice");
  setGuideStep(localStorage.getItem(CONFIG_GUIDE_STEP_KEY) || "1");
  const modeToggle = document.getElementById("guide-mode-toggle");
  if (modeToggle) {
    modeToggle.addEventListener("click", () => {
      setGuideMode(guideState.mode === "full" ? "novice" : "full");
      renderGuideLayout();
    });
  }
  const advancedToggle = document.getElementById("guide-advanced-toggle");
  if (advancedToggle) {
    advancedToggle.addEventListener("click", () => {
      if (guideState.mode === "full") return;
      guideState.showAdvanced = !guideState.showAdvanced;
      renderGuideLayout();
    });
  }
  document.querySelectorAll(".guide-step-btn").forEach((button) => {
    button.addEventListener("click", () => {
      setGuideStep(button.dataset.guideStep);
      renderGuideLayout();
    });
  });
  renderGuideLayout();
}

function setEditorStatus(message, tone = "muted") {
  const el = get("editor-status");
  if (!el) return;
  el.textContent = String(message || "");
  if (tone === "ok") el.style.color = "var(--ok)";
  else if (tone === "error") el.style.color = "var(--danger)";
  else el.style.color = "var(--muted)";
}

function setPreviewOutput(text) {
  const el = get("preview-output");
  if (!el) return;
  el.textContent = String(text || "");
}

function setReleaseCheckOutput(text) {
  const el = get("release-check-output");
  if (!el) return;
  el.textContent = String(text || "");
}

function setBackupStatusOutput(text) {
  const el = get("backup-status-output");
  if (!el) return;
  el.textContent = String(text || "");
}

function setTemplateVarCopyStatus(text, tone = "muted") {
  const el = get("template-var-copy-status");
  if (!el) return;
  el.textContent = String(text || "");
  if (tone === "ok") el.style.color = "var(--ok)";
  else if (tone === "error") el.style.color = "var(--danger)";
  else el.style.color = "var(--muted)";
}

function setTemplateSnippetStatus(text, tone = "muted") {
  const el = get("template-snippet-status");
  if (!el) return;
  el.textContent = String(text || "");
  if (tone === "ok") el.style.color = "var(--ok)";
  else if (tone === "error") el.style.color = "var(--danger)";
  else el.style.color = "var(--muted)";
}

async function copyToClipboard(text) {
  const value = String(text || "");
  if (!value) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const temp = document.createElement("textarea");
  temp.value = value;
  temp.setAttribute("readonly", "readonly");
  temp.style.position = "absolute";
  temp.style.left = "-9999px";
  document.body.appendChild(temp);
  temp.select();
  document.execCommand("copy");
  document.body.removeChild(temp);
}

async function handleTemplateVarCopyClick(event) {
  const target = event.target.closest("[data-template-var]");
  if (!target) return;
  const variable = String(target.getAttribute("data-template-var") || "").trim();
  if (!variable) return;
  try {
    await copyToClipboard(variable);
    setTemplateVarCopyStatus(`已复制变量：${variable}`, "ok");
  } catch (error) {
    setTemplateVarCopyStatus(`复制失败：${error?.message || String(error)}`, "error");
  }
}

function loadTemplatePreviewHistory() {
  try {
    const raw = localStorage.getItem(TEMPLATE_PREVIEW_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        ts: String(item?.ts || "").trim(),
        meta: String(item?.meta || "").trim(),
        message: String(item?.message || "").trim(),
      }))
      .filter((item) => item.meta && item.message)
      .slice(0, TEMPLATE_PREVIEW_HISTORY_MAX);
  } catch (_error) {
    return [];
  }
}

function saveTemplatePreviewHistory() {
  try {
    localStorage.setItem(
      TEMPLATE_PREVIEW_HISTORY_KEY,
      JSON.stringify(templatePreviewState.history.slice(0, TEMPLATE_PREVIEW_HISTORY_MAX))
    );
  } catch (_error) {}
}

function renderTemplatePreviewHistory() {
  const el = get("template-preview-history");
  if (!el) return;
  if (!templatePreviewState.history.length) {
    el.textContent = "暂无预览历史";
    return;
  }
  el.textContent = templatePreviewState.history
    .map((item, index) => {
      const ts = item.ts || "-";
      return `${index + 1}. [${ts}] ${item.meta}\n${item.message}`;
    })
    .join("\n\n----------------\n\n");
}

function pushTemplatePreviewHistory(meta, message) {
  const normalizedMeta = String(meta || "").trim();
  const normalizedMessage = String(message || "").trim();
  if (!normalizedMeta || !normalizedMessage) return;
  const latest = templatePreviewState.history[0];
  if (latest && latest.meta === normalizedMeta && latest.message === normalizedMessage) return;
  templatePreviewState.history.unshift({
    ts: new Date().toLocaleString(),
    meta: normalizedMeta,
    message: normalizedMessage,
  });
  templatePreviewState.history = templatePreviewState.history.slice(0, TEMPLATE_PREVIEW_HISTORY_MAX);
  saveTemplatePreviewHistory();
  renderTemplatePreviewHistory();
}

function clearTemplatePreviewHistory() {
  templatePreviewState.history = [];
  saveTemplatePreviewHistory();
  renderTemplatePreviewHistory();
}

function getCurrentBinding() {
  const list = editorState.config?.bindings;
  if (!Array.isArray(list) || !list.length) return null;
  const index = Math.min(Math.max(editorState.selectedBindingIndex, 0), list.length - 1);
  editorState.selectedBindingIndex = index;
  return list[index];
}

function getCurrentChannel() {
  const binding = getCurrentBinding();
  const channels = Array.isArray(binding?.channels) ? binding.channels : [];
  if (!channels.length) return null;
  const index = Math.min(Math.max(editorState.selectedChannelIndex, 0), channels.length - 1);
  editorState.selectedChannelIndex = index;
  return channels[index];
}
function setCheckboxGroupValues(selector, values) {
  const valueSet = new Set((Array.isArray(values) ? values : []).map((item) => String(item)));
  document.querySelectorAll(selector).forEach((node) => {
    node.checked = valueSet.has(node.value);
  });
}

function getCheckedValues(selector, fallback) {
  const values = Array.from(document.querySelectorAll(selector + ":checked")).map((node) => node.value);
  return values.length ? values : fallback.slice();
}

function toggleFields() {
  const type = get("channel-type").value;
  get("wechat-fields").classList.toggle("hidden", type !== "wechat");
  get("telegram-fields").classList.toggle("hidden", type !== "telegram");
  get("dingtalk-fields").classList.toggle("hidden", type !== "dingtalk");
}

function toggleEscalationFields() {
  get("escalation-fields").classList.toggle("hidden", !get("escalate-enabled").checked);
}

function toggleTestScope() {
  const checked = document.querySelector("input[name='test-scope']:checked");
  const isAll = checked && checked.value === "all";
  get("test-binding-block").classList.toggle("hidden", isAll);
  if (isAll) get("test-binding").value = "";
}

function toggleTestChannelMode() {
  const mode = String(get("test-channel-mode").value || "all").trim().toLowerCase();
  const custom = mode === "custom";
  get("test-channel-custom-block").classList.toggle("hidden", !custom);
  if (!custom) {
    get("test-channel-name").value = "";
  }
}

function fillTemplateFields(locale, templates = {}) {
  const normalizedLocale = normalizeMessageLocale(locale);
  const normalizedTemplates = normalizeMessageTemplates(templates, normalizedLocale);
  get("message-locale").value = normalizedLocale;
  get("tpl-alert").value = String(templates.alert || "");
  get("tpl-recover").value = String(templates.recover || "");
  get("tpl-escalate").value = String(templates.escalate || "");
  get("tpl-test").value = String(templates.test || "");
  return normalizedTemplates;
}

function collectTemplateConfigFromForm() {
  const locale = normalizeMessageLocale(get("message-locale").value);
  const preset = getTemplatePreset(locale);
  const raw = {
    alert: get("tpl-alert").value.trim(),
    recover: get("tpl-recover").value.trim(),
    escalate: get("tpl-escalate").value.trim(),
    test: get("tpl-test").value.trim(),
  };
  const hasCustom = MESSAGE_TEMPLATE_KEYS.some((key) => raw[key]);
  const messageTemplates = {};
  if (hasCustom) {
    MESSAGE_TEMPLATE_KEYS.forEach((key) => {
      messageTemplates[key] = raw[key] || preset[key];
    });
  }
  return {
    messageLocale: locale,
    messageTemplates: hasCustom ? messageTemplates : {},
  };
}

function applyTemplatePresetToForm() {
  const locale = normalizeMessageLocale(get("message-locale").value);
  const preset = getTemplatePreset(locale);
  get("tpl-alert").value = preset.alert;
  get("tpl-recover").value = preset.recover;
  get("tpl-escalate").value = preset.escalate;
  get("tpl-test").value = preset.test;
}

function toggleChannelTemplateFields() {
  const enabled = get("channel-template-enabled").checked;
  get("channel-template-fields").classList.toggle("hidden", !enabled);
}

function fillChannelTemplateFields(channel, fallbackLocale = "zh-CN") {
  const hasLocale = channel?.messageLocale != null && String(channel.messageLocale).trim();
  const customTemplates = sanitizeMessageTemplates(channel?.messageTemplates);
  const enabled = Boolean(hasLocale || Object.keys(customTemplates).length);
  get("channel-template-enabled").checked = enabled;
  const locale = normalizeMessageLocale(
    enabled ? channel?.messageLocale : fallbackLocale
  );
  get("channel-message-locale").value = locale;
  get("channel-tpl-alert").value = String(customTemplates.alert || "");
  get("channel-tpl-recover").value = String(customTemplates.recover || "");
  get("channel-tpl-escalate").value = String(customTemplates.escalate || "");
  get("channel-tpl-test").value = String(customTemplates.test || "");
  toggleChannelTemplateFields();
}

function collectChannelTemplateConfigFromForm(fallbackLocale = "zh-CN") {
  const enabled = get("channel-template-enabled").checked;
  if (!enabled) {
    return {
      enabled: false,
      messageLocale: normalizeMessageLocale(fallbackLocale),
      messageTemplates: {},
    };
  }
  const locale = normalizeMessageLocale(get("channel-message-locale").value || fallbackLocale);
  const rawTemplates = {
    alert: get("channel-tpl-alert").value.trim(),
    recover: get("channel-tpl-recover").value.trim(),
    escalate: get("channel-tpl-escalate").value.trim(),
    test: get("channel-tpl-test").value.trim(),
  };
  return {
    enabled: true,
    messageLocale: locale,
    messageTemplates: sanitizeMessageTemplates(rawTemplates),
  };
}

function applyChannelTemplatePresetToForm() {
  const locale = normalizeMessageLocale(get("channel-message-locale").value);
  const preset = getTemplatePreset(locale);
  get("channel-tpl-alert").value = preset.alert;
  get("channel-tpl-recover").value = preset.recover;
  get("channel-tpl-escalate").value = preset.escalate;
  get("channel-tpl-test").value = preset.test;
}

function buildBindingTemplateSnippet() {
  const templateConfig = collectTemplateConfigFromForm();
  return {
    scope: "binding",
    messageLocale: templateConfig.messageLocale,
    messageTemplates: templateConfig.messageTemplates,
  };
}

function buildChannelTemplateSnippet() {
  const fallbackLocale = normalizeMessageLocale(get("message-locale").value);
  const channelConfig = collectChannelTemplateConfigFromForm(fallbackLocale);
  return {
    scope: "channel",
    channelName: String(get("channel-name").value || "").trim(),
    enabled: channelConfig.enabled,
    messageLocale: channelConfig.messageLocale,
    messageTemplates: channelConfig.messageTemplates,
  };
}

function exportTemplateSnippet(scope) {
  const snippet = scope === "channel" ? buildChannelTemplateSnippet() : buildBindingTemplateSnippet();
  get("template-snippet-json").value = JSON.stringify(snippet, null, 2);
  setTemplateSnippetStatus(`已导出 ${scope === "channel" ? "当前渠道" : "绑定"} 模板片段`, "ok");
}

function applyBindingTemplateSnippet(snippet) {
  const locale = normalizeMessageLocale(snippet.messageLocale || get("message-locale").value);
  const templates = sanitizeMessageTemplates(snippet.messageTemplates);
  fillTemplateFields(locale, templates);
}

function applyChannelTemplateSnippet(snippet) {
  const fallbackLocale = normalizeMessageLocale(get("message-locale").value);
  if (snippet.enabled === false) {
    get("channel-template-enabled").checked = false;
    fillChannelTemplateFields(null, fallbackLocale);
    return;
  }
  const locale = normalizeMessageLocale(snippet.messageLocale || fallbackLocale);
  const templates = sanitizeMessageTemplates(snippet.messageTemplates);
  fillChannelTemplateFields(
    {
      messageLocale: locale,
      messageTemplates: templates,
    },
    locale
  );
}

function importTemplateSnippet() {
  const raw = String(get("template-snippet-json").value || "").trim();
  if (!raw) {
    setTemplateSnippetStatus("请先粘贴模板片段 JSON", "error");
    return;
  }
  let snippet;
  try {
    snippet = JSON.parse(raw);
  } catch (error) {
    setTemplateSnippetStatus(`JSON 解析失败: ${error?.message || String(error)}`, "error");
    return;
  }
  if (!snippet || typeof snippet !== "object" || Array.isArray(snippet)) {
    setTemplateSnippetStatus("模板片段必须是 JSON 对象", "error");
    return;
  }
  const scope = String(snippet.scope || "").trim().toLowerCase();
  if (scope === "channel") {
    applyChannelTemplateSnippet(snippet);
    setTemplateSnippetStatus("已导入当前渠道模板片段", "ok");
  } else {
    applyBindingTemplateSnippet(snippet);
    setTemplateSnippetStatus("已导入绑定模板片段", "ok");
  }
  if (editorState.loaded) {
    applyFormToEditorSelection({ strict: false });
  }
  renderTemplatePreview();
}

function normalizePreviewEventType(input) {
  const value = String(input || "").trim().toLowerCase();
  if (["alert", "recover", "escalate", "test"].includes(value)) return value;
  return "alert";
}

function normalizePreviewSeverity(input) {
  const value = String(input || "").trim().toLowerCase();
  if (["ok", "warn", "danger", "offline"].includes(value)) return value;
  return "danger";
}

function renderTemplateText(template, variables) {
  const source = String(template || "");
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_matched, key) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

function buildTemplatePreviewContext() {
  const scope = String(get("template-preview-scope").value || "binding").trim().toLowerCase();
  const eventType = normalizePreviewEventType(get("template-preview-event").value);
  const bindingTemplate = collectTemplateConfigFromForm();
  const bindingLocale = normalizeMessageLocale(bindingTemplate.messageLocale);
  const bindingTemplates = normalizeMessageTemplates(
    bindingTemplate.messageTemplates,
    bindingLocale
  );

  if (scope !== "channel") {
    return {
      sourceLabel: "绑定默认模板",
      locale: bindingLocale,
      eventType,
      templates: bindingTemplates,
    };
  }

  const channelTemplate = collectChannelTemplateConfigFromForm(bindingLocale);
  if (!channelTemplate.enabled) {
    return {
      sourceLabel: "当前渠道模板（未启用，已回退绑定模板）",
      locale: bindingLocale,
      eventType,
      templates: bindingTemplates,
    };
  }
  const channelLocale = normalizeMessageLocale(channelTemplate.messageLocale);
  const channelTemplates = normalizeMessageTemplates(
    {
      ...getTemplatePreset(channelLocale),
      ...channelTemplate.messageTemplates,
    },
    channelLocale
  );
  return {
    sourceLabel: "当前渠道模板",
    locale: channelLocale,
    eventType,
    templates: channelTemplates,
  };
}

function parseOptionalNumber(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number;
}

function buildPreviewReasonLines(input, eventType, locale) {
  const reasons = String(input || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `- ${item}`);
  if (!reasons.length && eventType === "test") {
    reasons.push(locale === "zh-CN" ? "- 手动测试通知" : "- Manual test notification");
  }
  if (!reasons.length) reasons.push("-");
  return reasons;
}

function buildPreviewMetricLines(locale) {
  const lines = [];
  const cpu = parseOptionalNumber(get("template-preview-cpu").value);
  const mem = parseOptionalNumber(get("template-preview-mem").value);
  const disk = parseOptionalNumber(get("template-preview-disk").value);
  const failedServices = parseOptionalNumber(get("template-preview-failed-services").value);
  if (cpu != null) lines.push(`- CPU: ${cpu.toFixed(1)}%`);
  if (mem != null) lines.push(locale === "zh-CN" ? `- 内存: ${mem.toFixed(1)}%` : `- Memory: ${mem.toFixed(1)}%`);
  if (disk != null) lines.push(locale === "zh-CN" ? `- 磁盘: ${disk.toFixed(1)}%` : `- Disk: ${disk.toFixed(1)}%`);
  if (failedServices != null) {
    lines.push(
      locale === "zh-CN" ? `- 故障服务数: ${Math.floor(failedServices)}` : `- Failed Services: ${Math.floor(failedServices)}`
    );
  }
  if (!lines.length) lines.push("-");
  return lines;
}

function renderTemplatePreview(options = {}) {
  const recordHistory = options.recordHistory === true;
  const context = buildTemplatePreviewContext();
  const locale = context.locale;
  const eventType = context.eventType;
  const severity = normalizePreviewSeverity(get("template-preview-severity").value);
  const previousSeverity = normalizePreviewSeverity(get("template-preview-prev-severity").value);
  const escalationLevel = Math.max(1, Math.floor(Number(get("template-preview-level").value || 1) || 1));
  const unackedSec = Math.max(0, Math.floor(Number(get("template-preview-unacked-sec").value || 0) || 0));
  const targetName = String(get("template-preview-target").value || "").trim() || "preview-target";
  const targetUrl = String(get("template-preview-url").value || "").trim() || "http://127.0.0.1:9101";
  const bindingName = String(get("template-preview-binding").value || "").trim() || "ops-all";

  const titlePrefix =
    eventType === "recover"
      ? "[MonitorBoard][RECOVER]"
      : eventType === "test"
      ? "[MonitorBoard][TEST]"
      : eventType === "escalate"
      ? "[MonitorBoard][ESCALATE]"
      : "[MonitorBoard][ALERT]";
  const reasons = buildPreviewReasonLines(get("template-preview-reasons").value, eventType, locale);
  const metrics = buildPreviewMetricLines(locale);
  const variables = {
    titlePrefix,
    bindingName,
    targetName,
    targetUrl,
    severity: severity.toUpperCase(),
    previousSeverity: previousSeverity.toUpperCase(),
    escalationLevel: String(escalationLevel),
    unackedSec: String(unackedSec),
    reasons: reasons.join("\n"),
    metrics: metrics.join("\n"),
    timestamp: new Date().toISOString(),
  };
  const template = context.templates[eventType] || context.templates.alert;
  const rendered = renderTemplateText(template, variables).trim();
  const reasonsTitle = locale === "zh-CN" ? "原因" : "Reasons";
  const metricsTitle = locale === "zh-CN" ? "指标" : "Metrics";
  const fallback = [
    `${titlePrefix} ${targetName}`,
    `Binding: ${bindingName}`,
    `Target: ${targetName}`,
    `URL: ${targetUrl}`,
    `Severity: ${String(variables.severity)}`,
    `${reasonsTitle}:`,
    variables.reasons,
    `${metricsTitle}:`,
    variables.metrics,
    `Time: ${variables.timestamp}`,
  ].join("\n");
  const output = rendered || fallback;
  const meta = `来源: ${context.sourceLabel} | 语言: ${locale} | 事件: ${eventType}`;
  get("template-preview-output").value = output;
  get("template-preview-meta").textContent = meta;
  if (recordHistory) {
    pushTemplatePreviewHistory(meta, output);
  }
}

function renderBindingSelect() {
  const select = get("editor-binding-select");
  if (!select) return;
  if (!editorState.loaded || !editorState.config?.bindings?.length) {
    select.innerHTML = '<option value="0">未加载</option>';
    select.disabled = true;
    return;
  }
  select.innerHTML = editorState.config.bindings
    .map((item, index) => `<option value="${index}">${index + 1}. ${escapeHtml(item?.name || `binding-${index + 1}`)}</option>`)
    .join("");
  select.value = String(editorState.selectedBindingIndex);
  select.disabled = false;
}

function renderChannelSelect() {
  const select = get("editor-channel-select");
  if (!select) return;
  const binding = getCurrentBinding();
  const channels = Array.isArray(binding?.channels) ? binding.channels : [];
  if (!editorState.loaded || !channels.length) {
    select.innerHTML = '<option value="0">未加载</option>';
    select.disabled = true;
    return;
  }
  select.innerHTML = channels
    .map((item, index) => `<option value="${index}">${index + 1}. ${escapeHtml(item?.type || "channel")} / ${escapeHtml(item?.name || "-")}</option>`)
    .join("");
  select.value = String(editorState.selectedChannelIndex);
  select.disabled = false;
}

function syncEditorButtons() {
  const loaded = editorState.loaded;
  const bindingCount = Array.isArray(editorState.config?.bindings) ? editorState.config.bindings.length : 0;
  const channelCount = Array.isArray(getCurrentBinding()?.channels) ? getCurrentBinding().channels.length : 0;
  get("editor-binding-add-btn").disabled = !loaded;
  get("editor-binding-delete-btn").disabled = !loaded || bindingCount <= 1;
  get("editor-channel-add-btn").disabled = !loaded;
  get("editor-channel-delete-btn").disabled = !loaded || channelCount <= 1;
}

function syncEditorUI() {
  renderBindingSelect();
  renderChannelSelect();
  syncEditorButtons();
}

function renderBackupSelect() {
  const select = get("rollback-backup-select");
  if (!select) return;
  const items = Array.isArray(editorState.backups) ? editorState.backups : [];
  if (!items.length) {
    select.innerHTML = '<option value="">无可用备份</option>';
    select.disabled = true;
    return;
  }
  select.innerHTML = items
    .map((item) => {
      const file = String(item?.file || "").trim();
      const updatedAt = String(item?.updatedAt || "").trim();
      const label = updatedAt ? `${file} (${updatedAt})` : file;
      return `<option value="${escapeHtml(file)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  select.disabled = false;
}

function fillFormFromEditorSelection() {
  const config = editorState.config;
  const binding = getCurrentBinding();
  const channel = getCurrentChannel();
  if (!config || !binding || !channel) return;
  get("cooldown-sec").value = String(config.cooldownSec || 0);
  get("remind-sec").value = String(config.remindIntervalSec || 0);
  fillTemplateFields(config.messageLocale || "zh-CN", config.messageTemplates || {});
  get("binding-name").value = String(binding.name || "");
  get("targets").value = Array.isArray(binding.targets) && binding.targets.length ? binding.targets.join(",") : "*";
  get("notify-recover").checked = binding.notifyRecover !== false;
  setCheckboxGroupValues(".sev", normalizeSeverityList(binding.severities, ["danger", "offline"]));
  const hasEscalation = binding.escalateAfterSec != null && Number(binding.escalateAfterSec) > 0;
  get("escalate-enabled").checked = hasEscalation;
  get("escalate-after-sec").value = String(hasEscalation ? binding.escalateAfterSec : 1800);
  get("escalate-interval-sec").value = String(binding.escalateIntervalSec != null ? binding.escalateIntervalSec : 1800);
  get("escalate-max-times").value = String(binding.escalateMaxTimes != null ? binding.escalateMaxTimes : 3);
  setCheckboxGroupValues(".sev-escalate", normalizeSeverityList(binding.escalateSeverities, ["danger", "offline"]));
  toggleEscalationFields();
  const type = normalizeType(channel.type);
  get("channel-type").value = type;
  get("channel-name").value = String(channel.name || "");
  get("wechat-webhook").value = String(channel.webhook || "");
  get("wechat-mobiles").value = splitAnyList(channel.mentionedMobileList).join(",");
  get("wechat-users").value = splitAnyList(channel.mentionedList).join(",");
  get("tg-token").value = String(channel.botToken || "");
  get("tg-chat-id").value = String(channel.chatId || "");
  get("tg-topic-id").value = String(channel.topicId || "");
  get("dt-webhook").value = String(channel.webhook || "");
  get("dt-secret").value = String(channel.secret || "");
  get("dt-mobiles").value = splitAnyList(channel.atMobiles).join(",");
  get("dt-at-all").checked = channel.isAtAll === true;
  fillChannelTemplateFields(channel, config.messageLocale || "zh-CN");
  get("template-preview-binding").value = String(binding.name || "ops-all");
  toggleFields();
  renderTemplatePreview();
}

function applyFormToEditorSelection(options = {}) {
  const strict = options.strict === true;
  if (!editorState.loaded || !editorState.config) return;
  const config = editorState.config;
  const binding = getCurrentBinding();
  const channel = getCurrentChannel();
  if (!binding || !channel) return;
  config.cooldownSec = Math.max(0, Math.floor(Number(get("cooldown-sec").value || 0)));
  config.remindIntervalSec = Math.max(0, Math.floor(Number(get("remind-sec").value || 0)));
  const templateConfig = collectTemplateConfigFromForm();
  config.messageLocale = templateConfig.messageLocale;
  if (Object.keys(templateConfig.messageTemplates).length) {
    config.messageTemplates = templateConfig.messageTemplates;
  } else {
    delete config.messageTemplates;
  }
  binding.name = get("binding-name").value.trim() || `binding-${editorState.selectedBindingIndex + 1}`;
  const targets = uniqueList(splitList(get("targets").value));
  binding.targets = targets.length ? targets : ["*"];
  binding.notifyRecover = get("notify-recover").checked;
  binding.severities = getCheckedValues(".sev", ["danger", "offline"]);
  if (get("escalate-enabled").checked) {
    const afterSec = Math.floor(Number(get("escalate-after-sec").value || 0));
    const intervalSec = Math.floor(Number(get("escalate-interval-sec").value || 0));
    const maxTimes = Math.floor(Number(get("escalate-max-times").value || 0));
    if (strict && afterSec <= 0) throw new Error("启用升级通知时，首次升级等待秒数必须大于 0");
    if (strict && intervalSec < 60) throw new Error("启用升级通知时，升级间隔秒数不能小于 60");
    if (strict && maxTimes < 0) throw new Error("最大升级次数不能小于 0");
    binding.escalateAfterSec = Math.max(1, afterSec || 1800);
    binding.escalateIntervalSec = Math.max(60, intervalSec || 1800);
    binding.escalateMaxTimes = Math.max(0, maxTimes || 0);
    binding.escalateSeverities = getCheckedValues(".sev-escalate", ["danger", "offline"]);
  } else {
    delete binding.escalateAfterSec;
    delete binding.escalateIntervalSec;
    delete binding.escalateMaxTimes;
    delete binding.escalateSeverities;
  }
  const type = normalizeType(get("channel-type").value);
  const name = get("channel-name").value.trim() || `${type}-${editorState.selectedChannelIndex + 1}`;
  const nextChannel = { ...channel, type, name };
  if (type === "wechat") {
    const webhook = get("wechat-webhook").value.trim();
    if (strict && !webhook) throw new Error("企业微信 webhook 不能为空");
    nextChannel.webhook = webhook;
    nextChannel.mentionedMobileList = uniqueList(splitList(get("wechat-mobiles").value));
    nextChannel.mentionedList = uniqueList(splitList(get("wechat-users").value));
    delete nextChannel.botToken; delete nextChannel.chatId; delete nextChannel.topicId; delete nextChannel.secret; delete nextChannel.atMobiles; delete nextChannel.isAtAll;
  } else if (type === "telegram") {
    const botToken = get("tg-token").value.trim();
    const chatId = get("tg-chat-id").value.trim();
    if (strict && (!botToken || !chatId)) throw new Error("Telegram botToken/chatId 不能为空");
    nextChannel.botToken = botToken;
    nextChannel.chatId = chatId;
    const topicId = get("tg-topic-id").value.trim();
    if (topicId) nextChannel.topicId = topicId; else delete nextChannel.topicId;
    delete nextChannel.webhook; delete nextChannel.mentionedMobileList; delete nextChannel.mentionedList; delete nextChannel.secret; delete nextChannel.atMobiles; delete nextChannel.isAtAll;
  } else {
    const webhook = get("dt-webhook").value.trim();
    if (strict && !webhook) throw new Error("钉钉 webhook 不能为空");
    nextChannel.webhook = webhook;
    const secret = get("dt-secret").value.trim();
    if (secret) nextChannel.secret = secret; else delete nextChannel.secret;
    nextChannel.atMobiles = uniqueList(splitList(get("dt-mobiles").value));
    nextChannel.isAtAll = get("dt-at-all").checked;
    delete nextChannel.botToken; delete nextChannel.chatId; delete nextChannel.topicId; delete nextChannel.mentionedMobileList; delete nextChannel.mentionedList;
  }
  const channelTemplateConfig = collectChannelTemplateConfigFromForm(config.messageLocale || "zh-CN");
  if (channelTemplateConfig.enabled) {
    nextChannel.messageLocale = channelTemplateConfig.messageLocale;
    if (Object.keys(channelTemplateConfig.messageTemplates).length) {
      nextChannel.messageTemplates = channelTemplateConfig.messageTemplates;
    } else {
      delete nextChannel.messageTemplates;
    }
  } else {
    delete nextChannel.messageLocale;
    delete nextChannel.messageTemplates;
  }
  const channels = Array.isArray(binding.channels) ? binding.channels : [];
  channels[editorState.selectedChannelIndex] = nextChannel;
  binding.channels = channels;
}
function buildSingleBindingJsonFromForm() {
  const templateConfig = collectTemplateConfigFromForm();
  const type = normalizeType(get("channel-type").value);
  const name = get("channel-name").value.trim() || "ops-channel";
  let channel = null;
  if (type === "wechat") {
    const webhook = get("wechat-webhook").value.trim();
    if (!webhook) throw new Error("企业微信 webhook 不能为空");
    channel = { type: "wechat", name, webhook, mentionedMobileList: uniqueList(splitList(get("wechat-mobiles").value)), mentionedList: uniqueList(splitList(get("wechat-users").value)) };
  } else if (type === "telegram") {
    const botToken = get("tg-token").value.trim();
    const chatId = get("tg-chat-id").value.trim();
    if (!botToken || !chatId) throw new Error("Telegram botToken/chatId 不能为空");
    const topicId = get("tg-topic-id").value.trim();
    channel = { type: "telegram", name, botToken, chatId, ...(topicId ? { topicId } : {}) };
  } else {
    const webhook = get("dt-webhook").value.trim();
    if (!webhook) throw new Error("钉钉 webhook 不能为空");
    const secret = get("dt-secret").value.trim();
    channel = { type: "dingtalk", name, webhook, ...(secret ? { secret } : {}), atMobiles: uniqueList(splitList(get("dt-mobiles").value)), isAtAll: get("dt-at-all").checked };
  }
  const channelTemplateConfig = collectChannelTemplateConfigFromForm(templateConfig.messageLocale);
  if (channelTemplateConfig.enabled) {
    channel.messageLocale = channelTemplateConfig.messageLocale;
    if (Object.keys(channelTemplateConfig.messageTemplates).length) {
      channel.messageTemplates = channelTemplateConfig.messageTemplates;
    }
  }
  const binding = {
    name: get("binding-name").value.trim() || "ops-all",
    enabled: true,
    targets: uniqueList(splitList(get("targets").value)).length ? uniqueList(splitList(get("targets").value)) : ["*"],
    severities: getCheckedValues(".sev", ["danger", "offline"]),
    notifyRecover: get("notify-recover").checked,
    channels: [channel],
  };
  if (get("escalate-enabled").checked) {
    const afterSec = Math.floor(Number(get("escalate-after-sec").value || 0));
    const intervalSec = Math.floor(Number(get("escalate-interval-sec").value || 0));
    const maxTimes = Math.floor(Number(get("escalate-max-times").value || 0));
    if (afterSec <= 0) throw new Error("启用升级通知时，首次升级等待秒数必须大于 0");
    if (intervalSec < 60) throw new Error("启用升级通知时，升级间隔秒数不能小于 60");
    if (maxTimes < 0) throw new Error("最大升级次数不能小于 0");
    binding.escalateAfterSec = afterSec;
    binding.escalateIntervalSec = intervalSec;
    binding.escalateMaxTimes = maxTimes;
    binding.escalateSeverities = getCheckedValues(".sev-escalate", ["danger", "offline"]);
  }
  return {
    enabled: true,
    cooldownSec: Math.max(0, Math.floor(Number(get("cooldown-sec").value || 0))),
    remindIntervalSec: Math.max(0, Math.floor(Number(get("remind-sec").value || 0))),
    messageLocale: templateConfig.messageLocale,
    ...(Object.keys(templateConfig.messageTemplates).length
      ? { messageTemplates: templateConfig.messageTemplates }
      : {}),
    bindings: [binding],
  };
}

function buildDraftConfig(options = {}) {
  const strict = options.strict !== false;
  if (editorState.loaded && editorState.config) {
    applyFormToEditorSelection({ strict });
    return normalizeNotificationsConfig(cloneJson(editorState.config));
  }
  return normalizeNotificationsConfig(buildSingleBindingJsonFromForm());
}

function showJson() {
  get("json-output").value = JSON.stringify(buildDraftConfig({ strict: true }), null, 2);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function diffJsonValues(before, after, basePath = "") {
  const changes = [];
  if (Array.isArray(before) || Array.isArray(after)) {
    const left = Array.isArray(before) ? before : [];
    const right = Array.isArray(after) ? after : [];
    if (JSON.stringify(left) !== JSON.stringify(right)) changes.push({ path: basePath || "$", op: "replace", before, after });
    return changes;
  }
  if (isPlainObject(before) || isPlainObject(after)) {
    const left = isPlainObject(before) ? before : {};
    const right = isPlainObject(after) ? after : {};
    const keys = Array.from(new Set(Object.keys(left).concat(Object.keys(right)))).sort();
    keys.forEach((key) => {
      const path = basePath ? `${basePath}.${key}` : key;
      const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
      const hasRight = Object.prototype.hasOwnProperty.call(right, key);
      if (!hasLeft && hasRight) changes.push({ path, op: "add", before: undefined, after: right[key] });
      else if (hasLeft && !hasRight) changes.push({ path, op: "remove", before: left[key], after: undefined });
      else changes.push(...diffJsonValues(left[key], right[key], path));
    });
    return changes;
  }
  if (before !== after) changes.push({ path: basePath || "$", op: "replace", before, after });
  return changes;
}

function formatDiffSummary(changes) {
  if (!changes.length) return "未检测到变更";
  const lines = changes.slice(0, 80).map((item) => {
    const before = item.before === undefined ? "-" : typeof item.before === "string" ? item.before : JSON.stringify(item.before);
    const after = item.after === undefined ? "-" : typeof item.after === "string" ? item.after : JSON.stringify(item.after);
    return `[${item.op.toUpperCase()}] ${item.path}\n  before: ${before}\n  after:  ${after}`;
  });
  if (changes.length > 80) lines.push(`... 其余 ${changes.length - 80} 项未展开`);
  return `检测到 ${changes.length} 项变更\n\n${lines.join("\n")}`;
}

async function loadExistingConfig() {
  const result = get("result");
  setEditorStatus("正在加载...", "muted");
  try {
    const res = await fetch("/api/config/notifications");
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = payload?.error?.message || payload?.message || `加载失败 (HTTP ${res.status})`;
      setEditorStatus(message, "error");
      result.textContent = JSON.stringify({ ok: false, status: res.status, data: payload }, null, 2);
      setPreviewOutput("变更预览：尚未生成");
      return;
    }
    editorState.config = normalizeNotificationsConfig(payload?.data || {});
    editorState.originalConfig = cloneJson(editorState.config);
    editorState.loaded = true;
    editorState.selectedBindingIndex = 0;
    editorState.selectedChannelIndex = 0;
    syncEditorUI();
    fillFormFromEditorSelection();
    get("json-output").value = JSON.stringify(editorState.config, null, 2);
    setPreviewOutput("变更预览：尚未生成");
    setEditorStatus(`已加载：${editorState.config.bindings.length} 个绑定`, "ok");
    loadBackups();
  } catch (error) {
    setEditorStatus(`加载失败: ${error?.message || String(error)}`, "error");
  }
}

async function saveConfigToServer() {
  const result = get("result");
  try {
    const payload = buildDraftConfig({ strict: true });
    if (!editorState.loaded) {
      editorState.config = cloneJson(payload);
      editorState.loaded = true;
      editorState.selectedBindingIndex = 0;
      editorState.selectedChannelIndex = 0;
      syncEditorUI();
    }
    setEditorStatus("正在保存...", "muted");
    const res = await fetch("/api/config/notifications", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: payload }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || data?.message || `保存失败 (HTTP ${res.status})`;
      setEditorStatus(message, "error");
      result.textContent = JSON.stringify({ ok: false, status: res.status, data }, null, 2);
      return;
    }
    editorState.config = cloneJson(payload);
    editorState.originalConfig = cloneJson(payload);
    get("json-output").value = JSON.stringify(payload, null, 2);
    setPreviewOutput("变更预览：尚未生成");
    setEditorStatus("保存成功", "ok");
    result.textContent = JSON.stringify({ ok: true, status: res.status, data }, null, 2);
  } catch (error) {
    setEditorStatus(`保存失败: ${error?.message || String(error)}`, "error");
  }
}

function previewConfigDiff() {
  try {
    const draft = buildDraftConfig({ strict: true });
    const changes = diffJsonValues(editorState.originalConfig || {}, draft);
    setPreviewOutput(formatDiffSummary(changes));
    get("json-output").value = JSON.stringify(draft, null, 2);
  } catch (error) {
    setPreviewOutput(`变更预览失败: ${error?.message || String(error)}`);
  }
}

async function dryRunValidateConfig() {
  const result = get("result");
  try {
    const draft = buildDraftConfig({ strict: true });
    setEditorStatus("正在校验...", "muted");
    const res = await fetch("/api/config/notifications/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: draft }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || data?.message || `校验失败 (HTTP ${res.status})`;
      setEditorStatus(message, "error");
      result.textContent = JSON.stringify({ ok: false, status: res.status, data }, null, 2);
      return;
    }
    if (data?.ok) {
      const tip = data?.envOverride?.active ? `（注意：当前被 ${data.envOverride.envName} 覆盖，校验通过但保存会被拦截）` : "";
      setEditorStatus(`校验通过${tip}`, "ok");
    } else {
      setEditorStatus("校验未通过，请修复后再保存", "error");
    }
    result.textContent = JSON.stringify({ ok: true, status: res.status, data }, null, 2);
  } catch (error) {
    setEditorStatus(`校验失败: ${error?.message || String(error)}`, "error");
  }
}

async function loadBackups() {
  try {
    setBackupStatusOutput("正在加载备份列表...");
    const res = await fetch("/api/config/backups?type=notifications&page=1&pageSize=30");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || data?.message || `加载备份失败 (HTTP ${res.status})`;
      setBackupStatusOutput(message);
      editorState.backups = [];
      renderBackupSelect();
      return;
    }
    const list = Array.isArray(data?.data) ? data.data : [];
    editorState.backups = list;
    renderBackupSelect();
    setBackupStatusOutput(`已加载 ${list.length} 个备份`);
  } catch (error) {
    setBackupStatusOutput(`加载备份失败: ${error?.message || String(error)}`);
    editorState.backups = [];
    renderBackupSelect();
  }
}

async function rollbackSelectedBackup() {
  const select = get("rollback-backup-select");
  const backupFile = String(select?.value || "").trim();
  if (!backupFile) {
    setBackupStatusOutput("请先选择一个备份");
    return;
  }
  const confirmed = window.confirm(`确认回滚到备份：${backupFile} ？`);
  if (!confirmed) return;
  try {
    setBackupStatusOutput("正在执行回滚...");
    const res = await fetch("/api/config/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "notifications", backupFile }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || data?.message || `回滚失败 (HTTP ${res.status})`;
      setBackupStatusOutput(message);
      return;
    }
    setBackupStatusOutput(`回滚成功：${backupFile}`);
    await loadExistingConfig();
    await loadBackups();
  } catch (error) {
    setBackupStatusOutput(`回滚失败: ${error?.message || String(error)}`);
  }
}

async function runPreflightCheck() {
  const checks = [];
  try {
    const draft = buildDraftConfig({ strict: true });
    checks.push(`[OK] 草稿构建成功：${Array.isArray(draft.bindings) ? draft.bindings.length : 0} 个绑定`);
    checks.push(`[OK] 消息语言：${draft.messageLocale || "zh-CN"}`);
    checks.push(
      Object.keys(draft.messageTemplates || {}).length
        ? `[OK] 自定义模板：${Object.keys(draft.messageTemplates).join(", ")}`
        : "[INFO] 自定义模板：未启用（使用语言预设）"
    );
    const channelOverrideCount = (Array.isArray(draft.bindings) ? draft.bindings : []).reduce(
      (count, binding) =>
        count +
        (Array.isArray(binding?.channels) ? binding.channels : []).filter(
          (channel) =>
            Boolean(String(channel?.messageLocale || "").trim()) ||
            Object.keys(channel?.messageTemplates || {}).length > 0
        ).length,
      0
    );
    checks.push(
      channelOverrideCount > 0
        ? `[OK] 渠道级模板覆盖：${channelOverrideCount} 个渠道`
        : "[INFO] 渠道级模板覆盖：未启用（全部继承绑定默认）"
    );
    const diff = diffJsonValues(editorState.originalConfig || {}, draft);
    checks.push(
      diff.length ? `[OK] 变更检测：${diff.length} 项` : "[WARN] 变更检测：当前与基线无差异"
    );

    const res = await fetch("/api/config/notifications/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: draft }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      checks.push(`[FAIL] 服务端校验接口失败：HTTP ${res.status}`);
    } else if (!payload?.ok) {
      const count = Array.isArray(payload?.errors) ? payload.errors.length : 0;
      checks.push(`[FAIL] 服务端校验未通过：${count} 个错误`);
    } else {
      checks.push("[OK] 服务端校验通过");
      if (payload?.envOverride?.active) {
        checks.push(`[WARN] 当前被 ${payload.envOverride.envName} 覆盖，保存会被拦截`);
      }
    }

    const bindingName = get("test-binding")?.value?.trim() || get("binding-name")?.value?.trim() || "";
    checks.push(
      bindingName ? `[OK] 测试发送建议：可直接使用绑定 ${bindingName}` : "[WARN] 测试发送建议：请先填写绑定名"
    );
    setReleaseCheckOutput(checks.join("\n"));
  } catch (error) {
    checks.push(`[FAIL] 发布前检查失败：${error?.message || String(error)}`);
    setReleaseCheckOutput(checks.join("\n"));
  }
}

function addBinding() {
  if (!editorState.loaded || !editorState.config) return;
  applyFormToEditorSelection({ strict: false });
  const index = editorState.config.bindings.length;
  editorState.config.bindings.push(createDefaultBinding(index));
  editorState.selectedBindingIndex = index;
  editorState.selectedChannelIndex = 0;
  syncEditorUI();
  fillFormFromEditorSelection();
}

function deleteBinding() {
  if (!editorState.loaded || !editorState.config) return;
  const list = editorState.config.bindings;
  if (!Array.isArray(list) || list.length <= 1) return;
  if (!window.confirm(`确认删除绑定「${getCurrentBinding()?.name || "-"}」吗？`)) return;
  list.splice(editorState.selectedBindingIndex, 1);
  editorState.selectedBindingIndex = Math.max(0, editorState.selectedBindingIndex - 1);
  editorState.selectedChannelIndex = 0;
  syncEditorUI();
  fillFormFromEditorSelection();
}

function addChannel() {
  if (!editorState.loaded || !editorState.config) return;
  applyFormToEditorSelection({ strict: false });
  const binding = getCurrentBinding();
  if (!binding) return;
  const channels = Array.isArray(binding.channels) ? binding.channels : [];
  const type = normalizeType(get("channel-type").value || "wechat");
  channels.push(createDefaultChannel(type, channels.length));
  binding.channels = channels;
  editorState.selectedChannelIndex = channels.length - 1;
  syncEditorUI();
  fillFormFromEditorSelection();
}

function deleteChannel() {
  if (!editorState.loaded || !editorState.config) return;
  const binding = getCurrentBinding();
  const channels = Array.isArray(binding?.channels) ? binding.channels : [];
  if (channels.length <= 1) return;
  if (!window.confirm(`确认删除渠道「${getCurrentChannel()?.name || "-"}」吗？`)) return;
  channels.splice(editorState.selectedChannelIndex, 1);
  editorState.selectedChannelIndex = Math.max(0, editorState.selectedChannelIndex - 1);
  binding.channels = channels;
  syncEditorUI();
  fillFormFromEditorSelection();
}

function handleBindingSelectChange() {
  if (!editorState.loaded) return;
  applyFormToEditorSelection({ strict: false });
  editorState.selectedBindingIndex = Math.max(0, Number(get("editor-binding-select").value || 0));
  editorState.selectedChannelIndex = 0;
  renderChannelSelect();
  syncEditorButtons();
  fillFormFromEditorSelection();
}

function handleChannelSelectChange() {
  if (!editorState.loaded) return;
  applyFormToEditorSelection({ strict: false });
  editorState.selectedChannelIndex = Math.max(0, Number(get("editor-channel-select").value || 0));
  fillFormFromEditorSelection();
}

async function copyOutput() {
  const output = get("json-output").value.trim();
  if (!output) return alert("请先点击“生成 JSON”");
  try {
    await navigator.clipboard.writeText(output);
    alert("已复制，可直接粘贴到 notifications.json");
  } catch {
    alert("复制失败，请手动复制文本框内容");
  }
}

function applyTestEasyDefaults() {
  const singleScope = document.querySelector("input[name='test-scope'][value='single']");
  if (singleScope) singleScope.checked = true;
  toggleTestScope();
  get("test-channel-mode").value = "all";
  toggleTestChannelMode();
  get("test-binding").value = get("binding-name").value.trim() || "ops-all";
  get("test-target").value = "manual-test";
  get("test-severity").value = "danger";
  get("test-message").value = "manual test from config page";
}

function syncTestChannelNameFromCurrent() {
  const current = String(get("channel-name").value || "").trim();
  if (!current) return;
  get("test-channel-name").value = current;
}

get("channel-type").addEventListener("change", () => {
  toggleFields();
  if (editorState.loaded) {
    applyFormToEditorSelection({ strict: false });
    renderChannelSelect();
  }
  renderTemplatePreview();
});
get("message-locale").addEventListener("change", () => {
  if (!get("channel-template-enabled").checked) {
    get("channel-message-locale").value = normalizeMessageLocale(get("message-locale").value);
  }
  if (editorState.loaded) {
    applyFormToEditorSelection({ strict: false });
  }
  renderTemplatePreview();
});
get("channel-template-enabled").addEventListener("change", () => {
  toggleChannelTemplateFields();
  if (editorState.loaded) {
    applyFormToEditorSelection({ strict: false });
  }
  renderTemplatePreview();
});
get("channel-message-locale").addEventListener("change", () => {
  if (editorState.loaded) {
    applyFormToEditorSelection({ strict: false });
  }
  renderTemplatePreview();
});
get("escalate-enabled").addEventListener("change", toggleEscalationFields);
get("builder-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    showJson();
    if (guideState.mode === "novice") {
      setGuideStep(2);
      renderGuideLayout();
    }
  } catch (error) { alert(error.message || String(error)); }
});
get("copy-btn").addEventListener("click", copyOutput);
get("sync-binding-btn").addEventListener("click", () => { get("test-binding").value = get("binding-name").value.trim(); });
get("sync-channel-btn").addEventListener("click", syncTestChannelNameFromCurrent);
get("test-easy-fill-btn").addEventListener("click", applyTestEasyDefaults);
document.querySelectorAll("[data-template-var]").forEach((item) => {
  item.addEventListener("click", handleTemplateVarCopyClick);
});
get("load-config-btn").addEventListener("click", loadExistingConfig);
get("save-config-btn").addEventListener("click", saveConfigToServer);
get("apply-template-preset-btn").addEventListener("click", () => {
  applyTemplatePresetToForm();
  if (editorState.loaded) {
    applyFormToEditorSelection({ strict: false });
  }
  renderTemplatePreview();
});
get("apply-channel-template-preset-btn").addEventListener("click", () => {
  applyChannelTemplatePresetToForm();
  if (editorState.loaded) {
    applyFormToEditorSelection({ strict: false });
  }
  renderTemplatePreview();
});
get("template-preview-render-btn").addEventListener("click", () => renderTemplatePreview({ recordHistory: true }));
get("template-preview-history-clear-btn").addEventListener("click", clearTemplatePreviewHistory);
get("export-binding-template-snippet-btn").addEventListener("click", () => exportTemplateSnippet("binding"));
get("export-channel-template-snippet-btn").addEventListener("click", () => exportTemplateSnippet("channel"));
get("import-template-snippet-btn").addEventListener("click", importTemplateSnippet);
get("preview-diff-btn").addEventListener("click", previewConfigDiff);
get("dry-run-btn").addEventListener("click", dryRunValidateConfig);
get("preflight-check-btn").addEventListener("click", runPreflightCheck);
get("load-backups-btn").addEventListener("click", loadBackups);
get("rollback-btn").addEventListener("click", rollbackSelectedBackup);
get("editor-binding-add-btn").addEventListener("click", addBinding);
get("editor-binding-delete-btn").addEventListener("click", deleteBinding);
get("editor-channel-add-btn").addEventListener("click", addChannel);
get("editor-channel-delete-btn").addEventListener("click", deleteChannel);
get("editor-binding-select").addEventListener("change", handleBindingSelectChange);
get("editor-channel-select").addEventListener("change", handleChannelSelectChange);
document.querySelectorAll("input[name='test-scope']").forEach((item) => item.addEventListener("change", toggleTestScope));
get("test-channel-mode").addEventListener("change", toggleTestChannelMode);
["template-preview-scope", "template-preview-event", "template-preview-severity", "template-preview-prev-severity"].forEach((id) => {
  get(id).addEventListener("change", renderTemplatePreview);
});
[
  "binding-name",
  "template-preview-binding",
  "template-preview-target",
  "template-preview-url",
  "template-preview-level",
  "template-preview-unacked-sec",
  "template-preview-cpu",
  "template-preview-mem",
  "template-preview-disk",
  "template-preview-failed-services",
  "template-preview-reasons",
  "tpl-alert",
  "tpl-recover",
  "tpl-escalate",
  "tpl-test",
  "channel-tpl-alert",
  "channel-tpl-recover",
  "channel-tpl-escalate",
  "channel-tpl-test",
].forEach((id) => {
  get(id).addEventListener("input", renderTemplatePreview);
});

toggleFields();
toggleEscalationFields();
toggleTestScope();
toggleTestChannelMode();
toggleChannelTemplateFields();
initGuideMode();
syncEditorUI();
setEditorStatus("尚未加载", "muted");
setPreviewOutput("变更预览：尚未生成");
setReleaseCheckOutput("尚未执行检查");
setBackupStatusOutput("尚未加载备份");
setTemplateVarCopyStatus("点击变量即可一键复制", "muted");
setTemplateSnippetStatus("尚未执行导入/导出", "muted");
renderBackupSelect();
fillTemplateFields("zh-CN", {});
fillChannelTemplateFields(null, "zh-CN");
templatePreviewState.history = loadTemplatePreviewHistory();
renderTemplatePreviewHistory();
get("template-preview-binding").value = get("binding-name").value.trim() || "ops-all";
renderTemplatePreview();

const form = get("test-form");
const result = get("result");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (guideState.mode === "novice") {
    setGuideStep(4);
    renderGuideLayout();
  }
  result.textContent = "发送中...";
  const scope = (document.querySelector("input[name='test-scope']:checked") || {}).value;
  const channelMode = String(get("test-channel-mode").value || "all").trim().toLowerCase();
  const testChannel =
    channelMode === "current"
      ? String(get("channel-name").value || "").trim()
      : channelMode === "custom"
        ? String(get("test-channel-name").value || "").trim()
        : "";
  if (channelMode === "custom" && !testChannel) {
    result.textContent = "请先填写“渠道名称（手动）”";
    return;
  }
  const payload = {
    binding: scope === "all" ? "" : get("test-binding").value.trim(),
    channel: testChannel,
    target: get("test-target").value.trim() || "manual-test",
    severity: get("test-severity").value,
    message: get("test-message").value.trim(),
  };
  try {
    const res = await fetch("/api/alerts/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    result.textContent = JSON.stringify({ ok: res.ok, status: res.status, data }, null, 2);
  } catch (error) {
    result.textContent = String(error?.message || error);
  }
});
