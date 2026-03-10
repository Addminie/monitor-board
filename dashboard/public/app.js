const DEFAULT_REFRESH_MS = 5000;
// Keep roughly 24h points under 5s refresh.
const MAX_POINTS = 17280;
const CHART_BUCKET_MS = {
  "1m": 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};
const DEFAULT_ALERTS = {
  cpu: { warn: 85, danger: 95 },
  mem: { warn: 85, danger: 95 },
  disk: { warn: 80, danger: 90 },
  serviceFailedDanger: 1,
};

const STORAGE_KEYS = {
  refreshMs: "monitor.refreshMs",
  autoRefresh: "monitor.autoRefresh",
  filterStatus: "monitor.filterStatus",
  sortBy: "monitor.sortBy",
  fontSize: "monitor.fontSize",
  chartBucket: "monitor.chartBucket",
};

const state = {
  refreshMs: Number(localStorage.getItem(STORAGE_KEYS.refreshMs) || DEFAULT_REFRESH_MS),
  autoRefresh: localStorage.getItem(STORAGE_KEYS.autoRefresh) !== "false",
  filterStatus: localStorage.getItem(STORAGE_KEYS.filterStatus) || "all",
  sortBy: localStorage.getItem(STORAGE_KEYS.sortBy) || "severity",
  fontSize: localStorage.getItem(STORAGE_KEYS.fontSize) || "medium",
  chartBucket: localStorage.getItem(STORAGE_KEYS.chartBucket) || "1m",
  search: "",
  timerId: null,
  refreshing: false,
  lastServers: [],
  visibleServers: [],
  selectedServerId: "",
  alerts: { ...DEFAULT_ALERTS },
  refreshOptionsMs: [5000, 10000, 30000, 60000],
};

const elements = {
  refreshBtn: document.getElementById("refresh-btn"),
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
  searchInput: document.getElementById("search-input"),
  sortBy: document.getElementById("sort-by"),
  fontSize: document.getElementById("font-size"),
  chartBucket: document.getElementById("chart-bucket"),
  fetchStatus: document.getElementById("fetch-status"),
  alertConfig: document.getElementById("alert-config"),
  lastUpdated: document.getElementById("last-updated"),
  detailTarget: document.getElementById("detail-target"),
  detailBody: document.getElementById("detail-body"),
};

const charts = {
  cpu: echarts.init(document.getElementById("chart-cpu")),
  mem: echarts.init(document.getElementById("chart-mem")),
  disk: echarts.init(document.getElementById("chart-disk")),
  net: echarts.init(document.getElementById("chart-net")),
};

const series = {
  stamps: [],
  cpu: [],
  mem: [],
  disk: [],
  net: [],
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

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeFontSize(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["small", "medium", "large"].includes(normalized)) return normalized;
  return "medium";
}

function normalizeChartBucket(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CHART_BUCKET_MS, normalized)) {
    return normalized;
  }
  return "1m";
}

function applyFontSize() {
  const mode = normalizeFontSize(state.fontSize);
  state.fontSize = mode;
  if (!document.body) return;
  document.body.dataset.fontSize = mode;
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
      });
    }
    const row = buckets.get(key);
    const cpu = Number(series.cpu[i]);
    const mem = Number(series.mem[i]);
    const disk = Number(series.disk[i]);
    const net = Number(series.net[i]);
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
  }

  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  const labels = [];
  const cpu = [];
  const mem = [];
  const disk = [];
  const net = [];
  keys.forEach((key) => {
    const row = buckets.get(key);
    labels.push(formatBucketLabel(key, mode));
    cpu.push(row.cpuCount ? Number((row.cpuSum / row.cpuCount).toFixed(2)) : null);
    mem.push(row.memCount ? Number((row.memSum / row.memCount).toFixed(2)) : null);
    disk.push(row.diskMax == null ? null : Number(row.diskMax.toFixed(2)));
    net.push(row.netCount ? Number((row.netSum / row.netCount).toFixed(2)) : null);
  });

  return { labels, cpu, mem, disk, net };
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
}

function pushSeries(timestamp, cpu, mem, disk, net) {
  series.stamps.push(Number(timestamp) || Date.now());
  series.cpu.push(cpu);
  series.mem.push(mem);
  series.disk.push(disk);
  series.net.push(net);
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
  return `<tr><td colspan="11" class="muted">${escapeHtml(message)}</td></tr>`;
}

function renderTable(servers) {
  if (!servers.length) {
    elements.table.innerHTML = emptyRow("\u6682\u65e0\u5339\u914d\u670d\u52a1\u5668");
    return;
  }
  elements.table.innerHTML = servers
    .map((server) => {
      const name = escapeHtml(server.name);
      const updatedAt = formatTime(server.metrics?.timestamp || server.fetchedAt);
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
            <td class="muted">${updatedAt}</td>
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
          <td class="muted">${updatedAt}</td>
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
    elements.detailBody.innerHTML = `
      <div class="detail-block">
        <div class="detail-block-title">\u76ee\u6807\u4e0d\u53ef\u8fbe</div>
        <div class="error-text">${escapeHtml(server.error || "unknown error")}</div>
        <div class="muted">\u6700\u540e\u68c0\u67e5: ${escapeHtml(formatTime(server.fetchedAt))}</div>
      </div>`;
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

  elements.detailBody.className = "detail-body";
  elements.detailBody.innerHTML = `
    <div class="detail-grid">
      <div class="detail-card">
        <div class="detail-card-title">CPU</div>
        <div class="detail-card-value">${escapeHtml(formatPercent(server.metrics.cpu))}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">\u5185\u5b58</div>
        <div class="detail-card-value">${escapeHtml(formatPercent(server.metrics.mem))}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">\u78c1\u76d8\u5cf0\u503c</div>
        <div class="detail-card-value">${escapeHtml(formatPercent(server.metrics.disk))}</div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">\u8fd0\u884c\u65f6\u957f</div>
        <div class="detail-card-value">${escapeHtml(formatUptime(status.system?.uptimeSec))}</div>
      </div>
    </div>
    <div class="detail-sections">
      <div class="detail-block">
        <div class="detail-block-title">\u7cfb\u7edf\u4fe1\u606f</div>
        ${systemTable}
      </div>
      <div class="detail-block">
        <div class="detail-block-title">\u78c1\u76d8\u5206\u533a</div>
        ${diskTable}
      </div>
      <div class="detail-block">
        <div class="detail-block-title">\u670d\u52a1\u72b6\u6001 (\u8fd0\u884c ${escapeHtml(String(status.services?.running ?? 0))}\uff0c\u6545\u969c ${escapeHtml(String(status.services?.failed ?? 0))})</div>
        <div class="service-legend">
          <span class="service-text-ok">\u6b63\u5e38</span>
          <span class="service-text-fail">\u6545\u969c</span>
          <span class="service-text-info">\u8fc7\u6e21\u72b6\u6001</span>
          <span class="service-text-warn">\u624b\u52a8/\u8b66\u544a</span>
          <span class="service-text-off">\u505c\u6b62/\u7981\u7528</span>
        </div>
        ${serviceTable}
      </div>
      <div class="detail-block">
        <div class="detail-block-title">\u6545\u969c\u5b9a\u4f4d</div>
        ${serviceFailureList}
      </div>
      <div class="detail-block">
        <div class="detail-block-title">Docker \u5bb9\u5668 (running ${escapeHtml(String(status.docker?.running ?? 0))})</div>
        ${dockerTable}
      </div>
      <div class="detail-block">
        <div class="detail-block-title">TCP \u72b6\u6001</div>
        ${tcpList}
      </div>
    </div>`;
}
function mapServer(entry, index) {
  const id = String(entry?.url || entry?.name || `target-${index}`) + `#${index}`;
  if (!entry || !entry.status) {
    return {
      id,
      name: entry?.name || entry?.url || "-",
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
    name: entry.name || status.system?.hostname || entry.url,
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

async function fetchSettings() {
  const res = await fetch("/api/settings");
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data?.data || null;
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

  if (keyword) {
    result = result.filter((item) => String(item.name).toLowerCase().includes(keyword));
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
  const visibleServers = applyFilterAndSort(servers);
  state.visibleServers = visibleServers;
  const selected = pickSelectedServer(visibleServers);
  renderTable(visibleServers);
  renderSummary(visibleServers);
  renderDetail(selected);

  if (!appendSeries) return;
  // Keep chart trends stable even when table filters/search hide some rows.
  const online = servers.filter((item) => item.status && item.metrics.cpu != null);
  if (!online.length) return;

  const avg = (arr) => arr.reduce((sum, v) => sum + v, 0) / arr.length;
  const cpuAvg = avg(online.map((s) => s.metrics.cpu));
  const memAvg = avg(online.map((s) => s.metrics.mem));
  const diskMax = Math.max(...online.map((s) => s.metrics.disk || 0));
  const netSum = online.reduce(
    (sum, s) => sum + (s.metrics.netRx || 0) + (s.metrics.netTx || 0),
    0
  );
  pushSeries(Date.now(), cpuAvg, memAvg, diskMax, netSum);
  updateCharts();
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  setStatus("\u6b63\u5728\u62c9\u53d6\u6700\u65b0\u72b6\u6001...", "ok");
  try {
    const raw = await fetchStatus();
    state.lastServers = raw.map((entry, index) => mapServer(entry, index));
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
      state.filterStatus = String(event.target.value || "all");
      localStorage.setItem(STORAGE_KEYS.filterStatus, state.filterStatus);
      render(state.lastServers, false);
    });
  }

  if (elements.sortBy) {
    elements.sortBy.value = state.sortBy;
    elements.sortBy.addEventListener("change", (event) => {
      state.sortBy = String(event.target.value || "severity");
      localStorage.setItem(STORAGE_KEYS.sortBy, state.sortBy);
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

  if (elements.chartBucket) {
    elements.chartBucket.value = normalizeChartBucket(state.chartBucket);
    elements.chartBucket.addEventListener("change", (event) => {
      state.chartBucket = normalizeChartBucket(event.target.value);
      localStorage.setItem(STORAGE_KEYS.chartBucket, state.chartBucket);
      updateCharts();
    });
  }

  if (elements.searchInput) {
    elements.searchInput.addEventListener("input", (event) => {
      state.search = String(event.target.value || "");
      render(state.lastServers, false);
    });
  }

  if (elements.refreshBtn) {
    elements.refreshBtn.addEventListener("click", () => {
      refresh();
    });
  }

  if (elements.table) {
    elements.table.addEventListener("click", (event) => {
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
  syncIntervalControl();
  setAlertConfigText();
}

window.addEventListener("resize", () => {
  Object.values(charts).forEach((chart) => chart.resize());
});

async function start() {
  state.fontSize = normalizeFontSize(state.fontSize);
  state.chartBucket = normalizeChartBucket(state.chartBucket);
  applyFontSize();
  bindControls();
  await bootstrapSettings();
  render([], false);
  refresh();
  updateTimers();
}

start();
