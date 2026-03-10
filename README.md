# Monitor Board（Docker 部署版）

这是一个轻量的多服务器监控看板项目，包含两个服务：

- `agent/`：部署在每台被监控机器上，提供 `/api/monitor/status`
- `dashboard/`：集中拉取多个 Agent 状态并展示在网页

本 README 已切换为 **Docker 部署优先** 的使用方式。

---

## 1. 项目结构

```text
monitor-board/
├─ agent/
│  ├─ server.js
│  ├─ package.json
│  ├─ Dockerfile
│  └─ .dockerignore
├─ dashboard/
│  ├─ server.js
│  ├─ package.json
│  ├─ Dockerfile
│  ├─ .dockerignore
│  ├─ config/
│  │  ├─ targets.example.json
│  │  ├─ alerts.example.json
│  │  ├─ notifications.example.json
│  │  └─ targets.docker.example.json
│  └─ public/
├─ docker-compose.yml
└─ README.md
```

---

## 2. 环境要求

- Docker Engine 24+
- Docker Compose v2（命令是 `docker compose`）

检查：

```bash
docker --version
docker compose version
```

---

## 3. 快速体验（单机，一条命令启动）

项目根目录已经提供了 `docker-compose.yml`，可直接启动本地演示：

```bash
cd monitor-board
docker compose up -d --build
```

启动后访问：

```text
http://127.0.0.1:9200/
```

说明：

- 演示模式会启动两个容器：
  - `monitor-agent-local`（9101）
  - `monitor-dashboard`（9200）
- Dashboard 默认读取：`dashboard/config/targets.docker.example.json`

停止：

```bash
docker compose down
```

查看日志：

```bash
docker compose logs -f
```

---

## 4. 生产部署（多台服务器）

推荐架构：

- 每台业务机器部署一个 Agent 容器
- 在一台监控机器部署 Dashboard 容器
- Dashboard 通过内网地址访问各 Agent

### 4.1 在每台被监控机器部署 Agent

在该机器放置 `agent/` 目录后执行：

```bash
cd agent
docker build -t monitor-agent:0.1 .
```

启动容器：

```bash
docker run -d \
  --name monitor-agent \
  --restart unless-stopped \
  -p 9101:9101 \
  -e PORT=9101 \
  -e AGENT_TOKEN='replace_with_strong_token' \
  monitor-agent:0.1
```

检查：

```bash
curl -H "Authorization: Bearer replace_with_strong_token" http://127.0.0.1:9101/api/monitor/status
```

### 4.2 在监控机器部署 Dashboard

在该机器放置 `dashboard/` 目录后执行：

```bash
cd dashboard
docker build -t monitor-dashboard:0.1 .
```

先创建配置文件（示例）：

```json
[
  {
    "name": "app-01",
    "url": "http://10.0.0.11:9101",
    "token": "token_for_app_01"
  },
  {
    "name": "app-02",
    "url": "http://10.0.0.12:9101",
    "token": "token_for_app_02"
  }
]
```

保存为：`/opt/monitor-board/targets.json`

如需告警通知，再创建：`/opt/monitor-board/notifications.json`
（可从 `dashboard/config/notifications.example.json` 复制后修改）

启动容器：

```bash
docker run -d \
  --name monitor-dashboard \
  --restart unless-stopped \
  -p 9200:9200 \
  -e PORT=9200 \
  -e REQUEST_TIMEOUT_MS=8000 \
  -e ALERT_POLL_MS=15000 \
  -v /opt/monitor-board/targets.json:/app/config/targets.json:ro \
  -v /opt/monitor-board/notifications.json:/app/config/notifications.json:ro \
  monitor-dashboard:0.1
```

访问：

```text
http://<dashboard-ip>:9200/
```

---

## 5. 使用说明

### 5.1 页面上能看到什么

- 目标机器在线状态
- CPU / 内存 / 磁盘 / 网络
- 部分系统服务与 Docker 信息（取决于目标机器环境）
- 汇总卡片 + 趋势图（CPU、内存、磁盘、网络）

### 5.2 页面交互功能（新）

- 手动刷新：点击右上角 `立即刷新`
- 自动刷新开关：可关闭/开启自动拉取
- 刷新间隔：支持 `5s / 10s / 30s / 60s`
- 状态过滤：全部 / 在线 / 离线 / 告警
- 名称搜索：按服务器名称快速筛选
- 排序：按风险、CPU、内存、磁盘、名称排序
- 错误可视化：离线目标显示错误原因（例如超时、403、连接失败）
- 控件偏好自动记忆：刷新间隔、自动刷新、过滤、排序会保存在浏览器本地
- 单机详情面板：点击任意服务器行可查看该机器的详细信息（系统、磁盘、服务、Docker、TCP 状态）
- 看板底部提供“打开配置入口”按钮，可进入 `/config.html`（小白模式：参数说明 + JSON 生成 + 测试发送）

### 5.3 告警阈值配置（新）

Dashboard 支持从配置文件或环境变量读取阈值：

1. 文件方式（推荐）

- 复制 `dashboard/config/alerts.example.json` 为 `dashboard/config/alerts.json`
- 按需修改阈值

示例：

```json
{
  "cpu": { "warn": 75, "danger": 90 },
  "mem": { "warn": 80, "danger": 92 },
  "disk": { "warn": 70, "danger": 85 },
  "serviceFailedDanger": 1
}
```

2. 环境变量方式

```bash
MONITOR_ALERTS='{"cpu":{"warn":75,"danger":90},"mem":{"warn":80,"danger":92},"disk":{"warn":70,"danger":85},"serviceFailedDanger":1}'
```

优先级：`MONITOR_ALERTS` > `config/alerts.json` > 内置默认值。

### 5.4 告警通知绑定（企业微信/Telegram/钉钉）

Dashboard 支持多绑定、多目标、多渠道通知。  
配置文件：`dashboard/config/notifications.json`

快速开始：

1. 复制 `dashboard/config/notifications.example.json` 为 `dashboard/config/notifications.json`
2. 把各渠道账号信息填进去（Webhook/BotToken/ChatId）
3. 设置 `enabled: true`
4. 重启 Dashboard

绑定字段说明：

- `bindings[].targets`：匹配目标，可填 `*`（全部）或具体名称，也支持通配符如 `prod-*`
- `bindings[].severities`：订阅级别，可填 `warn` / `danger` / `offline` / `all`
- `bindings[].notifyRecover`：是否发送恢复通知
- `bindings[].channels`：通知账号列表
  - 企业微信：`type=wechat` + `webhook`
  - Telegram：`type=telegram` + `botToken` + `chatId`
  - 钉钉：`type=dingtalk` + `webhook` (+ `secret` 可选)

触发逻辑：

- 首次进入告警会发送
- 严重级别升级会立即发送
- 原因变化按冷却时间发送
- 恢复正常可发送恢复通知

测试通知：

```bash
curl -X POST http://127.0.0.1:9200/api/alerts/test \
  -H "Content-Type: application/json" \
  -d '{"binding":"ops-all","message":"manual test","severity":"danger"}'
```

### 5.5 新增或修改被监控机器

Dashboard 读取 `targets.json`，格式如下：

```json
[
  { "name": "server-01", "url": "http://10.0.0.10:9101", "token": "your_agent_token" },
  { "name": "server-02", "url": "http://10.0.0.11:9101", "token": "your_agent_token" }
]
```

修改后重启 Dashboard 容器：

```bash
docker restart monitor-dashboard
```

---

## 6. API 说明

### Agent

- `GET /healthz`：健康检查
- `GET /api/monitor/status`：监控数据

若设置了 `AGENT_TOKEN`，请求必须带：

```text
Authorization: Bearer <AGENT_TOKEN>
```

### Dashboard

- `GET /api/targets`：读取已配置目标（不返回 token）
- `GET /api/targets/status`：聚合拉取所有目标状态
- `GET /api/settings`：读取看板设置（告警阈值、可选刷新间隔）
- `GET /api/alerts/state`：读取最近告警状态缓存
- `POST /api/alerts/test`：发送测试通知到已绑定渠道

---

## 7. 环境变量

### Agent

- `PORT`：默认 `9101`
- `AGENT_TOKEN`：默认空（生产必须设置）
- `CMD_TIMEOUT_MS`：默认 `1500`

### Dashboard

- `PORT`：默认 `9200`
- `REQUEST_TIMEOUT_MS`：默认 `8000`
- `MONITOR_TARGETS`：可用 JSON 字符串直接覆盖目标配置
- `MONITOR_ALERTS`：可用 JSON 字符串覆盖告警阈值配置
- `MONITOR_NOTIFICATIONS`：可用 JSON 字符串覆盖通知绑定配置
- `ALERT_POLL_MS`：告警轮询间隔毫秒，默认 `15000`
- `ALERT_LOOP_ENABLED`：是否启用告警轮询，默认 `true`

---

## 8. 常用运维命令（Docker）

查看运行状态：

```bash
docker ps
```

查看日志：

```bash
docker logs -f monitor-agent
docker logs -f monitor-dashboard
```

重启：

```bash
docker restart monitor-agent
docker restart monitor-dashboard
```

更新（重新构建并重启）：

```bash
cd monitor-board
docker compose up -d --build
```

---

## 9. 安全建议

- 为每台 Agent 设置强随机 `AGENT_TOKEN`
- 仅允许 Dashboard 所在机器访问 Agent 的 `9101` 端口
- Dashboard 建议放内网，或放到 Nginx 后并启用 HTTPS + 认证
- 不要把带 token 的 `targets.json` 暴露在公开仓库

---

## 10. 注意事项

- 本项目最适合 Linux 目标机。
- Agent 以容器方式运行时，部分“主机级”指标可能受容器隔离影响（如 `systemctl`、部分磁盘/进程视图）。
- 若你希望最完整的主机指标，可将 Agent 直接运行在主机系统上（非容器）或按你的环境做更深的容器权限配置。

---

## 11. Prometheus + Grafana 迁移（第一阶段）

已新增一套并行迁移骨架，包含：

- Prometheus（采集 + 规则）
- Alertmanager（告警路由）
- Grafana（可视化，已预置现代化仪表盘）
- notify-bridge（复用 `notifications.json`，继续发送企业微信/Telegram/钉钉）
- 现有 dashboard 继续保留（配置入口 / 小白页面），并可关闭内置告警循环避免重复通知

### 11.1 新增文件

```text
docker-compose.monitoring.yml
monitoring/
├─ prometheus/
│  ├─ prometheus.yml
│  └─ alert.rules.yml
├─ alertmanager/
│  └─ alertmanager.yml
└─ grafana/
   ├─ provisioning/
   │  ├─ datasources/prometheus.yml
   │  └─ dashboards/dashboards.yml
   └─ dashboards/monitor-board-overview.json
notify-bridge/
├─ server.js
├─ package.json
├─ Dockerfile
└─ .dockerignore
```

### 11.2 Agent 新增 `/metrics`

Agent 现在支持：

- `GET /api/monitor/status`（原有 JSON 接口）
- `GET /metrics`（Prometheus 格式）

新增环境变量：

- `STATUS_CACHE_TTL_MS`：状态缓存毫秒，默认 `2000`
- `METRICS_TOKEN`：`/metrics` 的 Bearer Token（可选）

### 11.3 一键启动迁移栈

```bash
cd monitor-board
docker compose -f docker-compose.monitoring.yml up -d --build
```

访问入口：

- 旧看板与配置页：`http://127.0.0.1:9200/`
- Prometheus：`http://127.0.0.1:9090/`
- Alertmanager：`http://127.0.0.1:9093/`
- Grafana：`http://127.0.0.1:3000/`（默认 `admin/admin`）
- 通知桥接健康检查：`http://127.0.0.1:9300/healthz`

### 11.4 通知配置保持兼容

`notify-bridge` 直接读取同一份通知文件，配置语义不变：

- 文件：`dashboard/config/notifications.json`
- 兼容字段：`enabled`、`cooldownSec`、`remindIntervalSec`、`bindings[].targets`、`bindings[].severities`、`bindings[].notifyRecover`、`bindings[].channels`

说明：

- 当前 `docker-compose.monitoring.yml` 默认挂载的是 `dashboard/config/notifications.example.json`。
- 生产请改成你的真实配置文件（建议复制为 `dashboard/config/notifications.json` 再挂载）。

### 11.5 阈值调整位置

当前 Prometheus 告警阈值在：

- `monitoring/prometheus/alert.rules.yml`

默认与原项目接近：

- CPU：`85/95`
- 内存：`85/95`
- 磁盘：`80/90`
- 服务故障：`>=1`

### 11.6 验证步骤

1. 检查 Agent 指标是否可抓取：

```bash
curl http://127.0.0.1:9101/metrics
```

2. 在 Prometheus 执行查询：

- `up{job="monitor-agent"}`
- `monitor_cpu_usage_percent`
- `monitor_service_failed_total`

3. 在 Grafana 打开预置看板：

- `Monitor Board / Monitor Board Next`

4. 测试 notify-bridge：

```bash
curl -X POST http://127.0.0.1:9300/api/alerts/test \
  -H "Content-Type: application/json" \
  -d '{"severity":"danger","target":"manual-test","message":"bridge test"}'
```
