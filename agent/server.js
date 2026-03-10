const express = require("express");
const os = require("os");
const fs = require("fs");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const PORT = Number(process.env.PORT || 9101);
const AUTH_TOKEN = String(process.env.AGENT_TOKEN || "").trim();
const CMD_TIMEOUT_MS = Number(process.env.CMD_TIMEOUT_MS || 1500);
const STATUS_CACHE_TTL_MS = Number(process.env.STATUS_CACHE_TTL_MS || 2000);
const METRICS_TOKEN = String(process.env.METRICS_TOKEN || "").trim();

let lastNetSample = null;
let lastDiskSample = null;
let statusCache = {
  ts: 0,
  data: null,
  pending: null,
};

function nowIso() {
  return new Date().toISOString();
}

function getCpuSnapshot() {
  return os.cpus().map((cpu) => {
    const times = cpu.times || {};
    const total = Object.values(times).reduce((sum, value) => sum + value, 0);
    return { idle: times.idle || 0, total };
  });
}

async function getCpuUsage(sampleMs = 160) {
  const start = getCpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const end = getCpuSnapshot();
  let idleDelta = 0;
  let totalDelta = 0;
  const perCore = end.map((core, index) => {
    const idle = core.idle - (start[index]?.idle || 0);
    const total = core.total - (start[index]?.total || 0);
    idleDelta += idle;
    totalDelta += total;
    if (total <= 0) return 0;
    const usage = (1 - idle / total) * 100;
    return Math.max(0, Math.min(100, Number(usage.toFixed(1))));
  });
  if (totalDelta <= 0) {
    return { overall: 0, perCore };
  }
  const usage = (1 - idleDelta / totalDelta) * 100;
  return {
    overall: Math.max(0, Math.min(100, Number(usage.toFixed(1)))),
    perCore,
  };
}

async function execCommand(command, timeoutMs = CMD_TIMEOUT_MS) {
  try {
    const { stdout } = await execAsync(command, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { output: String(stdout || "").trim(), error: null };
  } catch (error) {
    return {
      output: "",
      error: error?.message || "command failed",
    };
  }
}

function parseDfOutput(output) {
  if (!output) return [];
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  return lines
    .slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const [filesystem, size, used, avail, usePercent, ...mountParts] = parts;
      return {
        filesystem,
        size,
        used,
        avail,
        usePercent,
        mount: mountParts.join(" "),
      };
    })
    .filter(Boolean);
}

function parseMemInfo(output) {
  const result = {};
  if (!output) return result;
  output.split(/\r?\n/).forEach((line) => {
    const parts = line.split(":");
    if (parts.length < 2) return;
    const key = parts[0].trim();
    const valueText = parts[1].trim();
    const valueParts = valueText.split(/\s+/);
    const value = Number(valueParts[0]);
    const unit = valueParts[1] || "";
    if (!Number.isFinite(value)) return;
    const bytes = unit.toLowerCase() === "kb" ? value * 1024 : value;
    result[key] = bytes;
  });
  return result;
}

function parseNetDev(output) {
  if (!output) return null;
  const lines = output.split(/\r?\n/).slice(2).filter(Boolean);
  let rx = 0;
  let tx = 0;
  lines.forEach((line) => {
    const [ifacePart, dataPart] = line.split(":");
    if (!dataPart) return;
    const iface = ifacePart.trim();
    if (!iface || iface === "lo") return;
    const fields = dataPart.trim().split(/\s+/);
    if (fields.length < 16) return;
    const rxBytes = Number(fields[0]);
    const txBytes = Number(fields[8]);
    if (Number.isFinite(rxBytes)) rx += rxBytes;
    if (Number.isFinite(txBytes)) tx += txBytes;
  });
  return { rxBytes: rx, txBytes: tx };
}

function parseWindowsNetStats(output) {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let rx = 0;
    let tx = 0;
    items.forEach((item) => {
      const rxBytes = Number(item?.ReceivedBytes);
      const txBytes = Number(item?.SentBytes);
      if (Number.isFinite(rxBytes)) rx += rxBytes;
      if (Number.isFinite(txBytes)) tx += txBytes;
    });
    return { rxBytes: rx, txBytes: tx };
  } catch (_error) {
    return null;
  }
}

function formatBytesHuman(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)}${units[index]}`;
}

function parsePercent(value) {
  const number = Number(String(value || "").replace("%", "").trim());
  return Number.isFinite(number) ? number : null;
}

function parseWindowsDiskInfo(output) {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .map((item) => {
        const filesystem = String(item?.DeviceID || "").trim();
        const size = Number(item?.Size);
        const free = Number(item?.FreeSpace);
        if (!filesystem || !Number.isFinite(size) || size <= 0 || !Number.isFinite(free)) {
          return null;
        }
        const used = Math.max(0, size - free);
        const percent = Math.max(0, Math.min(100, Number(((used / size) * 100).toFixed(1))));
        return {
          filesystem,
          size: formatBytesHuman(size),
          used: formatBytesHuman(used),
          avail: formatBytesHuman(free),
          usePercent: `${percent}%`,
          mount: filesystem,
        };
      })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function parseWindowsServices(output) {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .map((item) => ({
        name: String(item?.Name || "").trim(),
        active: String(item?.State || "").trim(),
        sub: String(item?.StartMode || "").trim(),
        health: String(item?.Status || "").trim(),
        started: !!item?.Started,
        exitCode: Number.isFinite(Number(item?.ExitCode)) ? Number(item?.ExitCode) : null,
        description: String(item?.DisplayName || "").trim(),
      }))
      .filter((item) => item.name);
  } catch (_error) {
    return [];
  }
}

function isWindowsServiceFailed(item) {
  if (!item) return false;
  const health = String(item.health || "").trim().toLowerCase();
  const state = String(item.active || "").trim().toLowerCase();
  const startMode = String(item.sub || "").trim().toLowerCase();
  const exitCode = Number(item.exitCode);
  const healthBad = ["error", "degraded", "pred fail", "unknown"].includes(health);
  const autoStoppedWithError =
    startMode === "auto" &&
    state !== "running" &&
    Number.isFinite(exitCode) &&
    exitCode !== 0 &&
    exitCode !== 1077;
  return healthBad || autoStoppedWithError;
}

function parseWindowsTcpStates(output) {
  if (!output) return {};
  try {
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const states = {};
    items.forEach((item) => {
      const state = String(item?.Name || "").trim().toUpperCase();
      const count = Number(item?.Count);
      if (!state || !Number.isFinite(count)) return;
      states[state] = count;
    });
    return states;
  } catch (_error) {
    return {};
  }
}

function parseTcpStates(output) {
  const stateMap = {
    "01": "ESTABLISHED",
    "02": "SYN_SENT",
    "03": "SYN_RECV",
    "04": "FIN_WAIT1",
    "05": "FIN_WAIT2",
    "06": "TIME_WAIT",
    "07": "CLOSE",
    "08": "CLOSE_WAIT",
    "09": "LAST_ACK",
    "0A": "LISTEN",
    "0B": "CLOSING",
  };
  const counts = {};
  if (!output) return counts;
  output
    .split(/\r?\n/)
    .slice(1)
    .forEach((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return;
      const state = parts[3];
      const label = stateMap[state] || state;
      counts[label] = (counts[label] || 0) + 1;
    });
  return counts;
}

function parseDiskStats(output) {
  if (!output) return [];
  const lines = output.split(/\r?\n/).filter(Boolean);
  return lines
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length > 13)
    .map((parts) => {
      const name = parts[2];
      const readSectors = Number(parts[5]);
      const writeSectors = Number(parts[9]);
      if (!name || !Number.isFinite(readSectors) || !Number.isFinite(writeSectors)) {
        return null;
      }
      return { name, readSectors, writeSectors };
    })
    .filter(Boolean);
}

function isPhysicalDisk(name) {
  if (!name) return false;
  if (name.startsWith("loop") || name.startsWith("ram")) return false;
  if (/^nvme\d+n\d+p\d+$/.test(name)) return false;
  if (/^(sd|vd|xvd|mmcblk)\d+$/.test(name)) return false;
  return /^(sd|vd|xvd|nvme|mmcblk|vd|xda|xvda|vda)/.test(name) || name.length >= 3;
}

function parseSystemctlOutput(output) {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 5) return null;
      const [name, load, active, sub, ...descParts] = parts;
      return {
        name,
        load,
        active,
        sub,
        description: descParts.join(" "),
      };
    })
    .filter(Boolean);
}

function parseDockerPs(output) {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, status, image] = line.split("|").map((part) => part.trim());
      if (!name) return null;
      return { name, status: status || "", image: image || "" };
    })
    .filter(Boolean);
}

function parseDockerStats(output) {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, cpu, mem, net, block] = line.split("|").map((part) => part.trim());
      if (!name) return null;
      return {
        name,
        cpu: cpu || "",
        memory: mem || "",
        net: net || "",
        block: block || "",
      };
    })
    .filter(Boolean);
}

async function buildStatus() {
  const platform = process.platform;
  const now = new Date();
  const cpuUsage = await getCpuUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const processMem = process.memoryUsage();

  const status = {
    timestamp: nowIso(),
    system: {
      hostname: os.hostname(),
      platform,
      release: os.release(),
      arch: os.arch(),
      uptimeSec: Math.floor(os.uptime()),
      localTime: now.toISOString().replace("T", " ").slice(0, 19),
      timezoneOffsetMinutes: now.getTimezoneOffset(),
      loadAvg: os.loadavg ? os.loadavg() : [],
    },
    cpu: {
      cores: os.cpus().length,
      model: os.cpus()[0]?.model || "",
      usagePercent: cpuUsage?.overall ?? 0,
      perCore: Array.isArray(cpuUsage?.perCore) ? cpuUsage.perCore : [],
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      usagePercent: totalMem ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0,
      available: null,
      cached: null,
      buffers: null,
      swapTotal: null,
      swapFree: null,
      swapUsed: null,
      swapPercent: null,
      processRss: processMem.rss,
      processHeapUsed: processMem.heapUsed,
    },
    process: {
      pid: process.pid,
      node: process.version,
      uptimeSec: Math.floor(process.uptime()),
    },
    disk: { items: [], error: null },
    diskIo: { readBytesSec: 0, writeBytesSec: 0 },
    network: {
      rxBytesSec: 0,
      txBytesSec: 0,
      rxBytes: 0,
      txBytes: 0,
      tcpStates: {},
    },
    services: { running: 0, failed: 0, items: [], error: null },
    docker: { running: 0, containers: [], stats: [], error: null },
  };

  if (platform === "linux") {
    const memInfoRaw = await fs.promises
      .readFile("/proc/meminfo", "utf8")
      .catch(() => null);
    if (memInfoRaw) {
      const memInfo = parseMemInfo(memInfoRaw);
      const memTotal = memInfo.MemTotal || totalMem;
      const memAvailable = memInfo.MemAvailable ?? null;
      const memFreeValue = memInfo.MemFree ?? freeMem;
      const memUsedValue =
        memAvailable != null ? memTotal - memAvailable : memTotal - memFreeValue;
      status.memory.total = memTotal;
      status.memory.free = memFreeValue;
      status.memory.used = memUsedValue;
      status.memory.available = memAvailable;
      status.memory.cached = memInfo.Cached ?? null;
      status.memory.buffers = memInfo.Buffers ?? null;
      status.memory.swapTotal = memInfo.SwapTotal ?? null;
      status.memory.swapFree = memInfo.SwapFree ?? null;
      status.memory.swapUsed =
        memInfo.SwapTotal != null && memInfo.SwapFree != null
          ? memInfo.SwapTotal - memInfo.SwapFree
          : null;
      status.memory.usagePercent =
        memTotal > 0 ? Number(((memUsedValue / memTotal) * 100).toFixed(1)) : 0;
      status.memory.swapPercent =
        memInfo.SwapTotal && memInfo.SwapFree != null
          ? Number(
              (
                ((memInfo.SwapTotal - memInfo.SwapFree) / memInfo.SwapTotal) *
                100
              ).toFixed(1)
            )
          : null;
    }

    const dfResult = await execCommand("df -hP");
    if (dfResult.error) {
      status.disk.error = dfResult.error;
    } else {
      status.disk.items = parseDfOutput(dfResult.output);
    }

    const diskStatsRaw = await fs.promises
      .readFile("/proc/diskstats", "utf8")
      .catch(() => null);
    if (diskStatsRaw) {
      const stats = parseDiskStats(diskStatsRaw).filter((item) =>
        isPhysicalDisk(item.name)
      );
      const totalRead = stats.reduce((sum, item) => sum + item.readSectors, 0);
      const totalWrite = stats.reduce((sum, item) => sum + item.writeSectors, 0);
      const nowTs = Date.now();
      if (lastDiskSample) {
        const deltaSec = Math.max(0.2, (nowTs - lastDiskSample.ts) / 1000);
        const readDelta = totalRead - lastDiskSample.readSectors;
        const writeDelta = totalWrite - lastDiskSample.writeSectors;
        status.diskIo.readBytesSec = Math.max(0, (readDelta * 512) / deltaSec);
        status.diskIo.writeBytesSec = Math.max(0, (writeDelta * 512) / deltaSec);
      }
      lastDiskSample = { ts: nowTs, readSectors: totalRead, writeSectors: totalWrite };
    }

    const netDevRaw = await fs.promises
      .readFile("/proc/net/dev", "utf8")
      .catch(() => null);
    if (netDevRaw) {
      const netTotals = parseNetDev(netDevRaw);
      if (netTotals) {
        status.network.rxBytes = netTotals.rxBytes;
        status.network.txBytes = netTotals.txBytes;
        const nowTs = Date.now();
        if (lastNetSample) {
          const deltaSec = Math.max(0.2, (nowTs - lastNetSample.ts) / 1000);
          status.network.rxBytesSec = Math.max(
            0,
            (netTotals.rxBytes - lastNetSample.rxBytes) / deltaSec
          );
          status.network.txBytesSec = Math.max(
            0,
            (netTotals.txBytes - lastNetSample.txBytes) / deltaSec
          );
        }
        lastNetSample = { ts: nowTs, rxBytes: netTotals.rxBytes, txBytes: netTotals.txBytes };
      }
    }

    const tcpRaw = await fs.promises.readFile("/proc/net/tcp", "utf8").catch(() => "");
    const tcp6Raw = await fs.promises
      .readFile("/proc/net/tcp6", "utf8")
      .catch(() => "");
    const tcpStates = parseTcpStates(tcpRaw);
    const tcp6States = parseTcpStates(tcp6Raw);
    Object.keys(tcp6States).forEach((key) => {
      tcpStates[key] = (tcpStates[key] || 0) + tcp6States[key];
    });
    status.network.tcpStates = tcpStates;

    const svcResult = await execCommand(
      "systemctl list-units --type=service --state=running --no-legend --no-pager"
    );
    if (svcResult.error) {
      status.services.error = svcResult.error;
    } else {
      const items = parseSystemctlOutput(svcResult.output);
      status.services.running = items.length;
      status.services.items = items.slice(0, 12);
    }
    const svcFailed = await execCommand(
      "systemctl list-units --type=service --state=failed --no-legend --no-pager"
    );
    if (!svcFailed.error) {
      const failedItems = parseSystemctlOutput(svcFailed.output);
      status.services.failed = failedItems.length;
    }

    const dockerPs = await execCommand(
      "docker ps --format \"{{.Names}}|{{.Status}}|{{.Image}}\""
    );
    const dockerStats = await execCommand(
      "docker stats --no-stream --format \"{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}\""
    );
    if (dockerPs.error && dockerStats.error) {
      status.docker.error = dockerPs.error || dockerStats.error;
    } else {
      const containers = parseDockerPs(dockerPs.output);
      const stats = parseDockerStats(dockerStats.output);
      status.docker.running = containers.length;
      status.docker.containers = containers;
      status.docker.stats = stats;
    }
  }

  if (platform === "win32") {
    const netResult = await execCommand(
      'powershell -NoProfile -Command "Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress"',
      Math.max(CMD_TIMEOUT_MS, 2500)
    );
    if (!netResult.error) {
      const netTotals = parseWindowsNetStats(netResult.output);
      if (netTotals) {
        status.network.rxBytes = netTotals.rxBytes;
        status.network.txBytes = netTotals.txBytes;
        const nowTs = Date.now();
        if (lastNetSample) {
          const deltaSec = Math.max(0.2, (nowTs - lastNetSample.ts) / 1000);
          status.network.rxBytesSec = Math.max(
            0,
            (netTotals.rxBytes - lastNetSample.rxBytes) / deltaSec
          );
          status.network.txBytesSec = Math.max(
            0,
            (netTotals.txBytes - lastNetSample.txBytes) / deltaSec
          );
        }
        lastNetSample = { ts: nowTs, rxBytes: netTotals.rxBytes, txBytes: netTotals.txBytes };
      }
    }

    const diskResult = await execCommand(
      'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \\"DriveType=3\\" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"',
      Math.max(CMD_TIMEOUT_MS, 2500)
    );
    if (!diskResult.error) {
      status.disk.items = parseWindowsDiskInfo(diskResult.output);
    } else {
      status.disk.error = diskResult.error;
    }

    const serviceResult = await execCommand(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,Status,Started,ExitCode | ConvertTo-Json -Compress"',
      Math.max(CMD_TIMEOUT_MS, 3500)
    );
    if (!serviceResult.error) {
      const svcItems = parseWindowsServices(serviceResult.output);
      const running = svcItems.filter(
        (item) => String(item.active || "").toLowerCase() === "running"
      );
      const failed = svcItems.filter((item) => isWindowsServiceFailed(item));
      const sortedItems = [...svcItems].sort((a, b) => {
        const af = isWindowsServiceFailed(a);
        const bf = isWindowsServiceFailed(b);
        if (af !== bf) return af ? -1 : 1;
        const ar = String(a.active || "").toLowerCase() === "running";
        const br = String(b.active || "").toLowerCase() === "running";
        if (ar !== br) return ar ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
      });
      status.services.running = running.length;
      status.services.failed = failed.length;
      status.services.items = sortedItems.slice(0, 12);
    } else {
      status.services.error = serviceResult.error;
    }

    const tcpResult = await execCommand(
      'powershell -NoProfile -Command "Get-NetTCPConnection | Group-Object -Property State | Select-Object Name,Count | ConvertTo-Json -Compress"',
      Math.max(CMD_TIMEOUT_MS, 2500)
    );
    if (!tcpResult.error) {
      status.network.tcpStates = parseWindowsTcpStates(tcpResult.output);
    }
  }

  return status;
}

async function getStatusCached() {
  const now = Date.now();
  if (
    statusCache.data &&
    Number.isFinite(statusCache.ts) &&
    now - statusCache.ts <= Math.max(0, STATUS_CACHE_TTL_MS)
  ) {
    return statusCache.data;
  }
  if (statusCache.pending) return statusCache.pending;
  statusCache.pending = buildStatus()
    .then((data) => {
      statusCache.data = data;
      statusCache.ts = Date.now();
      return data;
    })
    .finally(() => {
      statusCache.pending = null;
    });
  return statusCache.pending;
}

function escPromLabel(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function pushMetricLine(lines, metricName, value, labels = null) {
  if (!Number.isFinite(value)) return;
  if (labels && Object.keys(labels).length) {
    const labelText = Object.entries(labels)
      .map(([k, v]) => `${k}="${escPromLabel(v)}"`)
      .join(",");
    lines.push(`${metricName}{${labelText}} ${value}`);
    return;
  }
  lines.push(`${metricName} ${value}`);
}

function renderPrometheusMetrics(status) {
  const lines = [];
  lines.push("# HELP monitor_up monitor-agent health status");
  lines.push("# TYPE monitor_up gauge");
  lines.push("monitor_up 1");

  lines.push("# HELP monitor_cpu_usage_percent CPU usage percent");
  lines.push("# TYPE monitor_cpu_usage_percent gauge");
  pushMetricLine(lines, "monitor_cpu_usage_percent", Number(status?.cpu?.usagePercent));

  lines.push("# HELP monitor_memory_usage_percent memory usage percent");
  lines.push("# TYPE monitor_memory_usage_percent gauge");
  pushMetricLine(lines, "monitor_memory_usage_percent", Number(status?.memory?.usagePercent));

  lines.push("# HELP monitor_memory_total_bytes total memory bytes");
  lines.push("# TYPE monitor_memory_total_bytes gauge");
  pushMetricLine(lines, "monitor_memory_total_bytes", Number(status?.memory?.total));

  lines.push("# HELP monitor_memory_used_bytes used memory bytes");
  lines.push("# TYPE monitor_memory_used_bytes gauge");
  pushMetricLine(lines, "monitor_memory_used_bytes", Number(status?.memory?.used));

  lines.push("# HELP monitor_memory_free_bytes free memory bytes");
  lines.push("# TYPE monitor_memory_free_bytes gauge");
  pushMetricLine(lines, "monitor_memory_free_bytes", Number(status?.memory?.free));

  lines.push("# HELP monitor_disk_usage_percent disk usage percent by mount");
  lines.push("# TYPE monitor_disk_usage_percent gauge");
  const diskItems = Array.isArray(status?.disk?.items) ? status.disk.items : [];
  diskItems.forEach((item) => {
    const mount = item?.mount || item?.filesystem || "unknown";
    const percent = parsePercent(item?.usePercent);
    pushMetricLine(lines, "monitor_disk_usage_percent", percent, { mount });
  });

  lines.push("# HELP monitor_disk_io_read_bytes_per_second disk io read bytes per second");
  lines.push("# TYPE monitor_disk_io_read_bytes_per_second gauge");
  pushMetricLine(lines, "monitor_disk_io_read_bytes_per_second", Number(status?.diskIo?.readBytesSec));

  lines.push("# HELP monitor_disk_io_write_bytes_per_second disk io write bytes per second");
  lines.push("# TYPE monitor_disk_io_write_bytes_per_second gauge");
  pushMetricLine(lines, "monitor_disk_io_write_bytes_per_second", Number(status?.diskIo?.writeBytesSec));

  lines.push("# HELP monitor_network_rx_bytes_per_second network received bytes per second");
  lines.push("# TYPE monitor_network_rx_bytes_per_second gauge");
  pushMetricLine(lines, "monitor_network_rx_bytes_per_second", Number(status?.network?.rxBytesSec));

  lines.push("# HELP monitor_network_tx_bytes_per_second network sent bytes per second");
  lines.push("# TYPE monitor_network_tx_bytes_per_second gauge");
  pushMetricLine(lines, "monitor_network_tx_bytes_per_second", Number(status?.network?.txBytesSec));

  lines.push("# HELP monitor_network_rx_bytes_total network received bytes total");
  lines.push("# TYPE monitor_network_rx_bytes_total gauge");
  pushMetricLine(lines, "monitor_network_rx_bytes_total", Number(status?.network?.rxBytes));

  lines.push("# HELP monitor_network_tx_bytes_total network sent bytes total");
  lines.push("# TYPE monitor_network_tx_bytes_total gauge");
  pushMetricLine(lines, "monitor_network_tx_bytes_total", Number(status?.network?.txBytes));

  lines.push("# HELP monitor_tcp_state_connections tcp connection count by state");
  lines.push("# TYPE monitor_tcp_state_connections gauge");
  const tcpStates = status?.network?.tcpStates && typeof status.network.tcpStates === "object"
    ? status.network.tcpStates
    : {};
  Object.entries(tcpStates).forEach(([state, count]) => {
    pushMetricLine(lines, "monitor_tcp_state_connections", Number(count), { state });
  });

  lines.push("# HELP monitor_service_running_total running service count");
  lines.push("# TYPE monitor_service_running_total gauge");
  pushMetricLine(lines, "monitor_service_running_total", Number(status?.services?.running));

  lines.push("# HELP monitor_service_failed_total failed service count");
  lines.push("# TYPE monitor_service_failed_total gauge");
  pushMetricLine(lines, "monitor_service_failed_total", Number(status?.services?.failed));

  lines.push("# HELP monitor_docker_running_total running docker container count");
  lines.push("# TYPE monitor_docker_running_total gauge");
  pushMetricLine(lines, "monitor_docker_running_total", Number(status?.docker?.running));

  return `${lines.join("\n")}\n`;
}

function requireToken(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const headerToken = String(req.headers.authorization || "")
    .replace("Bearer ", "")
    .trim();
  if (!headerToken || headerToken !== AUTH_TOKEN) {
    return res.status(403).json({ message: "forbidden" });
  }
  return next();
}

function requireMetricsToken(req, res, next) {
  if (!METRICS_TOKEN) return next();
  const headerToken = String(req.headers.authorization || "")
    .replace("Bearer ", "")
    .trim();
  if (!headerToken || headerToken !== METRICS_TOKEN) {
    return res.status(403).type("text/plain").send("forbidden\n");
  }
  return next();
}

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/monitor/status", requireToken, async (_req, res) => {
  try {
    const data = await getStatusCached();
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error?.message || "monitor failed" });
  }
});

app.get("/metrics", requireMetricsToken, async (_req, res) => {
  try {
    const data = await getStatusCached();
    const body = renderPrometheusMetrics(data);
    res.type("text/plain; version=0.0.4; charset=utf-8").send(body);
  } catch (error) {
    res.status(500).type("text/plain").send(`# error ${error?.message || "metrics failed"}\n`);
  }
});

app.listen(PORT, () => {
  console.log(`monitor-agent running on http://0.0.0.0:${PORT}`);
});
