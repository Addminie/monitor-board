# Capacity Benchmark Guide (T30)

## 1. Run Benchmark

```bash
npm run ops:capacity
```

Output report:

- `docs/CAPACITY_REPORT.md`

## 2. What It Measures

- Scales: `100 / 300 / 500` targets
- Query path: `GET /api/v1/targets/status?refresh=1`
- Metrics: `min/avg/p50/p95/max` latency and failed request count

## 3. How To Read

- `failed > 0` means reliability risk
- `p95 > 4000ms` means scale pressure is visible
- `p95 > 8000ms` means current topology should be split

## 4. Scaling Actions

- Increase `ALERT_POLL_MS` and `COLLECTION_CACHE_TTL_MS`
- Split targets by business domain into multiple dashboard instances
- Move long-term trend queries to Prometheus/Grafana
- Keep notify-bridge centralized to retain unified notification config
