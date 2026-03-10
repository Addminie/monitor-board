# Capacity Report

Generated At: 2026-03-10T13:19:48.011Z  
Host: WIN-20260208JSV  
Node: v24.13.0

## Method

- Single local agent + single dashboard
- Target set scales: 100, 300, 500
- Endpoint: `/api/v1/targets/status?refresh=1`
- Per-scale sample count: 5

## Results

| Targets | Requests | Failed | Min(ms) | Avg(ms) | P50(ms) | P95(ms) | Max(ms) |
|---|---:|---:|---:|---:|---:|---:|---:|
| 100 | 5 | 0 | 21 | 2196 | 3620 | 3648 | 3664 |
| 300 | 5 | 0 | 48 | 1620 | 72 | 3945 | 3982 |
| 500 | 5 | 0 | 60 | 1797 | 100 | 4355 | 4387 |

## Bottleneck Notes

- 500 targets: P95=4355ms (>4s), increase poll interval and cache TTL

## Scaling Suggestions

- <=100 targets: a single dashboard instance is generally acceptable
- ~300 targets: keep collection cache enabled and increase poll interval
- >=500 targets: split dashboard instances by business domain and move long-term trends to Prometheus/Grafana

