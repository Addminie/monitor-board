# 告警手册（Alert Runbook）

## 1. 告警来源

- Dashboard 内置告警循环（默认开启）
- Prometheus + Alertmanager + notify-bridge（迁移方案）

避免重复通知：使用监控栈时建议 `ALERT_LOOP_ENABLED=false`。

## 2. 级别定义

- `warn`：预警，需关注
- `danger`：严重，需尽快处理
- `offline`：目标不可达，优先排查网络/鉴权/进程

## 3. 通知绑定配置

文件：`dashboard/config/notifications.json`

关键字段：

- `enabled`
- `bindings[].targets`
- `bindings[].severities`
- `bindings[].notifyRecover`
- `bindings[].channels[]`
- `bindings[].silences` / `silenceUntil`

## 4. ACK / 静默

### ACK（人工确认）

- 查询：`GET /api/v1/alerts/acks`
- 确认：`POST /api/v1/alerts/acks`
- 解除：`POST /api/v1/alerts/unack` 或 `DELETE /api/v1/alerts/acks`

### 静默窗口（计划维护）

在 `bindings[].silences` 配置时间窗，避免维护窗口告警打扰。

## 5. 测试发送

### Dashboard

```bash
curl -X POST http://127.0.0.1:9200/api/v1/alerts/test \
  -H "Content-Type: application/json" \
  -d '{"binding":"ops-all","severity":"danger","target":"manual-test","message":"alert test"}'
```

### Notify Bridge

```bash
curl -X POST http://127.0.0.1:9300/api/v1/alerts/test \
  -H "Content-Type: application/json" \
  -d '{"binding":"ops-all","severity":"danger","target":"manual-test","message":"bridge test"}'
```

## 6. 排障顺序

1. `readyz` 是否通过
2. 通知配置是否被正确加载（文件/环境变量）
3. 渠道参数是否完整（Webhook/BotToken/ChatId）
4. 死信日志是否出现重试失败记录
5. 对外网络策略是否拦截通知平台域名
