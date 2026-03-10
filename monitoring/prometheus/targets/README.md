# Prometheus Target Files

Put your monitor-agent targets here. Prometheus loads all `*.yml` files from this folder.

Each target should include standard labels:

- `target`
- `env`
- `business`
- `room`
- `owner`

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

After changing files, reload Prometheus:

```bash
curl -X POST http://127.0.0.1:9090/-/reload
```

