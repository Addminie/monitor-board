const DEFAULT_REFRESH_MS = 5000;
// Keep roughly 24h points under 5s refresh.
const MAX_POINTS = 17280;
const CHART_BUCKET_MS = {
  "1m": 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};
const HISTORY_RANGE_PRESET = {
  "1m": { range: "6h", step: "1m" },
  "30m": { range: "7d", step: "30m" },
  "1h": { range: "14d", step: "1h" },
  "1d": { range: "30d", step: "1d" },
};
const DEFAULT_ALERTS = {
  cpu: { warn: 85, danger: 95 },
  mem: { warn: 85, danger: 95 },
  disk: { warn: 80, danger: 90 },
  serviceFailedDanger: 1,
};
const TARGET_META_FIELDS = ["env", "business", "room", "owner"];
const MAX_SAVED_VIEWS = 20;
const DETAIL_SECTION_KEYS = [
  "metadata",
  "root-cause",
  "services",
  "service-failures",
  "system",
  "disk",
  "docker",
  "tcp",
  "unreachable",
];
const DETAIL_TAB_KEYS = ["overview", "alerts", "system"];

const STORAGE_KEYS = {
  refreshMs: "monitor.refreshMs",
  autoRefresh: "monitor.autoRefresh",
  filterStatus: "monitor.filterStatus",
  filterEnv: "monitor.filterEnv",
  filterBusiness: "monitor.filterBusiness",
  filterRoom: "monitor.filterRoom",
  filterOwner: "monitor.filterOwner",
  sortBy: "monitor.sortBy",
  fontSize: "monitor.fontSize",
  workMode: "monitor.workMode",
  layoutMode: "monitor.layoutMode",
  chartBucket: "monitor.chartBucket",
  incidentFilter: "monitor.incidentFilter",
  incidentAcks: "monitor.incidentAcks",
  incidentSilences: "monitor.incidentSilences",
  savedViews: "monitor.savedViews",
  activeSavedViewId: "monitor.activeSavedViewId",
  detailCollapsed: "monitor.detailCollapsed",
  topControlsCollapsed: "monitor.topControlsCollapsed",
  detailTab: "monitor.detailTab",
};

function loadSavedViewsFromStorage() {
  const raw = String(localStorage.getItem(STORAGE_KEYS.savedViews) || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        id: String(item?.id || "").trim(),
        name: String(item?.name || "").trim(),
        filters: item?.filters && typeof item.filters === "object" ? item.filters : {},
        createdAt: Number(item?.createdAt || 0) || Date.now(),
        updatedAt: Number(item?.updatedAt || 0) || Date.now(),
      }))
      .filter((item) => item.id && item.name)
      .slice(0, MAX_SAVED_VIEWS);
  } catch (_error) {
    return [];
  }
}

function loadDetailCollapsedFromStorage() {
  const raw = String(localStorage.getItem(STORAGE_KEYS.detailCollapsed) || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next = {};
    Object.keys(parsed).forEach((key) => {
      next[String(key)] = parsed[key] === true;
    });
    return next;
  } catch (_error) {
    return {};
  }
}

function loadTopControlsCollapsedFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEYS.topControlsCollapsed);
  if (raw == null) return true;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  try {
    const parsed = JSON.parse(normalized);
    if (typeof parsed === "boolean") return parsed;
  } catch (_error) {
    // ignore invalid persisted values
  }
  return true;
}

function loadNumericRecordFromStorage(storageKey) {
  const raw = String(localStorage.getItem(storageKey) || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next = {};
    Object.entries(parsed).forEach(([key, value]) => {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) {
        next[String(key)] = num;
      }
    });
    return next;
  } catch (_error) {
    return {};
  }
}

const state = {
  refreshMs: Number(localStorage.getItem(STORAGE_KEYS.refreshMs) || DEFAULT_REFRESH_MS),
  autoRefresh: localStorage.getItem(STORAGE_KEYS.autoRefresh) !== "false",
  filterStatus: localStorage.getItem(STORAGE_KEYS.filterStatus) || "all",
  filterEnv: localStorage.getItem(STORAGE_KEYS.filterEnv) || "",
  filterBusiness: localStorage.getItem(STORAGE_KEYS.filterBusiness) || "",
  filterRoom: localStorage.getItem(STORAGE_KEYS.filterRoom) || "",
  filterOwner: localStorage.getItem(STORAGE_KEYS.filterOwner) || "",
  sortBy: localStorage.getItem(STORAGE_KEYS.sortBy) || "severity",
  fontSize: localStorage.getItem(STORAGE_KEYS.fontSize) || "medium",
  workMode: localStorage.getItem(STORAGE_KEYS.workMode) || "diagnose",
  layoutMode: localStorage.getItem(STORAGE_KEYS.layoutMode) || "wide",
  chartBucket: localStorage.getItem(STORAGE_KEYS.chartBucket) || "1m",
  incidentFilter: localStorage.getItem(STORAGE_KEYS.incidentFilter) || "pending",
  search: "",
  timerId: null,
  refreshing: false,
  lastServers: [],
  visibleServers: [],
  selectedServerId: "",
  alertHistory: new Map(),
  alerts: { ...DEFAULT_ALERTS },
  refreshOptionsMs: [5000, 10000, 30000, 60000],
  targetMetadata: { options: { env: [], business: [], room: [], owner: [] } },
  history: {
    enabled: false,
    backend: "none",
    lastLoadedBucket: "",
    lastLoadedAt: 0,
  },
  alertStateByUrl: new Map(),
  incidents: [],
  incidentSince: new Map(),
  incidentAcks: loadNumericRecordFromStorage(STORAGE_KEYS.incidentAcks),
  incidentSilences: loadNumericRecordFromStorage(STORAGE_KEYS.incidentSilences),
  savedViews: loadSavedViewsFromStorage(),
  activeSavedViewId: String(localStorage.getItem(STORAGE_KEYS.activeSavedViewId) || "").trim(),
  detailCollapsed: loadDetailCollapsedFromStorage(),
  topControlsCollapsed: loadTopControlsCollapsedFromStorage(),
  detailTab: localStorage.getItem(STORAGE_KEYS.detailTab) || "overview",
};

const elements = {
  topControlsToggle: document.getElementById("top-controls-toggle"),
  diagnoseBtn: document.getElementById("diagnose-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  controlsGrid: document.querySelector(".controls-grid"),
  table: document.getElementById("servers-table"),
  sumCpu: document.getElementById("sum-cpu"),
  sumMem: document.getElementById("sum-mem"),
  sumDisk: document.getElementById("sum-disk"),
  sumNet: document.getElementById("sum-net"),
  sumFailed: document.getElementById("sum-failed"),
  sumDocker: document.getElementById("sum-docker"),
  intervalSelect: document.getElementById("refresh-interval"),
  autoRefresh: document.getElementById("auto-refresh"),
  filterStatus: document.getElementById("filter-status"),
  filterEnv: document.getElementById("filter-env"),
  filterBusiness: document.getElementById("filter-business"),
  filterRoom: document.getElementById("filter-room"),
  filterOwner: document.getElementById("filter-owner"),
  savedViewSelect: document.getElementById("saved-view-select"),
  savedViewSaveBtn: document.getElementById("saved-view-save-btn"),
  savedViewDeleteBtn: document.getElementById("saved-view-delete-btn"),
  savedViewResetBtn: document.getElementById("saved-view-reset-btn"),
  searchInput: document.getElementById("search-input"),
  sortBy: document.getElementById("sort-by"),
  fontSize: document.getElementById("font-size"),
  workMode: document.getElementById("work-mode"),
  layoutModeToggle: document.getElementById("layout-mode-toggle"),
  chartBucket: document.getElementById("chart-bucket"),
  incidentFilter: document.getElementById("incident-filter"),
  incidentClearBtn: document.getElementById("incident-clear-btn"),
  incidentSummary: document.getElementById("incident-summary"),
  incidentList: document.getElementById("incident-list"),
  fetchStatus: document.getElementById("fetch-status"),
  alertConfig: document.getElementById("alert-config"),
  metaSummary: document.getElementById("meta-summary"),
  lastUpdated: document.getElementById("last-updated"),
  freshnessSummary: document.getElementById("freshness-summary"),
  riskSummary: document.getElementById("risk-summary"),
  riskTopList: document.getElementById("risk-top-list"),
  tableSummary: document.getElementById("table-summary"),
  tableQuickAll: document.getElementById("table-quick-all"),
  tableQuickAlert: document.getElementById("table-quick-alert"),
  tableQuickOnline: document.getElementById("table-quick-online"),
  tableClearSearch: document.getElementById("table-clear-search"),
  detailTarget: document.getElementById("detail-target"),
  detailBody: document.getElementById("detail-body"),
  detailExpandAllBtn: document.getElementById("detail-expand-all-btn"),
  detailCollapseAllBtn: document.getElementById("detail-collapse-all-btn"),
  detailTabOverview: document.getElementById("detail-tab-overview"),
  detailTabAlerts: document.getElementById("detail-tab-alerts"),
  detailTabSystem: document.getElementById("detail-tab-system"),
};

const charts = {
  cpu: echarts.init(document.getElementById("chart-cpu")),
  mem: echarts.init(document.getElementById("chart-mem")),
  disk: echarts.init(document.getElementById("chart-disk")),
  net: echarts.init(document.getElementById("chart-net")),
  incidents: echarts.init(document.getElementById("chart-incidents")),
};

const series = {
  stamps: [],
  cpu: [],
  mem: [],
  disk: [],
  net: [],
  incidentWarn: [],
  incidentDanger: [],
  incidentOffline: [],
};

function cloneAlerts(alerts) {
  return {
    cpu: { ...alerts.cpu },
    mem: { ...alerts.mem },
    disk: { ...alerts.disk },
    serviceFailedDanger: alerts.serviceFailedDanger,
  };
}

function normalizePair(input, fallback) {
  let warn = Number(input?.warn);
  let danger = Number(input?.danger);
  if (!Number.isFinite(warn)) warn = fallback.warn;
  if (!Number.isFinite(danger)) danger = fallback.danger;
  warn = Math.max(0, Math.min(100, warn));
  danger = Math.max(0, Math.min(100, danger));
  if (danger < warn) {
    const t = warn;
    warn = danger;
    danger = t;
  }
  return { warn, danger };
}

function normalizeAlerts(input) {
  const source = input && typeof input === "object" ? input : {};
  const serviceFailedDanger = Number(source.serviceFailedDanger);
  return {
    cpu: normalizePair(source.cpu, DEFAULT_ALERTS.cpu),
    mem: normalizePair(source.mem, DEFAULT_ALERTS.mem),
    disk: normalizePair(source.disk, DEFAULT_ALERTS.disk),
    serviceFailedDanger:
      Number.isFinite(serviceFailedDanger) && serviceFailedDanger >= 0
        ? Math.floor(serviceFailedDanger)
        : DEFAULT_ALERTS.serviceFailedDanger,
  };
}

function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}%`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h}h ${m}m`;
}

function formatTime(ts) {
  const date = new Date(ts || Date.now());
  if (Number.isNaN(date.getTime())) return "-";
  return date.toTimeString().slice(0, 8);
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const totalSec = Math.floor(value / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

function formatAgeCompact(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "-";
  const totalSec = Math.floor(value / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function parseTimestampMs(input) {
  if (input == null) return NaN;
  if (typeof input === "number") return Number.isFinite(input) ? input : NaN;
  const raw = String(input || "").trim();
  if (!raw) return NaN;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getServerUpdatedAtMs(server) {
  const statusTs = parseTimestampMs(server?.metrics?.timestamp);
  if (Number.isFinite(statusTs)) return statusTs;
  const fetchedAt = parseTimestampMs(server?.fetchedAt);
  if (Number.isFinite(fetchedAt)) return fetchedAt;
  return NaN;
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeFontSize(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["small", "medium", "large"].includes(normalized)) return normalized;
  return "medium";
}

function normalizeWorkMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["oncall", "diagnose"].includes(normalized)) return normalized;
  return "diagnose";
}

function normalizeLayoutMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["compact", "wide"].includes(normalized)) return normalized;
  return "wide";
}

function normalizeDetailTab(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (DETAIL_TAB_KEYS.includes(normalized)) return normalized;
  return "overview";
}

function normalizeChartBucket(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CHART_BUCKET_MS, normalized)) {
    return normalized;
  }
  return "1m";
}

function normalizeIncidentFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = ["pending", "all", "danger", "offline", "warn", "acked", "silenced"];
  if (allowed.includes(normalized)) return normalized;
  return "pending";
}

function normalizeMetaValue(value) {
  return String(value || "").trim();
}

function normalizeMetadata(input) {
  const source = input && typeof input === "object" ? input : {};
  const tags = source.tags && typeof source.tags === "object" ? source.tags : {};
  const metadata = {};
  TARGET_META_FIELDS.forEach((field) => {
    const value = source[field] != null ? source[field] : tags[field];
    metadata[field] = normalizeMetaValue(value);
  });
  return metadata;
}

function getMetaFilterState(field) {
  if (field === "env") return normalizeMetaValue(state.filterEnv);
  if (field === "business") return normalizeMetaValue(state.filterBusiness);
  if (field === "room") return normalizeMetaValue(state.filterRoom);
  if (field === "owner") return normalizeMetaValue(state.filterOwner);
  return "";
}

function setMetaFilterState(field, value) {
  const next = normalizeMetaValue(value);
  if (field === "env") state.filterEnv = next;
  if (field === "business") state.filterBusiness = next;
  if (field === "room") state.filterRoom = next;
  if (field === "owner") state.filterOwner = next;
}

function getMetaFilterElement(field) {
  if (field === "env") return elements.filterEnv;
  if (field === "business") return elements.filterBusiness;
  if (field === "room") return elements.filterRoom;
  if (field === "owner") return elements.filterOwner;
  return null;
}

function getMetaStorageKey(field) {
  if (field === "env") return STORAGE_KEYS.filterEnv;
  if (field === "business") return STORAGE_KEYS.filterBusiness;
  if (field === "room") return STORAGE_KEYS.filterRoom;
  if (field === "owner") return STORAGE_KEYS.filterOwner;
  return "";
}

function computeMetaOptions(servers) {
  const options = {};
  TARGET_META_FIELDS.forEach((field) => {
    const values = new Set();
    (servers || []).forEach((server) => {
      const value = normalizeMetaValue(server?.metadata?.[field]);
      if (value) values.add(value);
    });
    const fromSettings = Array.isArray(state.targetMetadata?.options?.[field])
      ? state.targetMetadata.options[field]
      : [];
    fromSettings.forEach((value) => {
      const normalized = normalizeMetaValue(value);
      if (normalized) values.add(normalized);
    });
    const selected = getMetaFilterState(field);
    if (selected) values.add(selected);
    options[field] = Array.from(values).sort((a, b) => a.localeCompare(b));
  });
  return options;
}

function syncMetaFilterControls(servers) {
  const options = computeMetaOptions(servers);
  TARGET_META_FIELDS.forEach((field) => {
    const el = getMetaFilterElement(field);
    if (!el) return;
    const values = options[field] || [];
    const previous = getMetaFilterState(field);
    el.innerHTML = ['<option value="">全部</option>']
      .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`))
      .join("");
    const next = values.includes(previous) ? previous : "";
    setMetaFilterState(field, next);
    el.value = next;
    const storageKey = getMetaStorageKey(field);
    if (storageKey) localStorage.setItem(storageKey, next);
  });
}

function normalizeSavedViewFilters(filters) {
  const source = filters && typeof filters === "object" ? filters : {};
  return {
    filterStatus: String(source.filterStatus || "all"),
    filterEnv: normalizeMetaValue(source.filterEnv),
    filterBusiness: normalizeMetaValue(source.filterBusiness),
    filterRoom: normalizeMetaValue(source.filterRoom),
    filterOwner: normalizeMetaValue(source.filterOwner),
    sortBy: String(source.sortBy || "severity"),
    search: String(source.search || ""),
  };
}

function getCurrentViewFilters() {
  return normalizeSavedViewFilters({
    filterStatus: state.filterStatus,
    filterEnv: state.filterEnv,
    filterBusiness: state.filterBusiness,
    filterRoom: state.filterRoom,
    filterOwner: state.filterOwner,
    sortBy: state.sortBy,
    search: state.search,
  });
}

function applyViewFilters(filters) {
  const normalized = normalizeSavedViewFilters(filters);
  state.filterStatus = normalized.filterStatus;
  state.filterEnv = normalized.filterEnv;
  state.filterBusiness = normalized.filterBusiness;
  state.filterRoom = normalized.filterRoom;
  state.filterOwner = normalized.filterOwner;
  state.sortBy = normalized.sortBy;
  state.search = normalized.search;

  localStorage.setItem(STORAGE_KEYS.filterStatus, state.filterStatus);
  localStorage.setItem(STORAGE_KEYS.filterEnv, state.filterEnv);
  localStorage.setItem(STORAGE_KEYS.filterBusiness, state.filterBusiness);
  localStorage.setItem(STORAGE_KEYS.filterRoom, state.filterRoom);
  localStorage.setItem(STORAGE_KEYS.filterOwner, state.filterOwner);
  localStorage.setItem(STORAGE_KEYS.sortBy, state.sortBy);

  if (elements.filterStatus) elements.filterStatus.value = state.filterStatus;
  if (elements.sortBy) elements.sortBy.value = state.sortBy;
  if (elements.searchInput) elements.searchInput.value = state.search;
}

function persistSavedViews() {
  localStorage.setItem(STORAGE_KEYS.savedViews, JSON.stringify(state.savedViews));
  localStorage.setItem(STORAGE_KEYS.activeSavedViewId, state.activeSavedViewId || "");
}

function findSavedViewById(viewId) {
  const id = String(viewId || "").trim();
  if (!id) return null;
  return state.savedViews.find((item) => item.id === id) || null;
}

function syncSavedViewControls() {
  const select = elements.savedViewSelect;
  if (!select) return;
  const options = ['<option value="">当前视图</option>']
    .concat(
      state.savedViews.map(
        (item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`
      )
    )
    .join("");
  select.innerHTML = options;
  const activeExists = Boolean(findSavedViewById(state.activeSavedViewId));
  if (!activeExists) {
    state.activeSavedViewId = "";
  }
  select.value = state.activeSavedViewId || "";
  if (elements.savedViewDeleteBtn) {
    elements.savedViewDeleteBtn.disabled = !state.activeSavedViewId;
  }
  persistSavedViews();
}

function markViewAsCustom() {
  if (!state.activeSavedViewId) return;
  state.activeSavedViewId = "";
  syncSavedViewControls();
}

function saveCurrentAsView() {
  const current = getCurrentViewFilters();
  const active = findSavedViewById(state.activeSavedViewId);
  const now = Date.now();
  if (active) {
    active.filters = current;
    active.updatedAt = now;
    persistSavedViews();
    syncSavedViewControls();
    setStatus(`已更新视图: ${active.name}`, "ok");
    return;
  }

  const name = String(window.prompt("请输入视图名称", "") || "").trim();
  if (!name) return;
  const sameName = state.savedViews.find(
    (item) => item.name.toLowerCase() === name.toLowerCase()
  );
  if (sameName) {
    const confirmed = window.confirm(`已存在同名视图「${sameName.name}」，是否覆盖？`);
    if (!confirmed) return;
    sameName.filters = current;
    sameName.updatedAt = now;
    state.activeSavedViewId = sameName.id;
    syncSavedViewControls();
    setStatus(`已覆盖视图: ${sameName.name}`, "ok");
    return;
  }
  const view = {
    id: `view-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    filters: current,
    createdAt: now,
    updatedAt: now,
  };
  state.savedViews.unshift(view);
  if (state.savedViews.length > MAX_SAVED_VIEWS) {
    state.savedViews = state.savedViews.slice(0, MAX_SAVED_VIEWS);
  }
  state.activeSavedViewId = view.id;
  syncSavedViewControls();
  setStatus(`已保存视图: ${view.name}`, "ok");
}

function deleteActiveView() {
  const active = findSavedViewById(state.activeSavedViewId);
  if (!active) return;
  const confirmed = window.confirm(`确定删除视图「${active.name}」吗？`);
  if (!confirmed) return;
  state.savedViews = state.savedViews.filter((item) => item.id !== active.id);
  state.activeSavedViewId = "";
  syncSavedViewControls();
  setStatus(`已删除视图: ${active.name}`, "ok");
}

function activateSavedView(viewId) {
  const view = findSavedViewById(viewId);
  if (!view) {
    state.activeSavedViewId = "";
    syncSavedViewControls();
    return;
  }
  state.activeSavedViewId = view.id;
  applyViewFilters(view.filters);
  syncSavedViewControls();
  render(state.lastServers, false);
  setStatus(`已切换视图: ${view.name}`, "ok");
}

function resetFiltersToDefault() {
  applyViewFilters({
    filterStatus: "all",
    filterEnv: "",
    filterBusiness: "",
    filterRoom: "",
    filterOwner: "",
    sortBy: "severity",
    search: "",
  });
  markViewAsCustom();
  render(state.lastServers, false);
  setStatus("已重置筛选条件", "ok");
}

function persistDetailCollapsedState() {
  localStorage.setItem(STORAGE_KEYS.detailCollapsed, JSON.stringify(state.detailCollapsed || {}));
}

function isDetailSectionCollapsed(key, defaultCollapsed = false) {
  const normalized = String(key || "").trim();
  if (!normalized) return Boolean(defaultCollapsed);
  if (!Object.prototype.hasOwnProperty.call(state.detailCollapsed, normalized)) {
    return Boolean(defaultCollapsed);
  }
  return state.detailCollapsed[normalized] === true;
}

function setDetailSectionCollapsed(key, collapsed) {
  const normalized = String(key || "").trim();
  if (!normalized) return;
  state.detailCollapsed[normalized] = collapsed === true;
  persistDetailCollapsedState();
}

function setAllDetailSectionsCollapsed(collapsed) {
  DETAIL_SECTION_KEYS.forEach((key) => {
    state.detailCollapsed[key] = collapsed === true;
  });
  persistDetailCollapsedState();
}

function persistTopControlsCollapsedState() {
  localStorage.setItem(STORAGE_KEYS.topControlsCollapsed, String(state.topControlsCollapsed));
}

function applyTopControlsCollapsedState() {
  const collapsed = state.topControlsCollapsed === true;
  if (elements.controlsGrid) {
    elements.controlsGrid.classList.toggle("collapsed", collapsed);
  }
  if (elements.topControlsToggle) {
    elements.topControlsToggle.textContent = collapsed ? "展开筛选" : "收起筛选";
    elements.topControlsToggle.setAttribute("aria-expanded", String(!collapsed));
    elements.topControlsToggle.setAttribute("aria-controls", "top-controls-grid");
    elements.topControlsToggle.title = collapsed
      ? "展开顶部筛选卡片"
      : "收起顶部筛选卡片";
  }
}

function updateQuickFilterButtons() {
  const status = String(state.filterStatus || "all");
  if (elements.tableQuickAll) {
    const active = status === "all";
    elements.tableQuickAll.classList.toggle("is-active", active);
    elements.tableQuickAll.setAttribute("aria-pressed", String(active));
  }
  if (elements.tableQuickAlert) {
    const active = status === "alert";
    elements.tableQuickAlert.classList.toggle("is-active", active);
    elements.tableQuickAlert.setAttribute("aria-pressed", String(active));
  }
  if (elements.tableQuickOnline) {
    const active = status === "online";
    elements.tableQuickOnline.classList.toggle("is-active", active);
    elements.tableQuickOnline.setAttribute("aria-pressed", String(active));
  }
}

function applyDetailTabControls() {
  const active = normalizeDetailTab(state.detailTab);
  state.detailTab = active;
  const controls = [
    elements.detailTabOverview,
    elements.detailTabAlerts,
    elements.detailTabSystem,
  ];
  controls.forEach((button) => {
    if (!button) return;
    const tab = String(button.dataset.detailTab || "").trim();
    const selected = tab === active;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
}

function applyDetailTabVisibility() {
  if (!elements.detailBody) return;
  const detailTab = normalizeDetailTab(state.detailTab);
  const sectionWhitelist = {
    overview: null,
    alerts: new Set(["root-cause", "services", "service-failures", "unreachable"]),
    system: new Set(["metadata", "system", "disk", "docker", "tcp"]),
  };
  const cardWhitelist = {
    overview: null,
    alerts: new Set(["cpu", "mem", "disk", "uptime"]),
    system: new Set(["cpu", "mem", "disk", "uptime"]),
  };
  const allowedSections = sectionWhitelist[detailTab] || null;
  const allowedCards = cardWhitelist[detailTab] || null;
  elements.detailBody
    .querySelectorAll("[data-detail-section]")
    .forEach((node) => {
      const key = String(node.getAttribute("data-detail-section") || "").trim();
      const hidden = Boolean(allowedSections && !allowedSections.has(key));
      node.classList.toggle("is-hidden-by-tab", hidden);
    });
  elements.detailBody
    .querySelectorAll("[data-detail-card]")
    .forEach((node) => {
      const key = String(node.getAttribute("data-detail-card") || "").trim();
      const hidden = Boolean(allowedCards && !allowedCards.has(key));
      node.classList.toggle("is-hidden-by-tab", hidden);
    });
  const staleTip = elements.detailBody.querySelector(".detail-tab-empty");
  if (staleTip) staleTip.remove();
  const visibleSectionCount = Array.from(
    elements.detailBody.querySelectorAll("[data-detail-section]")
  ).filter((node) => !node.classList.contains("is-hidden-by-tab")).length;
  const visibleCardCount = Array.from(
    elements.detailBody.querySelectorAll("[data-detail-card]")
  ).filter((node) => !node.classList.contains("is-hidden-by-tab")).length;
  if ((visibleSectionCount || visibleCardCount) > 0) return;
  const tip = document.createElement("div");
  tip.className = "muted detail-tab-empty";
  tip.textContent = "当前标签页无可展示数据，请切换到“全部”查看。";
  elements.detailBody.appendChild(tip);
}

function applyDetailTab(tab) {
  state.detailTab = normalizeDetailTab(tab);
  localStorage.setItem(STORAGE_KEYS.detailTab, state.detailTab);
  applyDetailTabControls();
  applyDetailTabVisibility();
}

function setTableSummary(servers) {
  if (!elements.tableSummary) return;
  const total = Array.isArray(state.lastServers) ? state.lastServers.length : 0;
  const visible = Array.isArray(servers) ? servers.length : 0;
  const online = (Array.isArray(servers) ? servers : []).filter((item) => item.status).length;
  const alerting = (Array.isArray(servers) ? servers : []).filter((item) => isAlert(item)).length;
  const offline = visible - online;
  elements.tableSummary.textContent = `当前显示 ${visible}/${total} 台 | 在线 ${online} | 告警 ${alerting} | 离线 ${offline}`;
}

function setFilterStatusAndRender(nextStatus) {
  state.filterStatus = String(nextStatus || "all");
  localStorage.setItem(STORAGE_KEYS.filterStatus, state.filterStatus);
  if (elements.filterStatus) {
    elements.filterStatus.value = state.filterStatus;
  }
  markViewAsCustom();
  render(state.lastServers, false);
}

function getCurrentSelectedServer() {
  return (
    state.lastServers.find((item) => item.id === state.selectedServerId) ||
    state.visibleServers.find((item) => item.id === state.selectedServerId) ||
    state.visibleServers[0] ||
    null
  );
}

function renderCollapsibleDetailBlock(key, title, contentHtml, options = {}) {
  const summary = String(options.summary || "").trim();
  const collapsed = isDetailSectionCollapsed(key, options.defaultCollapsed === true);
  const collapsedClass = collapsed ? " collapsed" : "";
  const buttonText = collapsed ? "展开" : "收起";
  return `
    <div class="detail-block${collapsedClass}" data-detail-section="${escapeHtml(key)}">
      <div class="detail-block-head">
        <div>
          <div class="detail-block-title">${escapeHtml(title)}</div>
          ${summary ? `<div class="detail-block-summary">${escapeHtml(summary)}</div>` : ""}
        </div>
        <button class="button detail-toggle" type="button" data-detail-toggle-key="${escapeHtml(
          key
        )}">${buttonText}</button>
      </div>
      <div class="detail-block-content">${contentHtml}</div>
    </div>`;
}

function applyFontSize() {
  const mode = normalizeFontSize(state.fontSize);
  state.fontSize = mode;
  if (!document.body) return;
  document.body.dataset.fontSize = mode;
}

function applyWorkMode() {
  const mode = normalizeWorkMode(state.workMode);
  state.workMode = mode;
  if (document.body) {
    document.body.dataset.workMode = mode;
  }
  if (elements.workMode) {
    elements.workMode.value = mode;
  }
  window.requestAnimationFrame(() => {
    Object.values(charts).forEach((chart) => chart.resize());
  });
}

function updateLayoutModeToggle() {
  if (!elements.layoutModeToggle) return;
  const nextMode = state.layoutMode === "compact" ? "wide" : "compact";
  const nextLabel = nextMode === "compact" ? "????" : "????";
  const currentLabel = state.layoutMode === "compact" ? "????" : "????";
  elements.layoutModeToggle.textContent = `???${nextLabel}`;
  elements.layoutModeToggle.title = `???${currentLabel}`;
}


function applyLayoutMode() {
  const mode = normalizeLayoutMode(state.layoutMode);
  state.layoutMode = mode;
  if (document.body) {
    document.body.dataset.layoutMode = mode;
  }
  updateLayoutModeToggle();
  window.requestAnimationFrame(() => {
    Object.values(charts).forEach((chart) => chart.resize());
  });
}

function localizeServiceState(value) {
  const key = normalizeToken(value);
  const map = {
    running: "\u8fd0\u884c\u4e2d",
    stopped: "\u5df2\u505c\u6b62",
    stop: "\u5df2\u505c\u6b62",
    active: "\u8fd0\u884c\u4e2d",
    inactive: "\u672a\u8fd0\u884c",
    activating: "\u542f\u52a8\u4e2d",
    deactivating: "\u505c\u6b62\u4e2d",
    exited: "\u5df2\u9000\u51fa",
    dead: "\u5df2\u7ec8\u6b62",
    failed: "\u5931\u8d25",
    startpending: "\u542f\u52a8\u4e2d",
    "start pending": "\u542f\u52a8\u4e2d",
    stoppending: "\u505c\u6b62\u4e2d",
    "stop pending": "\u505c\u6b62\u4e2d",
    paused: "\u5df2\u6682\u505c",
    pausepending: "\u6682\u505c\u4e2d",
    "pause pending": "\u6682\u505c\u4e2d",
    continuepending: "\u6062\u590d\u4e2d",
    "continue pending": "\u6062\u590d\u4e2d",
  };
  return map[key] || (value || "-");
}

function localizeServiceStartMode(value) {
  const key = normalizeToken(value);
  const map = {
    auto: "\u81ea\u52a8",
    automatic: "\u81ea\u52a8",
    enabled: "\u5df2\u542f\u7528",
    manual: "\u624b\u52a8",
    disabled: "\u7981\u7528",
    static: "\u9759\u6001",
    indirect: "\u95f4\u63a5",
    boot: "\u5f15\u5bfc",
    system: "\u7cfb\u7edf",
  };
  return map[key] || (value || "-");
}

function localizeServiceHealth(value) {
  const key = normalizeToken(value);
  const map = {
    ok: "\u6b63\u5e38",
    good: "\u6b63\u5e38",
    warning: "\u8b66\u544a",
    warn: "\u8b66\u544a",
    degraded: "\u964d\u7ea7",
    error: "\u9519\u8bef",
    unknown: "\u672a\u77e5",
    "pred fail": "\u9884\u6d4b\u6545\u969c",
  };
  return map[key] || (value || "-");
}

function isServiceFailure(item) {
  if (!item || typeof item !== "object") return false;
  const health = normalizeToken(item.health);
  if (["error", "degraded", "pred fail", "unknown"].includes(health)) {
    return true;
  }
  const startMode = normalizeToken(item.sub);
  const activeState = normalizeToken(item.active);
  const exitCode = Number(item.exitCode);
  return (
    (startMode === "auto" || startMode === "automatic") &&
    activeState !== "running" &&
    Number.isFinite(exitCode) &&
    exitCode !== 0 &&
    exitCode !== 1077
  );
}

function getServiceFailures(status) {
  const items = Array.isArray(status?.services?.items) ? status.services.items : [];
  return items.filter((item) => isServiceFailure(item));
}

function buildServiceFailureReason(item) {
  if (!item || typeof item !== "object") return "-";
  const health = normalizeToken(item.health);
  if (["error", "degraded", "pred fail", "unknown"].includes(health)) {
    return `\u5065\u5eb7\u72b6\u6001\u5f02\u5e38(${localizeServiceHealth(item.health)})`;
  }
  const startMode = normalizeToken(item.sub);
  const activeState = normalizeToken(item.active);
  const exitCode = Number(item.exitCode);
  if (
    (startMode === "auto" || startMode === "automatic") &&
    activeState !== "running" &&
    Number.isFinite(exitCode) &&
    exitCode !== 0 &&
    exitCode !== 1077
  ) {
    return `\u81ea\u542f\u52a8\u670d\u52a1\u5df2\u505c\u6b62(\u9000\u51fa\u7801 ${exitCode})`;
  }
  return "\u672a\u89e6\u53d1\u6545\u969c\u89c4\u5219";
}

function localizeTcpState(value) {
  const key = String(value || "").trim().toUpperCase();
  const map = {
    ESTABLISHED: "\u5df2\u5efa\u7acb",
    SYN_SENT: "\u53d1\u8d77\u8fde\u63a5",
    SYN_RECV: "\u63a5\u6536\u540c\u6b65",
    SYN_RECEIVED: "\u63a5\u6536\u540c\u6b65",
    FIN_WAIT1: "\u5173\u95ed\u7b49\u5f851",
    FIN_WAIT2: "\u5173\u95ed\u7b49\u5f852",
    TIME_WAIT: "\u7b49\u5f85\u56de\u6536",
    TIMEWAIT: "\u7b49\u5f85\u56de\u6536",
    CLOSE: "\u5df2\u5173\u95ed",
    CLOSE_WAIT: "\u7b49\u5f85\u5173\u95ed",
    CLOSEWAIT: "\u7b49\u5f85\u5173\u95ed",
    LAST_ACK: "\u6700\u540e\u786e\u8ba4",
    LISTEN: "\u76d1\u542c",
    CLOSING: "\u5173\u95ed\u4e2d",
    BOUND: "\u5df2\u7ed1\u5b9a",
    UNKNOWN: "\u672a\u77e5",
  };
  return map[key] || (value || "-");
}

function makeBadge(level, text) {
  return `<span class="badge ${level}">${escapeHtml(text)}</span>`;
}

function makeHeat(level, text) {
  return `<span class="heat ${level}">${escapeHtml(text)}</span>`;
}

function metricThreshold(metric) {
  return state.alerts[metric] || DEFAULT_ALERTS[metric];
}

function levelByValue(value, metric) {
  if (!Number.isFinite(value)) return "na";
  const threshold = metricThreshold(metric);
  if (value >= threshold.danger) return "danger";
  if (value >= threshold.warn) return "warn";
  return "ok";
}

function setStatus(message, level = "ok") {
  if (!elements.fetchStatus) return;
  elements.fetchStatus.className = `status-msg ${level}`;
  elements.fetchStatus.textContent = message;
}

function setLastUpdated(ts) {
  if (!elements.lastUpdated) return;
  elements.lastUpdated.textContent = `\u6700\u8fd1\u66f4\u65b0: ${formatTime(ts)}`;
}

function setAlertConfigText() {
  if (!elements.alertConfig) return;
  const cpu = state.alerts.cpu;
  const mem = state.alerts.mem;
  const disk = state.alerts.disk;
  elements.alertConfig.textContent =
    `\u9608\u503c CPU ${cpu.warn}/${cpu.danger} MEM ${mem.warn}/${mem.danger} DISK ${disk.warn}/${disk.danger}`;
}

function freshnessThresholdsMs() {
  const base = Number(state.refreshMs) || DEFAULT_REFRESH_MS;
  return {
    warn: Math.max(60 * 1000, base * 3),
    danger: Math.max(3 * 60 * 1000, base * 6),
  };
}

function freshnessLevelByAge(ageMs) {
  const value = Number(ageMs);
  if (!Number.isFinite(value) || value < 0) return "na";
  const threshold = freshnessThresholdsMs();
  if (value >= threshold.danger) return "danger";
  if (value >= threshold.warn) return "warn";
  return "ok";
}

function buildUpdatedAtCell(server) {
  const updatedMs = getServerUpdatedAtMs(server);
  if (!Number.isFinite(updatedMs)) {
    return '<span class="freshness freshness-na">-</span>';
  }
  const ageMs = Math.max(0, Date.now() - updatedMs);
  const ageText = formatAgeCompact(ageMs);
  const level = freshnessLevelByAge(ageMs);
  const title = `上报时间: ${new Date(updatedMs).toLocaleString()} | 延迟: ${ageText}`;
  return `<span class="freshness freshness-${level}" title="${escapeHtml(title)}">${escapeHtml(
    formatTime(updatedMs)
  )} (${escapeHtml(ageText)})</span>`;
}

function setFreshnessSummary(servers) {
  if (!elements.freshnessSummary) return;
  const source = Array.isArray(servers) ? servers : [];
  if (!source.length) {
    elements.freshnessSummary.className = "status-time freshness freshness-na";
    elements.freshnessSummary.textContent = "数据新鲜度: -";
    return;
  }
  const stats = { ok: 0, warn: 0, danger: 0, na: 0 };
  let maxAgeMs = 0;
  source.forEach((server) => {
    const updatedMs = getServerUpdatedAtMs(server);
    const ageMs = Number.isFinite(updatedMs) ? Math.max(0, Date.now() - updatedMs) : NaN;
    const level = freshnessLevelByAge(ageMs);
    stats[level] = (stats[level] || 0) + 1;
    if (Number.isFinite(ageMs)) {
      maxAgeMs = Math.max(maxAgeMs, ageMs);
    }
  });
  const overall = stats.danger > 0 ? "danger" : stats.warn > 0 ? "warn" : "ok";
  elements.freshnessSummary.className = `status-time freshness freshness-${overall}`;
  elements.freshnessSummary.textContent =
    `数据新鲜度 正常 ${stats.ok} / 延迟 ${stats.warn} / 过期 ${stats.danger} | 最大延迟 ${formatAgeCompact(
      maxAgeMs
    )}`;
}

function setMetaSummary(servers) {
  if (!elements.metaSummary) return;
  const source = Array.isArray(servers) ? servers : [];
  const uniqueCount = {};
  TARGET_META_FIELDS.forEach((field) => {
    const values = new Set();
    source.forEach((server) => {
      const value = normalizeMetaValue(server?.metadata?.[field]);
      if (value) values.add(value);
    });
    uniqueCount[field] = values.size;
  });

  const activeFilters = TARGET_META_FIELDS.map((field) => {
    const selected = getMetaFilterState(field);
    if (!selected) return "";
    const label = field === "env" ? "环境" : field === "business" ? "业务" : field === "room" ? "机房" : "负责人";
    return `${label}:${selected}`;
  }).filter(Boolean);

  const filterText = activeFilters.length ? ` | 过滤: ${activeFilters.join(", ")}` : "";
  elements.metaSummary.textContent =
    `标签统计 ENV ${uniqueCount.env} / 业务 ${uniqueCount.business} / 机房 ${uniqueCount.room} / 负责人 ${uniqueCount.owner}${filterText}`;
}

function getBucketStart(ts, bucket) {
  const mode = normalizeChartBucket(bucket);
  const date = new Date(ts);
  if (mode === "1d") {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  const bucketMs = CHART_BUCKET_MS[mode] || CHART_BUCKET_MS["1m"];
  return Math.floor(ts / bucketMs) * bucketMs;
}

function formatBucketLabel(ts, bucket) {
  const mode = normalizeChartBucket(bucket);
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, "0");
  if (mode === "1d") {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function aggregateSeriesByBucket(bucket) {
  const mode = normalizeChartBucket(bucket);
  const buckets = new Map();
  for (let i = 0; i < series.stamps.length; i += 1) {
    const ts = Number(series.stamps[i]);
    if (!Number.isFinite(ts)) continue;
    const key = getBucketStart(ts, mode);
    if (!buckets.has(key)) {
      buckets.set(key, {
        cpuSum: 0,
        cpuCount: 0,
        memSum: 0,
        memCount: 0,
        diskMax: null,
        netSum: 0,
        netCount: 0,
        incidentWarn: null,
        incidentDanger: null,
        incidentOffline: null,
      });
    }
    const row = buckets.get(key);
    const cpu = Number(series.cpu[i]);
    const mem = Number(series.mem[i]);
    const disk = Number(series.disk[i]);
    const net = Number(series.net[i]);
    const incidentWarn = Number(series.incidentWarn[i]);
    const incidentDanger = Number(series.incidentDanger[i]);
    const incidentOffline = Number(series.incidentOffline[i]);
    if (Number.isFinite(cpu)) {
      row.cpuSum += cpu;
      row.cpuCount += 1;
    }
    if (Number.isFinite(mem)) {
      row.memSum += mem;
      row.memCount += 1;
    }
    if (Number.isFinite(disk)) {
      row.diskMax = row.diskMax == null ? disk : Math.max(row.diskMax, disk);
    }
    if (Number.isFinite(net)) {
      row.netSum += net;
      row.netCount += 1;
    }
    if (Number.isFinite(incidentWarn)) row.incidentWarn = incidentWarn;
    if (Number.isFinite(incidentDanger)) row.incidentDanger = incidentDanger;
    if (Number.isFinite(incidentOffline)) row.incidentOffline = incidentOffline;
  }

  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  const labels = [];
  const cpu = [];
  const mem = [];
  const disk = [];
  const net = [];
  const incidentWarn = [];
  const incidentDanger = [];
  const incidentOffline = [];
  keys.forEach((key) => {
    const row = buckets.get(key);
    labels.push(formatBucketLabel(key, mode));
    cpu.push(row.cpuCount ? Number((row.cpuSum / row.cpuCount).toFixed(2)) : null);
    mem.push(row.memCount ? Number((row.memSum / row.memCount).toFixed(2)) : null);
    disk.push(row.diskMax == null ? null : Number(row.diskMax.toFixed(2)));
    net.push(row.netCount ? Number((row.netSum / row.netCount).toFixed(2)) : null);
    incidentWarn.push(Number.isFinite(row.incidentWarn) ? row.incidentWarn : 0);
    incidentDanger.push(Number.isFinite(row.incidentDanger) ? row.incidentDanger : 0);
    incidentOffline.push(Number.isFinite(row.incidentOffline) ? row.incidentOffline : 0);
  });

  return { labels, cpu, mem, disk, net, incidentWarn, incidentDanger, incidentOffline };
}

function buildChartOption(title, labels, data, color) {
  return {
    grid: { left: 40, right: 16, top: 10, bottom: 24 },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { color: "#6b8098", fontSize: 10 },
      axisLine: { lineStyle: { color: "#1f2a38" } },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#6b8098", fontSize: 10 },
      splitLine: { lineStyle: { color: "#1f2a38" } },
    },
    tooltip: { trigger: "axis" },
    series: [
      {
        name: title,
        type: "line",
        smooth: true,
        data,
        showSymbol: false,
        lineStyle: { width: 2, color },
        areaStyle: { color: color.replace("1)", "0.2)") },
      },
    ],
  };
}

function buildIncidentChartOption(labels, warnData, dangerData, offlineData) {
  return {
    grid: { left: 40, right: 16, top: 10, bottom: 24 },
    legend: {
      top: 0,
      right: 10,
      textStyle: { color: "#8aa0b5", fontSize: 10 },
      data: ["Warn", "Danger", "Offline"],
    },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { color: "#6b8098", fontSize: 10 },
      axisLine: { lineStyle: { color: "#1f2a38" } },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      axisLabel: { color: "#6b8098", fontSize: 10 },
      splitLine: { lineStyle: { color: "#1f2a38" } },
    },
    tooltip: { trigger: "axis" },
    series: [
      {
        name: "Warn",
        type: "line",
        smooth: true,
        showSymbol: false,
        data: warnData,
        lineStyle: { width: 2, color: "rgba(250, 204, 21, 1)" },
      },
      {
        name: "Danger",
        type: "line",
        smooth: true,
        showSymbol: false,
        data: dangerData,
        lineStyle: { width: 2, color: "rgba(251, 113, 133, 1)" },
      },
      {
        name: "Offline",
        type: "line",
        smooth: true,
        showSymbol: false,
        data: offlineData,
        lineStyle: { width: 2, color: "rgba(148, 163, 184, 1)" },
      },
    ],
  };
}

function renderRiskTop(servers) {
  if (!elements.riskTopList || !elements.riskSummary) return;
  const list = (Array.isArray(servers) ? servers : [])
    .map((server) => {
      const severity = severityByMetrics(server);
      return {
        id: server.id,
        name: server.name || server.url || "-",
        severity,
        score: evaluateSeverity(server),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const severityText = {
    ok: "正常",
    warn: "警告",
    danger: "高风险",
    offline: "离线",
  };
  const severityClass = {
    ok: "ok",
    warn: "warn",
    danger: "danger",
    offline: "na",
  };

  const dangerCount = list.filter((item) => item.severity === "danger").length;
  const offlineCount = list.filter((item) => item.severity === "offline").length;
  elements.riskSummary.textContent = `高风险 ${dangerCount} / 离线 ${offlineCount}`;

  if (!list.length) {
    elements.riskTopList.innerHTML = '<div class="muted">暂无目标数据</div>';
    return;
  }

  elements.riskTopList.innerHTML = list
    .map(
      (item, index) => `
      <div class="risk-top-item">
        <div>
          <div>${index + 1}. ${escapeHtml(item.name)}</div>
          <div class="risk-top-meta">score: ${Number(item.score).toFixed(1)}</div>
        </div>
        ${makeBadge(severityClass[item.severity] || "na", severityText[item.severity] || item.severity)}
      </div>`
    )
    .join("");
}

function updateCharts() {
  const view = aggregateSeriesByBucket(state.chartBucket);
  charts.cpu.setOption(
    buildChartOption("CPU", view.labels, view.cpu, "rgba(34, 211, 238, 1)")
  );
  charts.mem.setOption(
    buildChartOption("MEM", view.labels, view.mem, "rgba(74, 222, 128, 1)")
  );
  charts.disk.setOption(
    buildChartOption("DISK", view.labels, view.disk, "rgba(250, 204, 21, 1)")
  );
  charts.net.setOption(
    buildChartOption("NET", view.labels, view.net, "rgba(251, 113, 133, 1)")
  );
  charts.incidents.setOption(
    buildIncidentChartOption(view.labels, view.incidentWarn, view.incidentDanger, view.incidentOffline)
  );
}

function pushSeries(timestamp, cpu, mem, disk, net, incidentWarn, incidentDanger, incidentOffline) {
  series.stamps.push(Number(timestamp) || Date.now());
  series.cpu.push(cpu);
  series.mem.push(mem);
  series.disk.push(disk);
  series.net.push(net);
  series.incidentWarn.push(incidentWarn);
  series.incidentDanger.push(incidentDanger);
  series.incidentOffline.push(incidentOffline);
  if (series.stamps.length > MAX_POINTS) {
    Object.keys(series).forEach((key) => {
      series[key].shift();
    });
  }
}

function calcDiskMax(items) {
  if (!Array.isArray(items) || !items.length) return null;
  let max = null;
  items.forEach((item) => {
    const value = Number(String(item.usePercent || "").replace("%", ""));
    if (Number.isFinite(value)) {
      max = max == null ? value : Math.max(max, value);
    }
  });
  return max;
}

function severityScore(value, pair) {
  if (!Number.isFinite(value)) return 0;
  if (value >= pair.danger) return 40;
  if (value >= pair.warn) return 20;
  return 0;
}

function evaluateSeverity(server) {
  if (!server.status) return 1000;
  const cpu = Number(server.metrics.cpu || 0);
  const mem = Number(server.metrics.mem || 0);
  const disk = Number(server.metrics.disk || 0);
  const failed = Number(server.metrics.failed || 0);
  let score = failed * 100;
  score += severityScore(cpu, state.alerts.cpu);
  score += severityScore(mem, state.alerts.mem);
  score += severityScore(disk, state.alerts.disk);
  return score;
}

function isAlert(server) {
  if (!server.status) return true;
  return (
    (server.metrics.failed || 0) >= state.alerts.serviceFailedDanger ||
    (server.metrics.cpu || 0) >= state.alerts.cpu.danger ||
    (server.metrics.mem || 0) >= state.alerts.mem.danger ||
    (server.metrics.disk || 0) >= state.alerts.disk.danger
  );
}

function severityByMetrics(server) {
  if (!server || !server.status) return "offline";
  const cpu = Number(server.metrics.cpu);
  const mem = Number(server.metrics.mem);
  const disk = Number(server.metrics.disk);
  const failed = Number(server.metrics.failed);
  if (Number.isFinite(failed) && failed >= state.alerts.serviceFailedDanger) return "danger";
  const levels = [levelByValue(cpu, "cpu"), levelByValue(mem, "mem"), levelByValue(disk, "disk")];
  if (levels.includes("danger")) return "danger";
  if (levels.includes("warn")) return "warn";
  return "ok";
}

function buildAlertReasonData(server) {
  if (!server || !server.status) {
    return {
      severity: "offline",
      reasons: [server?.error || "\u76ee\u6807\u4e0d\u53ef\u8fbe"],
      summary: server?.error || "\u76ee\u6807\u4e0d\u53ef\u8fbe",
      raw: { cpu: null, mem: null, disk: null, failed: null },
    };
  }
  const reasons = [];
  const cpu = Number(server.metrics.cpu);
  const mem = Number(server.metrics.mem);
  const disk = Number(server.metrics.disk);
  const failed = Number(server.metrics.failed);
  const cpuPair = metricThreshold("cpu");
  const memPair = metricThreshold("mem");
  const diskPair = metricThreshold("disk");
  if (Number.isFinite(cpu) && cpu >= cpuPair.warn) {
    reasons.push(`CPU ${cpu.toFixed(1)}% >= ${cpu >= cpuPair.danger ? cpuPair.danger : cpuPair.warn}%`);
  }
  if (Number.isFinite(mem) && mem >= memPair.warn) {
    reasons.push(`\u5185\u5b58 ${mem.toFixed(1)}% >= ${mem >= memPair.danger ? memPair.danger : memPair.warn}%`);
  }
  if (Number.isFinite(disk) && disk >= diskPair.warn) {
    reasons.push(`\u78c1\u76d8 ${disk.toFixed(1)}% >= ${disk >= diskPair.danger ? diskPair.danger : diskPair.warn}%`);
  }
  if (Number.isFinite(failed) && failed >= state.alerts.serviceFailedDanger) {
    reasons.push(`\u670d\u52a1\u6545\u969c ${failed} >= ${state.alerts.serviceFailedDanger}`);
  }
  if (!reasons.length) reasons.push("\u672a\u89e6\u53d1\u544a\u8b66\u89c4\u5219");
  return {
    severity: severityByMetrics(server),
    reasons,
    summary: reasons.join("; "),
    raw: {
      cpu: Number.isFinite(cpu) ? cpu : null,
      mem: Number.isFinite(mem) ? mem : null,
      disk: Number.isFinite(disk) ? disk : null,
      failed: Number.isFinite(failed) ? failed : null,
    },
  };
}

function persistIncidentAcks() {
  localStorage.setItem(STORAGE_KEYS.incidentAcks, JSON.stringify(state.incidentAcks || {}));
}

function persistIncidentSilences() {
  localStorage.setItem(
    STORAGE_KEYS.incidentSilences,
    JSON.stringify(state.incidentSilences || {})
  );
}

function buildIncidentCodes(server, severity) {
  if (!server || !server.status || severity === "offline") {
    return ["offline"];
  }
  const codes = [];
  const failed = Number(server.metrics?.failed);
  if (Number.isFinite(failed) && failed >= state.alerts.serviceFailedDanger) {
    codes.push("service-failed");
  }
  const cpuLevel = levelByValue(Number(server.metrics?.cpu), "cpu");
  if (cpuLevel === "danger" || cpuLevel === "warn") codes.push(`cpu-${cpuLevel}`);
  const memLevel = levelByValue(Number(server.metrics?.mem), "mem");
  if (memLevel === "danger" || memLevel === "warn") codes.push(`mem-${memLevel}`);
  const diskLevel = levelByValue(Number(server.metrics?.disk), "disk");
  if (diskLevel === "danger" || diskLevel === "warn") codes.push(`disk-${diskLevel}`);
  if (!codes.length) codes.push(severity);
  return codes;
}

function buildIncidentFingerprint(server, severity, codes) {
  const targetKey = String(server?.url || server?.name || server?.id || "")
    .trim()
    .toLowerCase();
  return `${targetKey}|${severity}|${(Array.isArray(codes) ? codes : []).join(",")}`;
}

function normalizeIncidentState(activeKeys, nowTs) {
  let ackChanged = false;
  let silenceChanged = false;

  Object.keys(state.incidentAcks || {}).forEach((key) => {
    if (!activeKeys.has(key)) {
      delete state.incidentAcks[key];
      ackChanged = true;
    }
  });
  Object.entries(state.incidentSilences || {}).forEach(([key, until]) => {
    const expiresAt = Number(until);
    if (!activeKeys.has(key) || !Number.isFinite(expiresAt) || expiresAt <= nowTs) {
      delete state.incidentSilences[key];
      silenceChanged = true;
    }
  });

  if (ackChanged) persistIncidentAcks();
  if (silenceChanged) persistIncidentSilences();
}

function incidentMetaLine(server) {
  const metadata = server?.metadata || {};
  const env = normalizeMetaValue(metadata.env);
  const business = normalizeMetaValue(metadata.business);
  const room = normalizeMetaValue(metadata.room);
  const owner = normalizeMetaValue(metadata.owner);
  const parts = [];
  if (env) parts.push(`环境:${env}`);
  if (business) parts.push(`业务:${business}`);
  if (room) parts.push(`机房:${room}`);
  if (owner) parts.push(`负责人:${owner}`);
  return parts.join(" | ");
}

function readEscalationStateByTargetUrl(targetUrl) {
  const url = String(targetUrl || "").trim();
  if (!url) return null;
  const alertState = state.alertStateByUrl.get(url);
  if (!alertState || typeof alertState !== "object") return null;
  const escalation =
    alertState.escalation && typeof alertState.escalation === "object"
      ? alertState.escalation
      : null;
  if (!escalation) return null;
  return {
    level: Math.max(0, Number(escalation.level || 0)),
    active: escalation.active === true,
    nextAt: Number(escalation.nextAt || 0),
    escalatableBindings: Math.max(0, Number(escalation.escalatableBindings || 0)),
    acked: escalation.acked === true,
  };
}

function formatEscalationCountdown(targetTs, nowTs) {
  const target = Number(targetTs);
  const now = Number(nowTs);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(now)) return "-";
  const diff = target - now;
  if (diff >= 0) return `剩余 ${formatAgeCompact(diff)}`;
  return `已超时 ${formatAgeCompact(Math.abs(diff))}`;
}

function buildEscalationText(item, nowTs) {
  if (!item?.escalation?.active) return "升级链路: 未激活";
  const level = Number(item?.escalation?.level || 0);
  const nextAt = Number(item?.escalation?.nextAt || 0);
  const bindings = Number(item?.escalation?.escalatableBindings || 0);
  if (bindings <= 0) {
    return level > 0
      ? `升级链路: 第${level}次（已达上限或未配置）`
      : "升级链路: 已激活（当前不触发升级）";
  }
  const levelText = level > 0 ? `第${level}次` : "未升级";
  const nextText = Number.isFinite(nextAt) && nextAt > 0 ? formatTime(nextAt) : "-";
  const countDown = formatEscalationCountdown(nextAt, nowTs);
  return `升级链路: ${levelText} | 下次升级 ${nextText} (${countDown})`;
}

function incidentStateSummary(item, nowTs) {
  if (item.isSilenced) {
    return `已静默 ${formatDuration(item.silencedUntil - nowTs)}`;
  }
  if (item.isAcked) return "已确认";
  return "待处理";
}

function buildIncidentActions(item) {
  const keyEncoded = encodeURIComponent(item.key);
  const actions = [
    `<button class="button incident-btn" type="button" data-incident-action="focus" data-incident-key="${keyEncoded}">定位</button>`,
  ];
  if (item.isAcked) {
    actions.push(
      `<button class="button incident-btn" type="button" data-incident-action="unack" data-incident-key="${keyEncoded}">取消确认</button>`
    );
  } else {
    actions.push(
      `<button class="button incident-btn" type="button" data-incident-action="ack" data-incident-key="${keyEncoded}">确认</button>`
    );
  }
  if (item.isSilenced) {
    actions.push(
      `<button class="button incident-btn" type="button" data-incident-action="unsilence" data-incident-key="${keyEncoded}">取消静默</button>`
    );
  } else {
    actions.push(
      `<button class="button incident-btn" type="button" data-incident-action="silence30m" data-incident-key="${keyEncoded}">静默30m</button>`
    );
  }
  return actions.join("");
}

function renderIncidentCenter(servers) {
  if (!elements.incidentList || !elements.incidentSummary) return;
  const now = Date.now();
  const severityWeight = { danger: 0, offline: 1, warn: 2 };
  const severityText = { danger: "高风险", offline: "离线", warn: "警告" };
  const severityBadge = { danger: "danger", offline: "na", warn: "warn" };

  const incidents = (Array.isArray(servers) ? servers : [])
    .map((server) => {
      const reason = buildAlertReasonData(server);
      if (reason.severity === "ok") return null;
      const codes = buildIncidentCodes(server, reason.severity);
      const key = buildIncidentFingerprint(server, reason.severity, codes);
      const targetUrl = String(server.url || "").trim();
      const backendState = targetUrl ? state.alertStateByUrl.get(targetUrl) : null;
      const backendAcked = Boolean(backendState?.ack?.acked);
      const escalation = readEscalationStateByTargetUrl(targetUrl);
      const ackedAt = Number(state.incidentAcks[key] || 0);
      const silencedUntil = Number(state.incidentSilences[key] || 0);
      const isSilenced = Number.isFinite(silencedUntil) && silencedUntil > now;
      const isAcked = backendAcked || (Number.isFinite(ackedAt) && ackedAt > 0);
      return {
        key,
        serverId: server.id,
        targetUrl,
        name: server.name || server.url || "-",
        severity: reason.severity,
        summary: reason.summary,
        metaLine: incidentMetaLine(server),
        updatedAt: Number(server.metrics?.timestamp || server.fetchedAt || now) || now,
        ackedAt,
        silencedUntil,
        isSilenced,
        isAcked,
        escalation,
      };
    })
    .filter(Boolean);

  const activeKeys = new Set(incidents.map((item) => item.key));
  normalizeIncidentState(activeKeys, now);
  incidents.forEach((item) => {
    if (!state.incidentSince.has(item.key)) {
      state.incidentSince.set(item.key, now);
    }
    item.sinceTs = state.incidentSince.get(item.key) || now;
    item.isPending = !item.isSilenced && !item.isAcked;
  });
  Array.from(state.incidentSince.keys()).forEach((key) => {
    if (!activeKeys.has(key)) state.incidentSince.delete(key);
  });

  incidents.sort((a, b) => {
    const stateOrderA = a.isPending ? 0 : a.isSilenced ? 1 : 2;
    const stateOrderB = b.isPending ? 0 : b.isSilenced ? 1 : 2;
    if (stateOrderA !== stateOrderB) return stateOrderA - stateOrderB;
    const severityDiff = (severityWeight[a.severity] ?? 99) - (severityWeight[b.severity] ?? 99);
    if (severityDiff !== 0) return severityDiff;
    return a.sinceTs - b.sinceTs;
  });
  state.incidents = incidents;

  const summary = {
    pending: incidents.filter((item) => item.isPending).length,
    danger: incidents.filter((item) => item.severity === "danger").length,
    offline: incidents.filter((item) => item.severity === "offline").length,
    warn: incidents.filter((item) => item.severity === "warn").length,
    acked: incidents.filter((item) => item.isAcked && !item.isSilenced).length,
    silenced: incidents.filter((item) => item.isSilenced).length,
    escalating: incidents.filter(
      (item) => item?.escalation?.active && Number(item?.escalation?.level || 0) > 0
    ).length,
  };
  elements.incidentSummary.textContent =
    `待处理 ${summary.pending} | 高风险 ${summary.danger} | 离线 ${summary.offline} | 警告 ${summary.warn} | 已确认 ${summary.acked} | 已静默 ${summary.silenced} | 升级中 ${summary.escalating}`;

  let filtered = incidents;
  const filter = normalizeIncidentFilter(state.incidentFilter);
  state.incidentFilter = filter;
  if (filter === "pending") filtered = incidents.filter((item) => item.isPending);
  if (filter === "danger") filtered = incidents.filter((item) => item.severity === "danger");
  if (filter === "offline") filtered = incidents.filter((item) => item.severity === "offline");
  if (filter === "warn") filtered = incidents.filter((item) => item.severity === "warn");
  if (filter === "acked") {
    filtered = incidents.filter((item) => item.isAcked && !item.isSilenced);
  }
  if (filter === "silenced") filtered = incidents.filter((item) => item.isSilenced);

  if (!filtered.length) {
    const emptyText = incidents.length
      ? "当前筛选条件下没有事件"
      : "暂无待处理事件，系统运行稳定";
    elements.incidentList.innerHTML = `<div class="muted">${escapeHtml(emptyText)}</div>`;
    return;
  }

  elements.incidentList.innerHTML = filtered
    .map((item) => {
      const stateText = incidentStateSummary(item, now);
      const escalationText = buildEscalationText(item, now);
      let escalationClass = "muted";
      if (item?.escalation?.active) {
        escalationClass =
          Number(item?.escalation?.nextAt || 0) > 0 && Number(item.escalation.nextAt) <= now
            ? "danger"
            : "warn";
      }
      return `
        <div class="incident-item">
          <div class="incident-main">
            <div class="incident-topline">
              ${makeBadge(severityBadge[item.severity] || "na", severityText[item.severity] || item.severity)}
              <span class="incident-target">${escapeHtml(item.name)}</span>
              <span class="incident-meta muted">持续 ${escapeHtml(
                formatDuration(now - item.sinceTs)
              )}</span>
              <span class="incident-meta muted">状态: ${escapeHtml(stateText)}</span>
            </div>
            <div class="incident-summary-text">${escapeHtml(item.summary)}</div>
            <div class="incident-escalation ${escapeHtml(escalationClass)}">${escapeHtml(escalationText)}</div>
            <div class="incident-meta muted">${escapeHtml(item.metaLine || "-")}</div>
          </div>
          <div class="incident-item-actions">${buildIncidentActions(item)}</div>
        </div>
      `;
    })
    .join("");
}

async function handleIncidentAction(action, encodedKey) {
  const key = decodeURIComponent(String(encodedKey || ""));
  if (!key) return;
  const incident = state.incidents.find((item) => item.key === key);
  if (!incident) return;

  if (action === "focus") {
    state.selectedServerId = incident.serverId;
    render(state.lastServers, false);
    const detailPanel = document.querySelector(".detail-panel");
    if (detailPanel) {
      detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return;
  }

  if (action === "ack") {
    state.incidentAcks[key] = Date.now();
    persistIncidentAcks();
    if (incident.targetUrl) {
      try {
        await postAlertAck(incident.targetUrl);
      } catch (error) {
        setStatus(`确认告警失败: ${error?.message || "unknown error"}`, "error");
      }
    }
  }
  if (action === "unack") {
    delete state.incidentAcks[key];
    persistIncidentAcks();
    if (incident.targetUrl) {
      try {
        await postAlertUnack(incident.targetUrl);
      } catch (error) {
        setStatus(`取消确认失败: ${error?.message || "unknown error"}`, "error");
      }
    }
  }
  if (action === "silence30m") {
    state.incidentSilences[key] = Date.now() + 30 * 60 * 1000;
    persistIncidentSilences();
  }
  if (action === "unsilence") {
    delete state.incidentSilences[key];
    persistIncidentSilences();
  }
  render(state.lastServers, false);
  if (action === "ack" || action === "unack") {
    refresh();
  }
}

function pushAlertHistory(servers) {
  servers.forEach((server) => {
    const key = server.url || server.id;
    const reason = buildAlertReasonData(server);
    const list = state.alertHistory.get(key) || [];
    const last = list[list.length - 1];
    const changed = !last ||
      last.severity !== reason.severity ||
      last.summary !== reason.summary;
    if (!changed) return;
    list.push({
      ts: Date.now(),
      severity: reason.severity,
      summary: reason.summary,
    });
    if (list.length > 20) list.shift();
    state.alertHistory.set(key, list);
  });
}

function renderRootCauseContent(server) {
  const reason = buildAlertReasonData(server);
  const history = (state.alertHistory.get(server.url || server.id) || []).slice(-3).reverse();
  const severityTextMap = {
    ok: "\u6b63\u5e38",
    warn: "\u8b66\u544a",
    danger: "\u9ad8\u98ce\u9669",
    offline: "\u79bb\u7ebf",
  };
  const severityClassMap = {
    ok: "service-text-ok",
    warn: "service-text-warn",
    danger: "service-text-fail",
    offline: "service-text-off",
  };
  const historyHtml = history.length
    ? `<ul class="tcp-list">${history
        .map(
          (item) =>
            `<li><span class="${severityClassMap[item.severity] || "service-text-muted"}">${escapeHtml(
              severityTextMap[item.severity] || item.severity
            )}</span> ${escapeHtml(item.summary)} <span class="muted">(${escapeHtml(
              formatTime(item.ts)
            )})</span></li>`
        )
        .join("")}</ul>`
    : '<div class="muted">\u65e0\u5386\u53f2\u53d8\u5316\u8bb0\u5f55</div>';
  return `
      <div>\u5f53\u524d\u72b6\u6001: <span class="${severityClassMap[reason.severity] || "service-text-muted"}">${escapeHtml(
    severityTextMap[reason.severity] || reason.severity
  )}</span></div>
      <div class="muted">\u9608\u503c: CPU ${state.alerts.cpu.warn}/${state.alerts.cpu.danger} MEM ${state.alerts.mem.warn}/${state.alerts.mem.danger} DISK ${state.alerts.disk.warn}/${state.alerts.disk.danger} SERVICE ${state.alerts.serviceFailedDanger}</div>
      <div class="muted">\u539f\u59cb\u503c: CPU ${escapeHtml(formatPercent(reason.raw.cpu))} / MEM ${escapeHtml(formatPercent(reason.raw.mem))} / DISK ${escapeHtml(formatPercent(reason.raw.disk))} / FAILED ${escapeHtml(
    reason.raw.failed == null ? "-" : String(reason.raw.failed)
  )}</div>
      <ul class="tcp-list">${reason.reasons
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul>
      <div class="muted">\u8fd1 3 \u6b21\u53d8\u5316:</div>
      ${historyHtml}`;
}

function renderSummary(servers) {
  const online = servers.filter((item) => item.status);
  if (!online.length) {
    elements.sumCpu.textContent = "-";
    elements.sumMem.textContent = "-";
    elements.sumDisk.textContent = "-";
    elements.sumNet.textContent = "-";
    elements.sumFailed.textContent = "-";
    elements.sumDocker.textContent = "-";
    return;
  }
  const avg = (arr) => arr.reduce((sum, v) => sum + v, 0) / arr.length;
  const cpuValues = online.map((s) => s.metrics.cpu).filter(Number.isFinite);
  const memValues = online.map((s) => s.metrics.mem).filter(Number.isFinite);
  const diskValues = online.map((s) => s.metrics.disk).filter(Number.isFinite);
  const netRx = online.map((s) => s.metrics.netRx).filter(Number.isFinite);
  const netTx = online.map((s) => s.metrics.netTx).filter(Number.isFinite);
  const failed = online.map((s) => s.metrics.failed).reduce((sum, v) => sum + v, 0);
  const docker = online.map((s) => s.metrics.docker).reduce((sum, v) => sum + v, 0);

  const cpuAvg = cpuValues.length ? avg(cpuValues) : null;
  const memAvg = memValues.length ? avg(memValues) : null;
  const diskMax = diskValues.length ? Math.max(...diskValues) : null;
  const netRxSum = netRx.reduce((sum, v) => sum + v, 0);
  const netTxSum = netTx.reduce((sum, v) => sum + v, 0);

  elements.sumCpu.textContent = formatPercent(cpuAvg);
  elements.sumMem.textContent = formatPercent(memAvg);
  elements.sumDisk.textContent = formatPercent(diskMax);
  elements.sumNet.textContent = `${formatBytes(netRxSum)} / ${formatBytes(netTxSum)}`;
  elements.sumFailed.textContent = String(failed);
  elements.sumDocker.textContent = String(docker);
}

function emptyRow(message) {
  return `<tr><td colspan="12" class="muted">${escapeHtml(message)}</td></tr>`;
}

function renderRowActions(server) {
  const serverId = encodeURIComponent(server?.id || "");
  return `
    <div class="row-actions">
      <button class="button row-action-btn" type="button" data-row-action="retry" data-server-id="${serverId}">重试探测</button>
      <button class="button row-action-btn" type="button" data-row-action="copy" data-server-id="${serverId}">复制诊断</button>
      <button class="button row-action-btn" type="button" data-row-action="logs" data-server-id="${serverId}">直达日志</button>
    </div>
  `;
}

function findServerById(serverId) {
  return state.lastServers.find((item) => item.id === serverId) || null;
}

async function copyTextToClipboard(text) {
  const content = String(text || "");
  if (!content) return false;
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return true;
  }
  const input = document.createElement("textarea");
  input.value = content;
  input.setAttribute("readonly", "readonly");
  input.style.position = "absolute";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  const success = document.execCommand("copy");
  document.body.removeChild(input);
  return success;
}

function buildServerDiagnosticText(server) {
  const reason = buildAlertReasonData(server);
  const now = new Date().toISOString();
  const meta = server?.metadata || {};
  const lines = [
    `时间: ${now}`,
    `目标: ${server?.name || "-"} (${server?.url || "-"})`,
    `状态级别: ${reason.severity}`,
    `摘要: ${reason.summary}`,
    `CPU: ${formatPercent(reason.raw.cpu)}`,
    `MEM: ${formatPercent(reason.raw.mem)}`,
    `DISK: ${formatPercent(reason.raw.disk)}`,
    `FAILED: ${reason.raw.failed == null ? "-" : String(reason.raw.failed)}`,
    `ENV: ${meta.env || "-"}`,
    `BUSINESS: ${meta.business || "-"}`,
    `ROOM: ${meta.room || "-"}`,
    `OWNER: ${meta.owner || "-"}`,
    `ERROR: ${server?.error || "-"}`,
    `更新: ${formatTime(server?.metrics?.timestamp || server?.fetchedAt || Date.now())}`,
  ];
  return lines.join("\n");
}

async function handleRowAction(action, encodedServerId) {
  const serverId = decodeURIComponent(String(encodedServerId || ""));
  if (!serverId) return;
  const server = findServerById(serverId);
  if (!server) {
    setStatus("目标不存在，可能已被移除", "error");
    return;
  }

  if (action === "retry") {
    setStatus(`正在探测 ${server.name} ...`, "ok");
    try {
      const result = await runDiagnostics(server.url || "");
      const first = Array.isArray(result?.data) ? result.data[0] : null;
      if (!first || first.ok) {
        setStatus(`探测完成: ${server.name} 正常`, "ok");
      } else {
        const tip = first.suggestion ? `，建议: ${first.suggestion}` : "";
        setStatus(`探测异常: ${server.name} ${first.category} (${first.message})${tip}`, "error");
      }
      refresh();
    } catch (error) {
      setStatus(`探测失败: ${error?.message || "unknown error"}`, "error");
    }
    return;
  }

  if (action === "copy") {
    try {
      const content = buildServerDiagnosticText(server);
      const ok = await copyTextToClipboard(content);
      setStatus(ok ? `已复制诊断信息: ${server.name}` : "复制失败，请检查浏览器权限", ok ? "ok" : "error");
    } catch (error) {
      setStatus(`复制失败: ${error?.message || "unknown error"}`, "error");
    }
    return;
  }

  if (action === "logs") {
    const logUrl = String(server.logUrl || "").trim();
    const baseUrl = String(server.url || "").trim();
    const targetUrl = logUrl || (baseUrl ? `${baseUrl.replace(/\/+$/, "")}/healthz` : "");
    if (!targetUrl) {
      setStatus(`未配置日志地址: ${server.name}`, "error");
      return;
    }
    window.open(targetUrl, "_blank", "noopener,noreferrer");
    setStatus(`已打开日志入口: ${server.name}`, "ok");
  }
}

function renderTable(servers) {
  if (!servers.length) {
    elements.table.innerHTML = emptyRow("\u6682\u65e0\u5339\u914d\u670d\u52a1\u5668");
    return;
  }
  elements.table.innerHTML = servers
    .map((server) => {
      const name = escapeHtml(server.name);
      const activeClass = server.id === state.selectedServerId ? "active-row" : "";
      if (!server.status) {
        return `
          <tr data-server-id="${escapeHtml(server.id)}" class="${activeClass}">
            <td>${name}</td>
            <td>${makeBadge("na", "\u79bb\u7ebf")}</td>
            <td>${makeHeat("na", "-")}</td>
            <td>${makeHeat("na", "-")}</td>
            <td>${makeHeat("na", "-")}</td>
            <td class="muted">-</td>
            <td class="muted">-</td>
            <td class="muted">-</td>
            <td class="muted">-</td>
            <td class="error-text" title="${escapeHtml(server.error || "")}">${escapeHtml(server.error || "-")}</td>
            <td>${buildUpdatedAtCell(server)}</td>
            <td>${renderRowActions(server)}</td>
          </tr>`;
      }

      const cpuLevel = levelByValue(server.metrics.cpu, "cpu");
      const memLevel = levelByValue(server.metrics.mem, "mem");
      const diskLevel = levelByValue(server.metrics.disk, "disk");
      const statusLevel =
        server.metrics.failed >= state.alerts.serviceFailedDanger ? "danger" : "ok";
      const failedNames = Array.isArray(server.metrics.failedServiceNames)
        ? server.metrics.failedServiceNames
        : [];
      const reasonText = failedNames.length
        ? `\u670d\u52a1\u6545\u969c: ${failedNames.slice(0, 2).join(", ")}${
            failedNames.length > 2 ? ` +${failedNames.length - 2}` : ""
          }`
        : "-";
      const reasonTitle = failedNames.length ? failedNames.join(", ") : "-";
      const reasonClass = failedNames.length ? "error-text" : "muted";

      return `
        <tr data-server-id="${escapeHtml(server.id)}" class="${activeClass}">
          <td>${name}</td>
          <td>${makeBadge(statusLevel, statusLevel === "ok" ? "\u6b63\u5e38" : "\u6545\u969c")}</td>
          <td>${makeHeat(cpuLevel, formatPercent(server.metrics.cpu))}</td>
          <td>${makeHeat(memLevel, formatPercent(server.metrics.mem))}</td>
          <td>${makeHeat(diskLevel, formatPercent(server.metrics.disk))}</td>
          <td>${server.metrics.load?.toFixed(2) ?? "-"}</td>
          <td>${formatBytes(server.metrics.netRx)} / ${formatBytes(server.metrics.netTx)}</td>
          <td>${server.metrics.failed}</td>
          <td>${server.metrics.docker}</td>
          <td class="${reasonClass}" title="${escapeHtml(reasonTitle)}">${escapeHtml(reasonText)}</td>
          <td>${buildUpdatedAtCell(server)}</td>
          <td>${renderRowActions(server)}</td>
        </tr>`;
    })
    .join("");
}

function renderMiniTable(headers, rows, emptyText) {
  const head = headers.map((text) => `<th>${escapeHtml(text)}</th>`).join("");
  const body = rows.length
    ? rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
        .join("")
    : `<tr><td colspan="${headers.length}" class="muted">${escapeHtml(emptyText)}</td></tr>`;
  return `
    <table class="mini-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function classifyServiceState(item) {
  if (isServiceFailure(item)) return "service-text-fail";
  const stateKey = normalizeToken(item?.active);
  if (["running", "active"].includes(stateKey)) return "service-text-ok";
  if (
    [
      "startpending",
      "start pending",
      "stoppending",
      "stop pending",
      "pausepending",
      "pause pending",
      "continuepending",
      "continue pending",
      "activating",
      "deactivating",
    ].includes(stateKey)
  ) {
    return "service-text-info";
  }
  if (
    ["stopped", "stop", "inactive", "dead", "exited", "paused", "failed"].includes(
      stateKey
    )
  ) {
    return "service-text-off";
  }
  return "service-text-muted";
}

function classifyServiceStartMode(item) {
  const startMode = normalizeToken(item?.sub);
  if (["auto", "automatic", "enabled"].includes(startMode)) return "service-text-info";
  if (["manual", "indirect"].includes(startMode)) return "service-text-warn";
  if (["disabled", "static"].includes(startMode)) return "service-text-off";
  return "service-text-muted";
}

function classifyServiceHealth(item) {
  const health = normalizeToken(item?.health);
  if (["ok", "good"].includes(health)) return "service-text-ok";
  if (["warn", "warning"].includes(health)) return "service-text-warn";
  if (["error", "degraded", "pred fail", "unknown"].includes(health)) {
    return "service-text-fail";
  }
  return "service-text-muted";
}

function renderServiceTable(items) {
  const headers = [
    "\u670d\u52a1",
    "\u72b6\u6001",
    "\u542f\u52a8\u7c7b\u578b",
    "\u5065\u5eb7",
    "\u9000\u51fa\u7801",
    "\u5224\u5b9a",
  ];
  const head = headers.map((text) => `<th>${escapeHtml(text)}</th>`).join("");
  const rows = Array.isArray(items) ? items : [];
  const body = rows.length
    ? rows
        .map((item) => {
          const verdict = isServiceFailure(item) ? "\u6545\u969c" : "\u6b63\u5e38";
          const verdictClass = isServiceFailure(item)
            ? "service-text-fail"
            : "service-text-ok";
          const exitCode = Number.isFinite(Number(item?.exitCode))
            ? String(Number(item.exitCode))
            : "-";
          return `<tr>
            <td class="${verdictClass}">${escapeHtml(item?.name || "-")}</td>
            <td><span class="${classifyServiceState(item)}">${escapeHtml(
              localizeServiceState(item?.active)
            )}</span></td>
            <td><span class="${classifyServiceStartMode(item)}">${escapeHtml(
              localizeServiceStartMode(item?.sub)
            )}</span></td>
            <td><span class="${classifyServiceHealth(item)}">${escapeHtml(
              localizeServiceHealth(item?.health)
            )}</span></td>
            <td class="service-text-muted">${escapeHtml(exitCode)}</td>
            <td><span class="${verdictClass}">${escapeHtml(verdict)}</span></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="${headers.length}" class="muted">\u65e0\u670d\u52a1\u6570\u636e</td></tr>`;

  return `
    <table class="mini-table service-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderMetadataContent(server) {
  const metadata = normalizeMetadata(server?.metadata || {});
  const rows = [
    ["环境", metadata.env || "-"],
    ["业务", metadata.business || "-"],
    ["机房", metadata.room || "-"],
    ["负责人", metadata.owner || "-"],
  ];
  return renderMiniTable(["字段", "值"], rows, "无标签数据");
}

function renderDetail(server) {
  if (!elements.detailBody || !elements.detailTarget) return;
  if (!server) {
    elements.detailTarget.textContent = "\u672a\u9009\u62e9\u670d\u52a1\u5668";
    elements.detailTarget.className = "detail-target muted";
    elements.detailBody.className = "detail-body muted";
    elements.detailBody.textContent = "\u70b9\u51fb\u4e0a\u65b9\u4efb\u610f\u670d\u52a1\u5668\u884c\u67e5\u770b\u8be6\u60c5";
    return;
  }

  elements.detailTarget.textContent = server.name;
  elements.detailTarget.className = "detail-target";

  if (!server.status) {
    elements.detailBody.className = "detail-body";
    const unreachableContent = `
      <div class="error-text">${escapeHtml(server.error || "unknown error")}</div>
      <div class="muted">最后检查: ${escapeHtml(formatTime(server.fetchedAt))}</div>`;
    elements.detailBody.innerHTML = `
      <div class="detail-sections">
        ${renderCollapsibleDetailBlock("unreachable", "目标不可达", unreachableContent, {
          summary: `检查时间 ${formatTime(server.fetchedAt)}`,
          defaultCollapsed: false,
        })}
        ${renderCollapsibleDetailBlock("root-cause", "故障原因详情", renderRootCauseContent(server), {
          defaultCollapsed: false,
        })}
        ${renderCollapsibleDetailBlock("metadata", "目标标签", renderMetadataContent(server), {
          defaultCollapsed: true,
        })}
      </div>
    `;
    return;
  }

  const status = server.status;
  const diskItems = Array.isArray(status.disk?.items) ? status.disk.items.slice(0, 8) : [];
  const serviceItems = Array.isArray(status.services?.items)
    ? status.services.items.slice(0, 8)
    : [];
  const serviceFailures = getServiceFailures(status);
  const dockerContainers = Array.isArray(status.docker?.containers)
    ? status.docker.containers.slice(0, 8)
    : [];
  const tcpStates = Object.entries(status.network?.tcpStates || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const diskTable = renderMiniTable(
    ["\u6302\u8f7d\u70b9", "\u5360\u7528", "\u5bb9\u91cf"],
    diskItems.map((item) => [item.mount || "-", item.usePercent || "-", `${item.used}/${item.size}`]),
    "\u65e0\u78c1\u76d8\u6570\u636e"
  );

  const serviceTable = renderServiceTable(serviceItems);

  const dockerTable = renderMiniTable(
    ["\u5bb9\u5668", "\u72b6\u6001", "\u955c\u50cf"],
    dockerContainers.map((item) => [item.name || "-", item.status || "-", item.image || "-"]),
    "\u65e0 Docker \u6570\u636e"
  );

  const systemTable = renderMiniTable(
    ["\u5b57\u6bb5", "\u503c"],
    [
      ["\u4e3b\u673a\u540d", status.system?.hostname || "-"],
      ["\u7cfb\u7edf", `${status.system?.platform || "-"} ${status.system?.release || ""}`.trim()],
      ["\u67b6\u6784", status.system?.arch || "-"],
      ["Node", status.process?.node || "-"],
      ["\u8d1f\u8f7d(1m)", Array.isArray(status.system?.loadAvg) ? String(status.system.loadAvg[0] ?? "-") : "-"],
      ["\u672c\u5730\u65f6\u95f4", status.system?.localTime || "-"],
    ],
    "\u65e0\u7cfb\u7edf\u6570\u636e"
  );

  const tcpList = tcpStates.length
    ? `<ul class="tcp-list">${tcpStates
        .map(([name, count]) => `<li>${escapeHtml(localizeTcpState(name))}: ${escapeHtml(String(count))}</li>`)
        .join("")}</ul>`
    : '<div class="muted">\u65e0 TCP \u72b6\u6001\u6570\u636e</div>';
  const serviceFailureList = serviceFailures.length
    ? `<ul class="tcp-list">${serviceFailures
        .slice(0, 10)
        .map(
          (item) =>
            `<li>${escapeHtml(item.name || "-")}: ${escapeHtml(buildServiceFailureReason(item))}</li>`
        )
        .join("")}</ul>`
    : '<div class="muted">\u672a\u53d1\u73b0\u670d\u52a1\u6545\u969c</div>';
  const serviceLegend = `
      <div class="service-legend">
        <span class="service-text-ok">正常</span>
        <span class="service-text-fail">故障</span>
        <span class="service-text-info">过渡状态</span>
        <span class="service-text-warn">手动/警告</span>
        <span class="service-text-off">停止/禁用</span>
      </div>`;

  elements.detailBody.className = "detail-body";
  elements.detailBody.innerHTML = `
    <div class="detail-grid">
      <div class="detail-card" data-detail-card="cpu">
        <div class="detail-card-title">CPU</div>
        <div class="detail-card-value">${escapeHtml(formatPercent(server.metrics.cpu))}</div>
      </div>
      <div class="detail-card" data-detail-card="mem">
        <div class="detail-card-title">\u5185\u5b58</div>
        <div class="detail-card-value">${escapeHtml(formatPercent(server.metrics.mem))}</div>
      </div>
      <div class="detail-card" data-detail-card="disk">
        <div class="detail-card-title">\u78c1\u76d8\u5cf0\u503c</div>
        <div class="detail-card-value">${escapeHtml(formatPercent(server.metrics.disk))}</div>
      </div>
      <div class="detail-card" data-detail-card="uptime">
        <div class="detail-card-title">\u8fd0\u884c\u65f6\u957f</div>
        <div class="detail-card-value">${escapeHtml(formatUptime(status.system?.uptimeSec))}</div>
      </div>
    </div>
    <div class="detail-sections">
      ${renderCollapsibleDetailBlock("root-cause", "故障原因详情", renderRootCauseContent(server), {
        defaultCollapsed: false,
      })}
      ${renderCollapsibleDetailBlock("services", "服务状态", `${serviceLegend}${serviceTable}`, {
        summary: `运行 ${status.services?.running ?? 0} / 故障 ${status.services?.failed ?? 0}`,
        defaultCollapsed: false,
      })}
      ${renderCollapsibleDetailBlock("service-failures", "故障定位", serviceFailureList, {
        summary: `故障项 ${serviceFailures.length}`,
        defaultCollapsed: false,
      })}
      ${renderCollapsibleDetailBlock("metadata", "目标标签", renderMetadataContent(server), {
        defaultCollapsed: true,
      })}
      ${renderCollapsibleDetailBlock("system", "系统信息", systemTable, {
        defaultCollapsed: true,
      })}
      ${renderCollapsibleDetailBlock("disk", "磁盘分区", diskTable, {
        summary: `分区 ${diskItems.length}`,
        defaultCollapsed: true,
      })}
      ${renderCollapsibleDetailBlock("docker", "Docker 容器", dockerTable, {
        summary: `running ${status.docker?.running ?? 0}`,
        defaultCollapsed: true,
      })}
      ${renderCollapsibleDetailBlock("tcp", "TCP 状态", tcpList, {
        summary: `状态类型 ${tcpStates.length}`,
        defaultCollapsed: true,
      })}
    </div>`;
}
function mapServer(entry, index) {
  const id = String(entry?.url || entry?.name || `target-${index}`) + `#${index}`;
  const metadata = normalizeMetadata(entry?.metadata || entry?.tags || entry || {});
  const logUrl = normalizeMetaValue(entry?.logUrl || entry?.metadata?.logUrl || entry?.tags?.logUrl);
  if (!entry || !entry.status) {
    return {
      id,
      url: entry?.url || "",
      name: entry?.name || entry?.url || "-",
      logUrl,
      metadata,
      status: null,
      fetchedAt: entry?.fetchedAt,
      error: entry?.error || "\u76ee\u6807\u4e0d\u53ef\u8fbe",
      metrics: {},
    };
  }
  const status = entry.status;
  const diskMax = calcDiskMax(status.disk?.items);
  const failedServiceNames = getServiceFailures(status)
    .map((item) => String(item?.name || "").trim())
    .filter(Boolean);
  return {
    id,
    url: entry.url || "",
    name: entry.name || status.system?.hostname || entry.url,
    logUrl,
    metadata,
    status,
    fetchedAt: entry.fetchedAt,
    error: null,
    metrics: {
      timestamp: status.timestamp,
      cpu: status.cpu?.usagePercent ?? null,
      mem: status.memory?.usagePercent ?? null,
      disk: diskMax,
      load: Array.isArray(status.system?.loadAvg) ? status.system.loadAvg[0] : null,
      netRx: status.network?.rxBytesSec ?? null,
      netTx: status.network?.txBytesSec ?? null,
      failed: status.services?.failed ?? 0,
      failedServiceNames,
      docker: status.docker?.running ?? 0,
    },
  };
}

async function fetchStatus() {
  const res = await fetch("/api/targets/status");
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchAlertsState() {
  const pageSize = 500;
  let page = 1;
  let totalPages = 1;
  const merged = [];
  while (page <= totalPages && page <= 20) {
    const res = await fetch(`/api/alerts/state?page=${page}&pageSize=${pageSize}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.message || `HTTP ${res.status}`);
    }
    const list = Array.isArray(data?.data) ? data.data : [];
    merged.push(...list);
    const pagination = data?.pagination && typeof data.pagination === "object" ? data.pagination : {};
    totalPages = Number(pagination.totalPages || 1);
    if (!Number.isFinite(totalPages) || totalPages < 1) totalPages = 1;
    page += 1;
  }
  return merged;
}

function setAlertStateMap(items) {
  const next = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const url = String(item?.url || "").trim();
    if (!url) return;
    next.set(url, item);
  });
  state.alertStateByUrl = next;
}

async function postAlertAck(targetUrl) {
  const res = await fetch("/api/alerts/acks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  return data;
}

async function postAlertUnack(targetUrl) {
  const res = await fetch("/api/alerts/unack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  return data;
}

async function fetchSettings() {
  const res = await fetch("/api/settings");
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data?.data || null;
}

function getHistoryPreset(bucket) {
  const normalized = normalizeChartBucket(bucket);
  return HISTORY_RANGE_PRESET[normalized] || HISTORY_RANGE_PRESET["1m"];
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeHistorySeries(seriesData) {
  const source = seriesData && typeof seriesData === "object" ? seriesData : {};
  const stamps = Array.isArray(source.timestampsMs)
    ? source.timestampsMs.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    : [];
  const mapByLength = (arr) => {
    const input = Array.isArray(arr) ? arr : [];
    return stamps.map((_, index) => toNumberOrNull(input[index]));
  };
  return {
    stamps,
    cpu: mapByLength(source.cpu),
    mem: mapByLength(source.mem),
    disk: mapByLength(source.disk),
    net: mapByLength(source.net),
  };
}

function applyHistorySeries(seriesData) {
  const normalized = normalizeHistorySeries(seriesData);
  if (!normalized.stamps.length) return false;
  series.stamps = normalized.stamps.slice(-MAX_POINTS);
  series.cpu = normalized.cpu.slice(-MAX_POINTS);
  series.mem = normalized.mem.slice(-MAX_POINTS);
  series.disk = normalized.disk.slice(-MAX_POINTS);
  series.net = normalized.net.slice(-MAX_POINTS);
  series.incidentWarn = series.stamps.map(() => 0);
  series.incidentDanger = series.stamps.map(() => 0);
  series.incidentOffline = series.stamps.map(() => 0);
  return true;
}

async function fetchHistorySummary(bucket) {
  const preset = getHistoryPreset(bucket);
  const params = new URLSearchParams();
  params.set("range", preset.range);
  params.set("step", preset.step);
  const res = await fetch(`/api/history/summary?${params.toString()}`);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.message || `HTTP ${res.status}`);
  }
  return payload?.data || null;
}

async function reloadHistoryForBucket(bucket, options = {}) {
  if (!state.history.enabled) return false;
  const silent = options.silent === true;
  try {
    const history = await fetchHistorySummary(bucket);
    const applied = applyHistorySeries(history?.series);
    if (!applied) return false;
    state.history.lastLoadedBucket = normalizeChartBucket(bucket);
    state.history.lastLoadedAt = Date.now();
    updateCharts();
    if (!silent) {
      setStatus(`已加载历史趋势: ${history?.range || "-"} / ${history?.step || "-"}`, "ok");
    }
    return true;
  } catch (error) {
    if (!silent) {
      setStatus(`历史趋势加载失败，已使用实时数据: ${error?.message || "unknown error"}`, "error");
    }
    return false;
  }
}

async function runDiagnostics(targetUrl = "") {
  const body = targetUrl ? { targetUrl } : {};
  const res = await fetch("/api/targets/diagnose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  return data;
}

function applyFilterAndSort(servers) {
  const keyword = state.search.trim().toLowerCase();
  let result = [...servers];

  if (state.filterStatus === "online") {
    result = result.filter((item) => !!item.status);
  } else if (state.filterStatus === "offline") {
    result = result.filter((item) => !item.status);
  } else if (state.filterStatus === "alert") {
    result = result.filter((item) => isAlert(item));
  }

  if (state.filterEnv) {
    result = result.filter((item) => normalizeMetaValue(item?.metadata?.env) === state.filterEnv);
  }
  if (state.filterBusiness) {
    result = result.filter(
      (item) => normalizeMetaValue(item?.metadata?.business) === state.filterBusiness
    );
  }
  if (state.filterRoom) {
    result = result.filter((item) => normalizeMetaValue(item?.metadata?.room) === state.filterRoom);
  }
  if (state.filterOwner) {
    result = result.filter((item) => normalizeMetaValue(item?.metadata?.owner) === state.filterOwner);
  }

  if (keyword) {
    result = result.filter((item) => {
      const fields = [
        String(item.name || ""),
        String(item.url || ""),
        String(item?.metadata?.env || ""),
        String(item?.metadata?.business || ""),
        String(item?.metadata?.room || ""),
        String(item?.metadata?.owner || ""),
      ]
        .join(" ")
        .toLowerCase();
      return fields.includes(keyword);
    });
  }

  result.sort((a, b) => {
    if (state.sortBy === "name") return String(a.name).localeCompare(String(b.name));
    if (state.sortBy === "cpu") return (b.metrics?.cpu || -1) - (a.metrics?.cpu || -1);
    if (state.sortBy === "mem") return (b.metrics?.mem || -1) - (a.metrics?.mem || -1);
    if (state.sortBy === "disk") return (b.metrics?.disk || -1) - (a.metrics?.disk || -1);
    return evaluateSeverity(b) - evaluateSeverity(a);
  });

  return result;
}

function updateTimers() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  if (!state.autoRefresh) return;
  state.timerId = setInterval(() => {
    refresh();
  }, state.refreshMs);
}

function syncIntervalControl() {
  if (!elements.intervalSelect) return;
  elements.intervalSelect.innerHTML = state.refreshOptionsMs
    .map((ms) => `<option value="${ms}">${ms / 1000}s</option>`)
    .join("");
  const found = state.refreshOptionsMs.includes(state.refreshMs);
  if (!found) {
    state.refreshMs = state.refreshOptionsMs[0] || DEFAULT_REFRESH_MS;
  }
  elements.intervalSelect.value = String(state.refreshMs);
}

function pickSelectedServer(visibleServers) {
  if (!state.selectedServerId && visibleServers.length) {
    state.selectedServerId = visibleServers[0].id;
  }
  return (
    state.lastServers.find((item) => item.id === state.selectedServerId) ||
    visibleServers[0] ||
    null
  );
}

function render(servers, appendSeries = false) {
  syncMetaFilterControls(servers);
  const visibleServers = applyFilterAndSort(servers);
  state.visibleServers = visibleServers;
  const selected = pickSelectedServer(visibleServers);
  renderTable(visibleServers);
  setTableSummary(visibleServers);
  updateQuickFilterButtons();
  renderSummary(visibleServers);
  setFreshnessSummary(servers);
  renderRiskTop(visibleServers);
  renderIncidentCenter(servers);
  setMetaSummary(visibleServers);
  renderDetail(selected);
  applyDetailTabVisibility();

  if (!appendSeries) return;
  // Keep chart trends stable even when table filters/search hide some rows.
  const online = servers.filter((item) => item.status && item.metrics.cpu != null);
  const avg = (arr) => arr.reduce((sum, v) => sum + v, 0) / arr.length;
  const cpuAvg = online.length ? avg(online.map((s) => s.metrics.cpu)) : null;
  const memAvg = online.length ? avg(online.map((s) => s.metrics.mem)) : null;
  const diskMax = online.length ? Math.max(...online.map((s) => s.metrics.disk || 0)) : null;
  const netSum = online.reduce((sum, s) => sum + (s.metrics.netRx || 0) + (s.metrics.netTx || 0), 0);
  const incidentWarn = servers.filter((item) => severityByMetrics(item) === "warn").length;
  const incidentDanger = servers.filter((item) => severityByMetrics(item) === "danger").length;
  const incidentOffline = servers.filter((item) => severityByMetrics(item) === "offline").length;
  pushSeries(
    Date.now(),
    cpuAvg,
    memAvg,
    diskMax,
    netSum,
    incidentWarn,
    incidentDanger,
    incidentOffline
  );
  updateCharts();
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  setStatus("\u6b63\u5728\u62c9\u53d6\u6700\u65b0\u72b6\u6001...", "ok");
  try {
    const [raw, alertStates] = await Promise.all([
      fetchStatus(),
      fetchAlertsState().catch(() => null),
    ]);
    if (Array.isArray(alertStates)) {
      setAlertStateMap(alertStates);
    }
    state.lastServers = raw.map((entry, index) => mapServer(entry, index));
    pushAlertHistory(state.lastServers);
    render(state.lastServers, true);
    setLastUpdated(Date.now());
    setStatus(`\u5237\u65b0\u6210\u529f\uff0c\u76ee\u6807\u6570: ${state.lastServers.length}`, "ok");
  } catch (error) {
    if (state.lastServers.length) {
      render(state.lastServers, false);
    }
    setStatus(`\u5237\u65b0\u5931\u8d25: ${error?.message || "unknown error"}`, "error");
  } finally {
    state.refreshing = false;
  }
}

function bindControls() {
  if (elements.intervalSelect) {
    elements.intervalSelect.addEventListener("change", (event) => {
      state.refreshMs = Number(event.target.value) || DEFAULT_REFRESH_MS;
      localStorage.setItem(STORAGE_KEYS.refreshMs, String(state.refreshMs));
      updateTimers();
    });
  }

  if (elements.autoRefresh) {
    elements.autoRefresh.checked = state.autoRefresh;
    elements.autoRefresh.addEventListener("change", (event) => {
      state.autoRefresh = !!event.target.checked;
      localStorage.setItem(STORAGE_KEYS.autoRefresh, String(state.autoRefresh));
      updateTimers();
    });
  }

  if (elements.filterStatus) {
    elements.filterStatus.value = state.filterStatus;
    elements.filterStatus.addEventListener("change", (event) => {
      setFilterStatusAndRender(event.target.value);
    });
  }

  TARGET_META_FIELDS.forEach((field) => {
    const el = getMetaFilterElement(field);
    if (!el) return;
    el.value = getMetaFilterState(field);
    el.addEventListener("change", (event) => {
      const value = normalizeMetaValue(event.target.value);
      setMetaFilterState(field, value);
      const storageKey = getMetaStorageKey(field);
      if (storageKey) localStorage.setItem(storageKey, value);
      markViewAsCustom();
      render(state.lastServers, false);
    });
  });

  if (elements.sortBy) {
    elements.sortBy.value = state.sortBy;
    elements.sortBy.addEventListener("change", (event) => {
      state.sortBy = String(event.target.value || "severity");
      localStorage.setItem(STORAGE_KEYS.sortBy, state.sortBy);
      markViewAsCustom();
      render(state.lastServers, false);
    });
  }

  if (elements.fontSize) {
    elements.fontSize.value = normalizeFontSize(state.fontSize);
    elements.fontSize.addEventListener("change", (event) => {
      state.fontSize = normalizeFontSize(event.target.value);
      localStorage.setItem(STORAGE_KEYS.fontSize, state.fontSize);
      applyFontSize();
    });
  }

  if (elements.workMode) {
    elements.workMode.value = normalizeWorkMode(state.workMode);
    elements.workMode.addEventListener("change", (event) => {
      state.workMode = normalizeWorkMode(event.target.value);
      localStorage.setItem(STORAGE_KEYS.workMode, state.workMode);
      applyWorkMode();
    });
  }

  if (elements.layoutModeToggle) {
    elements.layoutModeToggle.addEventListener("click", () => {
      state.layoutMode = state.layoutMode === "compact" ? "wide" : "compact";
      localStorage.setItem(STORAGE_KEYS.layoutMode, state.layoutMode);
      applyLayoutMode();
    });
  }

  if (elements.topControlsToggle) {
    elements.topControlsToggle.addEventListener("click", () => {
      state.topControlsCollapsed = !state.topControlsCollapsed;
      persistTopControlsCollapsedState();
      applyTopControlsCollapsedState();
    });
  }

  if (elements.chartBucket) {
    elements.chartBucket.value = normalizeChartBucket(state.chartBucket);
    elements.chartBucket.addEventListener("change", async (event) => {
      state.chartBucket = normalizeChartBucket(event.target.value);
      localStorage.setItem(STORAGE_KEYS.chartBucket, state.chartBucket);
      const loaded = await reloadHistoryForBucket(state.chartBucket, { silent: true });
      if (!loaded) updateCharts();
    });
  }

  if (elements.incidentFilter) {
    elements.incidentFilter.value = normalizeIncidentFilter(state.incidentFilter);
    elements.incidentFilter.addEventListener("change", (event) => {
      state.incidentFilter = normalizeIncidentFilter(event.target.value);
      localStorage.setItem(STORAGE_KEYS.incidentFilter, state.incidentFilter);
      renderIncidentCenter(state.lastServers);
    });
  }

  if (elements.incidentClearBtn) {
    elements.incidentClearBtn.addEventListener("click", () => {
      state.incidentAcks = {};
      persistIncidentAcks();
      render(state.lastServers, false);
    });
  }

  if (elements.incidentList) {
    elements.incidentList.addEventListener("click", (event) => {
      const actionBtn = event.target.closest("button[data-incident-action]");
      if (!actionBtn) return;
      const action = String(actionBtn.dataset.incidentAction || "").trim();
      const key = String(actionBtn.dataset.incidentKey || "").trim();
      if (!action || !key) return;
      handleIncidentAction(action, key).catch((error) => {
        setStatus(`事件操作失败: ${error?.message || "unknown error"}`, "error");
      });
    });
  }

  if (elements.searchInput) {
    elements.searchInput.value = state.search;
    elements.searchInput.addEventListener("input", (event) => {
      state.search = String(event.target.value || "");
      markViewAsCustom();
      render(state.lastServers, false);
    });
  }

  if (elements.tableQuickAll) {
    elements.tableQuickAll.addEventListener("click", () => {
      setFilterStatusAndRender("all");
    });
  }

  if (elements.tableQuickAlert) {
    elements.tableQuickAlert.addEventListener("click", () => {
      setFilterStatusAndRender("alert");
    });
  }

  if (elements.tableQuickOnline) {
    elements.tableQuickOnline.addEventListener("click", () => {
      setFilterStatusAndRender("online");
    });
  }

  if (elements.tableClearSearch) {
    elements.tableClearSearch.addEventListener("click", () => {
      state.search = "";
      if (elements.searchInput) elements.searchInput.value = "";
      markViewAsCustom();
      render(state.lastServers, false);
    });
  }

  if (elements.savedViewSelect) {
    elements.savedViewSelect.addEventListener("change", (event) => {
      const viewId = String(event.target.value || "").trim();
      if (!viewId) {
        markViewAsCustom();
        return;
      }
      activateSavedView(viewId);
    });
  }

  if (elements.savedViewSaveBtn) {
    elements.savedViewSaveBtn.addEventListener("click", () => {
      saveCurrentAsView();
    });
  }

  if (elements.savedViewDeleteBtn) {
    elements.savedViewDeleteBtn.addEventListener("click", () => {
      deleteActiveView();
    });
  }

  if (elements.savedViewResetBtn) {
    elements.savedViewResetBtn.addEventListener("click", () => {
      resetFiltersToDefault();
    });
  }

  if (elements.refreshBtn) {
    elements.refreshBtn.addEventListener("click", () => {
      refresh();
    });
  }

  if (elements.diagnoseBtn) {
    elements.diagnoseBtn.addEventListener("click", async () => {
      if (state.refreshing) return;
      setStatus("\u6b63\u5728\u6267\u884c\u8fde\u63a5\u8bca\u65ad...", "ok");
      try {
        const result = await runDiagnostics();
        const failed = (Array.isArray(result.data) ? result.data : []).filter((item) => !item.ok);
        if (!failed.length) {
          setStatus(`\u8bca\u65ad\u5b8c\u6210\uff0c${result.summary?.total || 0} \u4e2a\u76ee\u6807\u5747\u6b63\u5e38`, "ok");
          return;
        }
        const top = failed
          .slice(0, 3)
          .map((item) => `${item.name}: ${item.category} (${item.message})`)
          .join(" | ");
        setStatus(`\u8bca\u65ad\u5b8c\u6210\uff0c\u5f02\u5e38 ${failed.length} \u9879: ${top}`, "error");
        console.table(
          failed.map((item) => ({
            name: item.name,
            category: item.category,
            status: item.httpStatus,
            latencyMs: item.latencyMs,
            suggestion: item.suggestion,
          }))
        );
      } catch (error) {
        setStatus(`\u8bca\u65ad\u5931\u8d25: ${error?.message || "unknown error"}`, "error");
      }
    });
  }

  if (elements.detailExpandAllBtn) {
    elements.detailExpandAllBtn.addEventListener("click", () => {
      setAllDetailSectionsCollapsed(false);
      renderDetail(getCurrentSelectedServer());
      applyDetailTabVisibility();
    });
  }

  if (elements.detailCollapseAllBtn) {
    elements.detailCollapseAllBtn.addEventListener("click", () => {
      setAllDetailSectionsCollapsed(true);
      renderDetail(getCurrentSelectedServer());
      applyDetailTabVisibility();
    });
  }

  [
    elements.detailTabOverview,
    elements.detailTabAlerts,
    elements.detailTabSystem,
  ].forEach((button) => {
    if (!button) return;
    button.addEventListener("click", () => {
      applyDetailTab(button.dataset.detailTab);
    });
  });

  if (elements.detailBody) {
    elements.detailBody.addEventListener("click", (event) => {
      const toggleBtn = event.target.closest("button[data-detail-toggle-key]");
      if (!toggleBtn) return;
      const sectionKey = String(toggleBtn.dataset.detailToggleKey || "").trim();
      if (!sectionKey) return;
      const nextCollapsed = !isDetailSectionCollapsed(sectionKey, false);
      setDetailSectionCollapsed(sectionKey, nextCollapsed);
      renderDetail(getCurrentSelectedServer());
    });
  }

  if (elements.table) {
    elements.table.addEventListener("click", async (event) => {
      const actionBtn = event.target.closest("button[data-row-action]");
      if (actionBtn) {
        const action = String(actionBtn.dataset.rowAction || "").trim();
        const serverId = String(actionBtn.dataset.serverId || "").trim();
        if (!action || !serverId) return;
        await handleRowAction(action, serverId);
        return;
      }
      const row = event.target.closest("tr[data-server-id]");
      if (!row) return;
      state.selectedServerId = row.dataset.serverId || "";
      render(state.lastServers, false);
    });
  }
}

async function bootstrapSettings() {
  const settings = await fetchSettings().catch(() => null);
  if (!settings) {
    state.alerts = cloneAlerts(DEFAULT_ALERTS);
    syncIntervalControl();
    setAlertConfigText();
    return;
  }

  state.alerts = normalizeAlerts(settings.alerts);
  if (Array.isArray(settings.refreshOptionsMs) && settings.refreshOptionsMs.length) {
    const options = settings.refreshOptionsMs
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item >= 1000);
    if (options.length) state.refreshOptionsMs = options;
  }
  if (settings.targetMetadata && typeof settings.targetMetadata === "object") {
    const options = settings.targetMetadata.options || {};
    state.targetMetadata = {
      options: {
        env: Array.isArray(options.env) ? options.env.map(normalizeMetaValue).filter(Boolean) : [],
        business: Array.isArray(options.business)
          ? options.business.map(normalizeMetaValue).filter(Boolean)
          : [],
        room: Array.isArray(options.room) ? options.room.map(normalizeMetaValue).filter(Boolean) : [],
        owner: Array.isArray(options.owner) ? options.owner.map(normalizeMetaValue).filter(Boolean) : [],
      },
    };
  }
  if (settings.history && typeof settings.history === "object") {
    state.history.enabled = settings.history.enabled === true;
    state.history.backend = String(settings.history.backend || "unknown");
  } else {
    state.history.enabled = false;
    state.history.backend = "none";
  }
  syncIntervalControl();
  setAlertConfigText();
}

window.addEventListener("resize", () => {
  Object.values(charts).forEach((chart) => chart.resize());
});

async function start() {
  state.fontSize = normalizeFontSize(state.fontSize);
  state.workMode = normalizeWorkMode(state.workMode);
  state.layoutMode = normalizeLayoutMode(state.layoutMode);
  state.chartBucket = normalizeChartBucket(state.chartBucket);
  state.incidentFilter = normalizeIncidentFilter(state.incidentFilter);
  state.detailTab = normalizeDetailTab(state.detailTab);
  const activeView = findSavedViewById(state.activeSavedViewId);
  if (activeView) {
    applyViewFilters(activeView.filters);
  } else {
    state.activeSavedViewId = "";
  }
  applyFontSize();
  applyWorkMode();
  applyLayoutMode();
  applyTopControlsCollapsedState();
  applyDetailTabControls();
  updateQuickFilterButtons();
  syncSavedViewControls();
  bindControls();
  await bootstrapSettings();
  const loadedHistory = await reloadHistoryForBucket(state.chartBucket, { silent: true });
  if (!loadedHistory) {
    updateCharts();
  }
  render([], false);
  refresh();
  updateTimers();
}

start();
