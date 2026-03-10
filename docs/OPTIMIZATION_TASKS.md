# Monitor Board Optimization Tasks

Last Updated: 2026-03-11  
Execution Rule: follow `T01 -> T38` in order unless user changes priority.

## Current Progress

- Current Task: `T38_DONE`
- Task Status: `completed`
- Completed: `T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23, T24, T25, T26, T27, T28, T29, T30, T31, T32, T33, T34, T35, T36, T37, T38`

### UI Sprint Progress (UI-01 ~ UI-09)

- Current UI Task: `UI-09_DONE`
- UI Task Status: `completed`
- UI Completed: `UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09`

## Execution Log

- 2026-03-10 `T01` completed:
  - Added `/healthz` and `/readyz` to `agent`, `dashboard`, `notify-bridge`
  - Updated API docs in `README.md`
  - Runtime check passed: local `9101/9200/9300` health/readiness endpoints return HTTP 200
- 2026-03-10 `T02` completed:
  - Added process-level guards for `unhandledRejection` and `uncaughtException`
  - Added structured startup logs (`startup.config`, `startup.ready`) in all 3 services
  - Added `EXIT_ON_UNCAUGHT_EXCEPTION` env support and updated docs
- 2026-03-10 `T03` completed:
  - Added SQLite-based state persistence for dashboard and notify-bridge
  - Restored state maps from SQLite on startup and persisted updates on each state change
  - Added persistence readiness details in `/healthz` and `/readyz`
  - Added Docker bind mounts for state DB files under `/app/data`
- 2026-03-10 `T04` completed:
  - Added alert debounce in dashboard loop:
    - `ALERT_DEBOUNCE_FAIL_COUNT` (consecutive failures to alert)
    - `ALERT_DEBOUNCE_RECOVER_COUNT` (consecutive healthy checks to recover)
  - Debounce state (`failCount`, `recoverCount`, `isActive`) is persisted with binding state
  - Exposed debounce values in `/api/settings`
- 2026-03-10 `T05` completed:
  - Added silence windows per binding/target (`bindings[].silences`)
  - Added simplified silence config (`bindings[].silenceUntil`)
  - Applied silence rules to dashboard and notify-bridge send path
  - Updated README with silence parameter examples
- 2026-03-10 `T06` completed:
  - Added ACK / unACK APIs with owner and note fields
  - Added ACK state persistence in SQLite and startup restore
  - Added ACK overlay in `/api/alerts/state`
  - ACKed targets suppress new alert sends until unACK
- 2026-03-10 `T07` completed:
  - Added notification queue worker in dashboard and notify-bridge
  - Added channel retry with exponential backoff
  - Added dead-letter JSONL logging for final send failures
  - Added queue/dead-letter runtime config and health visibility
- 2026-03-10 `T08` completed:
  - Added root-cause panel in host detail view
  - Panel now shows thresholds, raw values, trigger reasons, and last 3 state changes
  - Added in-memory status history tracking for each target in frontend
- 2026-03-10 `T09` completed:
  - Added target diagnostics API (`POST /api/targets/diagnose`)
  - Added one-click diagnose button in dashboard top controls
  - Diagnostics now classify failures as network/auth/api and return latency + suggestions
- 2026-03-10 `T10` completed:
  - Added schema-style config validation for `targets` / `alerts` / `notifications`
  - Exposed validation status and field errors in `/api/settings`
  - `/readyz` now returns `503` with precise invalid config details when validation fails
- 2026-03-10 `T11` completed:
  - Added config save API: `PUT /api/config/:type` (`targets|alerts|notifications`)
  - Added automatic backup before every config update with retention pruning
  - Added backup query API and rollback API:
    - `GET /api/config/backups?type=...`
    - `POST /api/config/rollback`
- 2026-03-10 `T12` completed:
  - Added RBAC middleware with 3 roles: `readonly`, `operator`, `admin`
  - Added token auth support for API (`Authorization: Bearer <token>` or `x-api-token`)
  - Enforced role boundaries:
    - read-only APIs: `readonly+`
    - diagnose/ACK/test notify: `operator+`
    - config save/rollback/backups: `admin`
  - Added `GET /api/auth/me` for current role visibility
- 2026-03-10 `T13` completed:
  - Added audit event writer for key operations: config save/rollback, ACK/unACK, test notify
  - Added query API: `GET /api/audit/logs?limit=&action=`
  - Added export API: `GET /api/audit/export` (JSONL)
  - Added audit env controls: `AUDIT_LOG_FILE`, `AUDIT_MAX_READ`
- 2026-03-10 `T14` completed:
  - Added target metadata support: `env` / `business` / `room` / `owner` (top-level or `tags`)
  - Added targets config validation for metadata fields
  - `/api/targets` and `/api/targets/status` now include metadata
  - `/api/settings` now returns metadata options/statistics for filter UI
  - Dashboard added visual metadata filtering (4 dropdowns) and metadata summary text
  - Host detail now displays metadata card for quick ownership/context lookup
- 2026-03-10 `T15` completed:
  - Added bulk target APIs:
    - `GET /api/targets/export`
    - `POST /api/targets/import` (`replace`/`merge`)
    - `PATCH /api/targets/bulk/metadata`
  - Added bulk update APIs:
    - `PATCH /api/alerts/bulk-thresholds`
    - `PATCH /api/notifications/bulk/targets`
  - Added env override protection for file-write APIs (returns `409` when `MONITOR_*` override is active)
  - Added related README API examples
- 2026-03-10 `T16` completed:
  - Added Saved Views UI controls on dashboard top bar:
    - view selector / save / delete / reset
  - Saved view includes filters + sort + search and supports one-click apply
  - Added update-in-place for selected view and overwrite-by-name protection
  - Saved views are stored in browser localStorage (`monitor.savedViews`)
- 2026-03-10 `T17` completed:
  - Added "Risk Top 5" panel to surface highest-risk targets first
  - Added incident trend chart (`Warn / Danger / Offline`) with bucketed time views
  - Extended frontend time-series data model to persist incident counts per refresh cycle
  - Updated README visualization usage notes
- 2026-03-10 `T18` completed:
  - Refactored host detail into explicit module blocks: root-cause/services/failure-localization/metadata/system/disk/docker/tcp
  - Added per-block collapse/expand interactions
  - Added detail-level `Expand All / Collapse All` controls
  - Persisted collapse state in browser localStorage (`monitor.detailCollapsed`)
- 2026-03-10 `T19` completed:
  - Added shared status-collection cache for dashboard API and alert loop reuse
  - Added cache TTL env: `COLLECTION_CACHE_TTL_MS`
  - `/api/targets/status` now supports `?refresh=1` for forced refresh and returns cache metadata
  - Added cache runtime visibility in `/healthz`, `/readyz`, and `/api/settings`
- 2026-03-10 `T20` completed:
  - Added optional Prometheus history backend for dashboard trends (`PROMETHEUS_HISTORY_ENABLED`)
  - Added history API: `GET /api/history/summary?range=&step=&targets=`
  - Added history runtime info in `/healthz`, `/readyz`, `/api/settings`
  - Frontend now auto-loads historical chart data by selected bucket (with fallback to live in-memory data)
  - Added env controls: `PROMETHEUS_BASE_URL`, `PROMETHEUS_QUERY_TIMEOUT_MS`, `PROMETHEUS_TARGET_LABEL`
- 2026-03-10 `T21` completed:
  - Standardized Prometheus scrape labels (`target/env/business/room/owner`) via relabel defaults
  - Switched Prometheus target management to `file_sd` (`monitoring/prometheus/targets/*.yml`)
  - Reworked rule file into recording rules + alert rules template style
  - Added onboarding/standards docs:
    - `docs/MONITORING_STANDARDS.md`
    - `monitoring/prometheus/targets/README.md`
  - Updated monitoring compose to mount `monitoring/prometheus/targets`
- 2026-03-10 `T22` completed:
  - Added `.env.example` and moved compose runtime secrets to env placeholders
  - Enforced required secrets in compose:
    - `AGENT_TOKEN` (all stacks)
    - `GRAFANA_ADMIN_PASSWORD` (monitoring stack)
  - Removed hardcoded autostart token default and fixed PowerShell startup env-injection bug
  - Updated docs for `.env`-first deployment and secret management
- 2026-03-10 `T23` completed:
  - Added API version alias support across services (`/api/v1/...` + `X-API-Version` header)
  - Added pagination support on key dashboard list APIs (`page`/`pageSize`/`offset`)
  - Added standardized error envelope (`error.code/error.message/error.details`) for dashboard and notify-bridge
  - Updated README with API versioning/pagination/error response conventions
- 2026-03-10 `T24` completed:
  - Added unit tests for dashboard pagination utility module (`dashboard/lib/api-utils.js`)
  - Added integration API tests for all services:
    - `agent`: token auth, `/api/v1` alias, metrics auth
    - `dashboard`: paginated targets/status and error envelope checks
    - `notify-bridge`: `/api/v1` alias, test send, webhook dispatch
  - Added root test scripts in `package.json`:
    - `npm test`
    - `npm run test:coverage`
  - Coverage gate added for core utility module (`>=70%`, current branch coverage `80.65%`)
- 2026-03-10 `T25` completed:
  - Added Playwright UI regression tests in `tests/e2e/dashboard-regression.spec.js`
  - Covered key E2E flows:
    - Dashboard filters (`status/env/search`) regression
    - Config page novice flow (`generate JSON`) and `test send` end-to-end verification
  - Added Playwright config and scripts:
    - `playwright.config.js`
    - `npm run test:e2e`
    - `npm run test:all`
  - Verified E2E pass locally (2/2)
- 2026-03-10 `T26` completed:
  - Added CI workflow `.github/workflows/ci.yml` with quality gates on every push/PR:
    - lint (syntax checks), unit/API integration, coverage gate, UI E2E
    - docker image build + Trivy vulnerability scan for `agent/dashboard/notify-bridge`
  - Added staged deploy workflow `.github/workflows/staged-deploy.yml` (manual `staging/production` deploy)
  - Added CI/CD documentation:
    - `docs/CI_CD.md`
  - Updated README with CI/CD usage and workflow entry points
- 2026-03-10 `T27` completed:
  - Added one-click ops doctor toolkit:
    - `scripts/ops-doctor.js` (cross-platform)
    - `scripts/ops-doctor.ps1` (Windows wrapper)
    - `scripts/ops-doctor.sh` (Linux/macOS wrapper)
  - Covered diagnostics: service health/readiness, config file parsing, dashboard target diagnose, docker availability, optional Prometheus/Grafana checks
  - Added npm commands:
    - `npm run ops:doctor`
    - `npm run ops:doctor:strict`
  - Added docs:
    - `docs/OPS_TOOLKIT.md`
  - Updated README ops section with quick-start commands
- 2026-03-10 `T28` completed:
  - Added operation handbooks and on-call docs:
    - `docs/OPS_RUNBOOK.md`
    - `docs/ALERT_RUNBOOK.md`
    - `docs/INCIDENT_SOP.md`
    - `docs/ONCALL_HANDOVER.md`
  - Updated README with handbook index section for quick onboarding
- 2026-03-10 `T29` completed:
  - Added Grafana migration runbook:
    - `docs/GRAFANA_MIGRATION_RUNBOOK.md`
  - Added dual-stack availability verification script:
    - `scripts/verify-dual-stack.js`
    - npm commands: `ops:verify-dual-stack` / `ops:verify-dual-stack:strict`
  - Updated README migration section with dual-stack verification step and runbook link
- 2026-03-10 `T30` completed:
  - Added capacity benchmark script:
    - `scripts/capacity-benchmark.js`
    - npm command: `ops:capacity`
  - Ran 100/300/500 target benchmark and generated report:
    - `docs/CAPACITY_REPORT.md`
  - Added capacity methodology and scaling guide:
    - `docs/CAPACITY_GUIDE.md`
  - Updated README with capacity benchmark command and docs links
- 2026-03-10 `T31` completed:
  - Added visual notifications config editor UI in `config.html`:
    - load existing config
    - edit multi-binding and multi-channel
    - save back via API
  - Added dedicated script file:
    - `dashboard/public/config-page.js`
  - Added config read API for editor:
    - `GET /api/config/:type` (admin, env override-safe)
  - Added regression checks:
    - integration check for `CONFIG_EDIT_BLOCKED` on env override
    - E2E check for config editor load-status behavior
- 2026-03-10 `T32` completed:
  - Added config dry-run validation API:
    - `POST /api/config/:type/validate`
  - Added config visual diff preview in config page:
    - `预览变更` button and structured diff output
  - Added `校验配置（不保存）` flow in config page to call validate API and show pass/fail + env override hints
  - Added regression checks:
    - integration checks for validate API ok/invalid payload
    - E2E checks for preview and dry-run validation buttons
- 2026-03-10 `T33` completed:
  - Added release assistant in config page:
    - one-click preflight checklist (`一键发布前检查`)
    - checklist output panel with OK/WARN/FAIL lines
  - Added rollback helper in config page:
    - load notifications backups (`加载备份`)
    - quick rollback to selected backup (`回滚到所选备份`)
  - Added E2E checks for new preflight/backup UI flows
- 2026-03-10 `T34` completed:
  - Added notification message locale presets in backend (`zh-CN` / `en-US`)
  - Added customizable message templates with placeholders for `alert/recover/escalate/test`
  - Added config page UI for locale selection + template preset fill + template textareas
  - Added backend validation for `messageLocale` / `messageTemplates`
  - Updated examples and regression checks (integration + E2E)
- 2026-03-10 `T35` completed:
  - Added per-channel template overrides (`channels[].messageLocale` / `channels[].messageTemplates`)
  - Updated dispatch pipeline to render message per channel (fallback to binding/global templates)
  - Added config page channel-level template editor + variable helper panel
  - Added validation and regression checks (integration + E2E) for channel template override fields
- 2026-03-11 `T36` completed:
  - Added template preview sandbox in config page (no real notification send required)
  - Added sample payload playground fields (event/severity/target/reasons/metrics/escalation)
  - Added binding-vs-channel template source switch and preview metadata (locale/source/event)
  - Added E2E regression checks for template sandbox rendering
- 2026-03-11 `T37` completed:
  - Added per-channel test send selector in config page (`all/current/custom channel`)
  - Extended dashboard test API to support channel filtering (`channel` / optional `channelType`)
  - Added preview history panel (localStorage, keep latest 20) and clear action
  - Added integration + E2E regression checks for channel test send and preview history
- 2026-03-11 `T38` completed:
  - Added one-click template variable copy in config page helper panel
  - Added template snippet import/export UI for binding-level and channel-level templates
  - Added snippet parse/apply logic with status feedback and editor sync
  - Added integration + E2E regression checks for new snippet and copy flows
- 2026-03-11 `UI-01 ~ UI-09` completed:
  - Reworked dashboard visual tokens and hierarchy (topbar/status/KPI/cards/charts/table/detail)
  - Added quick table filters and detail tabs (`全部/故障定位/系统资源`)
  - Added guided novice workflow for config page with one-click switch to full mode
  - Improved responsive behavior, focus-visible accessibility, and reduced-motion handling
  - Updated Playwright E2E flows to cover new dashboard and config guide interactions

## Task List

| ID | Status | Area | Task | Priority | Estimate | Depends On | Acceptance Criteria |
|---|---|---|---|---|---|---|---|
| T01 | completed | Health Checks | Add `/healthz` and `/readyz` for `agent`/`dashboard`/`notify-bridge` | P0 | 0.5d | - | All 3 services return health and readiness responses |
| T02 | completed | Startup Stability | Add process-level exception protection and structured startup logs | P0 | 0.5d | T01 | Crash reason can be located quickly from logs |
| T03 | completed | Alert State | Persist in-memory alert state (Map) to Redis/SQLite | P0 | 1d | - | Restart does not lose dedup/recovery state |
| T04 | completed | Alert Debounce | Alert after N consecutive failures; recover after N consecutive healthy checks | P0 | 1d | T03 | No alert flapping under metric jitter |
| T05 | completed | Alert Silence | Add silence windows per binding/target | P0 | 0.5d | T03 | No sends during silence window |
| T06 | completed | Alert ACK | ACK/Un-ACK with owner and remark | P0 | 1d | T03 | ACK state visible in UI and queryable |
| T07 | completed | Delivery Reliability | Queue + retry + backoff + dead-letter logging | P0 | 1.5d | T03 | Channel hiccups do not drop notifications |
| T08 | completed | Root Cause UI | Add failure reason panel with rules/thresholds/raw values/history | P0 | 1.5d | T04 | "Why failed" visible in one screen |
| T09 | completed | Target Diagnostics | One-click diagnostics: network/token/api/latency | P0 | 1d | - | Can distinguish network/auth/service issues |
| T10 | completed | Config Validation | Add JSON schema validation for targets/alerts/notifications | P0 | 1d | - | Invalid config blocked with precise field errors |
| T11 | completed | Config Backup | Auto backup on each config change and rollback support | P1 | 0.5d | T10 | Can roll back to any recent revision |
| T12 | completed | Access Control | RBAC: read-only/operator/admin | P1 | 2d | - | Role boundaries enforced |
| T13 | completed | Audit Log | Track who changed what and when | P1 | 1d | T12 | Audit is queryable/exportable |
| T14 | completed | Target Metadata | Add tags: env/business/room/owner | P1 | 1d | - | Filter/statistics by tags |
| T15 | completed | Bulk Ops | Bulk import/export + bulk threshold/notification updates | P1 | 1.5d | T14 | 100 targets can be updated in batch |
| T16 | completed | Saved Views | Save filter/sort as reusable views | P1 | 0.5d | T14 | One-click switch among common views |
| T17 | completed | Visualization | Add risk heat sort and incident trend panels | P1 | 1d | T08 | High-risk targets surfaced first |
| T18 | completed | Detail Layout | Split host detail into cards (system/services/TCP/disk), collapsible | P1 | 1d | T08 | Key info discoverable in 3 seconds |
| T19 | completed | Collection Layer | Shared data collection/cache for UI + alert loop | P1 | 1.5d | T04 | Fewer duplicate pulls to target agents |
| T20 | completed | Time Series | Store history in Prometheus (keep existing UI compatible) | P1 | 1.5d | T19 | 7/30 day history query works |
| T21 | completed | Monitoring Standards | Metric naming/labels + rule templates | P1 | 1d | T20 | Add new target without code changes |
| T22 | completed | Secrets | Move tokens to `.env`/secrets, remove plaintext sensitive samples | P1 | 0.5d | - | No sensitive values in repo |
| T23 | completed | API Quality | Add API versioning/pagination/standard error codes | P2 | 1d | - | Docs and behavior consistent |
| T24 | completed | Test Coverage | Unit + API integration tests for core paths | P2 | 2d | T10 | Core coverage >= 70% |
| T25 | completed | UI Regression | E2E for filters/notification settings/test send | P2 | 1.5d | T24 | Pre-release automated regression |
| T26 | completed | CI/CD | Lint/test/build/image scan + staged deploy | P2 | 1.5d | T24 | Quality gates on every merge |
| T27 | completed | Ops Toolkit | One-click diagnostics script for service health/config/connectivity | P2 | 1d | T09 | New engineer can solve most common issues |
| T28 | completed | Documentation | Ops manual + alert manual + incident SOP + on-call guide | P2 | 1d | T08 | New team member can take over quickly |
| T29 | completed | Grafana Migration | Migrate production dashboards to Grafana with notification bridge retained | P2 | 2d | T20 | Dual-stack run is available |
| T30 | completed | Capacity | 100/300/500 target load tests + scaling guidance | P2 | 1.5d | T19 | Capacity curve and bottlenecks documented |
| T31 | completed | Config UX | Visual editor for notifications config (load/edit/save, multi-binding/channel) | P1 | 1d | T11, T12 | Operators can edit and save notifications without hand-writing JSON |
| T32 | completed | Config Safety | Config diff preview + dry-run validation before save | P1 | 0.5d | T31 | Operators can preview changes and validate config without persisting |
| T33 | completed | Config Ops | Release preflight checklist + quick rollback helper in config page | P1 | 0.5d | T31, T32 | Operators can run preflight checks and rollback from UI without manual API calls |
| T34 | completed | Notification UX | Message locale presets + customizable notification templates | P1 | 1d | T31 | Operators can switch locale and customize alert/recover/escalate/test message formats |
| T35 | completed | Notification UX | Per-channel template override + variable helper panel | P1 | 1d | T34 | Operators can keep global/binding templates while customizing message format for specific channels |
| T36 | completed | Notification UX | Template preview sandbox + sample payload playground | P1 | 0.5d | T35 | Operators can preview final rendered messages in UI before sending test notifications |
| T37 | completed | Notification UX | Per-channel test send selector + preview history panel | P1 | 0.5d | T36 | Operators can test only a target channel and review recent preview outputs directly in UI |
| T38 | completed | Notification UX | Template snippet import/export + one-click variable copy | P1 | 0.5d | T37 | Operators can reuse templates across bindings quickly and copy variables without manual typing |

## Milestones

- M1 (Week 1): `T01-T10`
- M2 (Week 2): `T11-T19`
- M3 (Week 3): `T20-T26`
- M4 (Week 4): `T27-T30`
- M5 (Week 5): `T31-T34`
- M6 (Week 6): `T35`
- M7 (Week 7): `T36`
- M8 (Week 8): `T37`
- M9 (Week 9): `T38`

## Definition Of Done

- Code committed and checks passed
- README/ops docs updated
- UI entry available for UI changes
- Regression verification steps documented
- Rollback path exists

## Next Session Prompt

Tasks `T01-T38` are completed.  
Next session can prioritize: stabilization, bugfixes, or user-requested enhancements (suggested next: T39 per-template syntax checker and placeholder lint hints).
