# Grafana 迁移实施手册（T29）

目标：将生产可视化逐步迁移到 Prometheus + Grafana，同时保留现有 Dashboard 与通知配置（双栈并行，风险可控）。

## 1. 双栈架构

- 旧栈：
  - Dashboard (`9200`) + 配置页 + 内置告警（可关闭）
- 新栈：
  - Prometheus (`9090`)
  - Alertmanager (`9093`)
  - Grafana (`3000`)
  - notify-bridge (`9300`) 复用 `notifications.json`

## 2. 启动方式

```bash
docker compose -f docker-compose.monitoring.yml up -d --build
```

说明：

- `docker-compose.monitoring.yml` 中默认已设置 `ALERT_LOOP_ENABLED=false`，避免重复告警。
- Dashboard 继续保留，用于配置与小白入口。

## 3. 迁移步骤（建议）

1. 启动双栈并保持旧看板可用
2. 在 Grafana 验证核心看板与指标
3. 用 notify-bridge 验证通知链路
4. 切换值班人员主要看板入口到 Grafana
5. 观察 1~2 个值班周期后再评估是否下线旧趋势展示

## 4. 验证命令

```bash
npm run ops:verify-dual-stack
npm run ops:verify-dual-stack:strict
```

通过标准：

- Dashboard / Prometheus / Alertmanager / Notify Bridge / Grafana 全部可达
- Prometheus `up{job="monitor-agent"}` 有效
- notify-bridge 测试通知成功

## 5. 回滚策略

若迁移异常：

1. 保持旧 Dashboard 作为主入口
2. 暂停新栈告警（Prometheus/Alertmanager）
3. 修复后重新执行双栈验证脚本
