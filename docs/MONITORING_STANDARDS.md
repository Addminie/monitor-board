# Monitoring Standards

Last Updated: 2026-03-10

## Metric Naming

- Prefix all custom metrics with `monitor_`.
- Use suffix by data type:
  - `_percent` for percentages
  - `_total` for counts
  - `_bytes` / `_bytes_per_second` for byte metrics
- Keep metric names stable to avoid dashboard and alert rule breaks.

Current core metrics exposed by agent:

- `monitor_cpu_usage_percent`
- `monitor_memory_usage_percent`
- `monitor_disk_usage_percent`
- `monitor_network_rx_bytes_per_second`
- `monitor_network_tx_bytes_per_second`
- `monitor_service_failed_total`
- `monitor_docker_running_total`

## Label Standards

Target-level labels (required in Prometheus target file):

- `target`: logical host name
- `env`: environment (`prod/staging/dev/...`)
- `business`: business domain/service line
- `room`: room/zone/idc
- `owner`: on-call owner/team

These labels are used by:

- Prometheus recording/alert rules
- Alertmanager grouping/routing
- Dashboard history filtering and aggregation

## Target Onboarding (No Code Change)

1. Add target entry into `monitoring/prometheus/targets/*.yml`.
2. Keep label fields complete (`target/env/business/room/owner`).
3. Reload Prometheus config:
   - `POST /-/reload` on Prometheus web API, or restart container.

Example:

```yaml
- targets:
    - 10.0.0.21:9101
  labels:
    target: payment-node-01
    env: prod
    business: payment
    room: cn-hz-a
    owner: sre-team
```

## Rule Template Policy

- Recording rules first, alert rules depend on recording rules.
- Default severities:
  - `warn`: sustained threshold breach
  - `danger`: higher threshold or critical failures
  - `offline`: target unavailable
- Rule file location:
  - `monitoring/prometheus/alert.rules.yml`

## Change Checklist

- Metric names unchanged or backward-compatible.
- Labels include `target/env/business/room/owner`.
- `promtool check rules` passes before release.
- Dashboard historical query still works (`/api/history/summary`).

