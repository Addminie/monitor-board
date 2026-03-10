# Ops Toolkit (T27)

## 一键诊断入口

- Node（跨平台）：
  - `npm run ops:doctor`
- Windows PowerShell：
  - `.\scripts\ops-doctor.ps1`
- Linux/macOS：
  - `bash ./scripts/ops-doctor.sh`

## 诊断覆盖项

- Node 运行环境与工作目录
- Docker / docker compose 可用性
- 配置文件检查：
  - `dashboard/config/targets.json`
  - `dashboard/config/alerts.json`
  - `dashboard/config/notifications.json`
- 服务健康与就绪：
  - Agent: `/healthz` `/readyz` `/api/monitor/status`
  - Dashboard: `/healthz` `/readyz` `/api/settings`
  - Notify Bridge: `/healthz` `/readyz`
  - Prometheus: `/-/healthy`（可选）
  - Grafana: `/api/health`（可选）
- 目标连通诊断（抽样前 5 个）：
  - Dashboard `/api/targets/diagnose`

## 常用参数

- `--dashboard-url http://127.0.0.1:9200`
- `--agent-url http://127.0.0.1:9101`
- `--notify-url http://127.0.0.1:9300`
- `--prometheus-url http://127.0.0.1:9090`
- `--grafana-url http://127.0.0.1:3000`
- `--timeout-ms 4000`
- `--json`：输出 JSON 结果
- `--strict`：有 FAIL 项时返回非 0 退出码（`2`）

示例：

```bash
node scripts/ops-doctor.js --json
node scripts/ops-doctor.js --strict --timeout-ms 6000
```

## 鉴权说明

- Agent 需要 token 时：设置环境变量 `AGENT_TOKEN`
- Dashboard 启用 RBAC 时：设置环境变量 `DASHBOARD_API_TOKEN`
  - 也支持自动读取 `RBAC_TOKEN_READONLY/OPERATOR/ADMIN`
