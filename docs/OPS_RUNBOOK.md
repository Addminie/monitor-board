# 运维手册（Ops Runbook）

## 1. 服务清单

- `agent`：采集目标机器状态（默认 `9101`）
- `dashboard`：监控看板与配置 API（默认 `9200`）
- `notify-bridge`：Prometheus/Alertmanager 通知桥（默认 `9300`，可选）
- `prometheus` / `alertmanager` / `grafana`：迁移监控栈（可选）

## 2. 启停方式

### 2.1 Docker（推荐）

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
docker compose down
```

### 2.2 监控栈（Prometheus+Grafana）

```bash
docker compose -f docker-compose.monitoring.yml up -d --build
docker compose -f docker-compose.monitoring.yml ps
```

## 3. 健康检查

- Agent: `GET /healthz`, `GET /readyz`
- Dashboard: `GET /healthz`, `GET /readyz`
- Notify Bridge: `GET /healthz`, `GET /readyz`

示例：

```bash
curl http://127.0.0.1:9200/healthz
curl http://127.0.0.1:9200/readyz
```

## 4. 一键诊断

```bash
npm run ops:doctor
npm run ops:doctor:strict
```

Windows:

```powershell
.\scripts\ops-doctor.ps1
```

该脚本会输出 `PASS/WARN/FAIL` 与处理建议，优先用于新人排障。

## 5. 配置与变更

- 目标配置：`dashboard/config/targets.json`
- 阈值配置：`dashboard/config/alerts.json`
- 通知配置：`dashboard/config/notifications.json`

建议使用 API 变更并自动备份：

- `PUT /api/config/:type`
- `GET /api/config/backups?type=...`
- `POST /api/config/rollback`

## 6. 常见故障定位

1. 看板状态全红/离线
- 先查 `dashboard /readyz`
- 再查 `targets.json` URL/token
- 用 `POST /api/v1/targets/diagnose` 定位 network/auth/api

2. 告警不发送
- 查 `notifications.json` 是否 `enabled=true`
- 查绑定 `targets/severities/channels` 是否匹配
- 查死信日志：`/app/logs/*deadletter*.jsonl`

3. 趋势图无历史
- 查 `PROMETHEUS_HISTORY_ENABLED=true`
- 查 `PROMETHEUS_BASE_URL` 连通性
- 在 Prometheus 查询 `up{job="monitor-agent"}`
