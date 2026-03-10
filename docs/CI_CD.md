# CI/CD Guide

## 1. Workflows

- `ci.yml`
  - Trigger: `push` + `pull_request`
  - Jobs:
    - `quality-gates`: lint + unit/integration + coverage gate
    - `ui-regression-e2e`: Playwright regression tests
    - `docker-image-scan`: build `agent/dashboard/notify-bridge` images and run Trivy scan
- `staged-deploy.yml`
  - Trigger: `workflow_dispatch`
  - Input: `stage` (`staging|production`), `ref`, `compose_file`
  - Action: SSH to deploy host and execute staged docker compose deploy
- `auto-release.yml`
  - Trigger: every `push` to `main` (including merge commits)
  - Action:
    - read latest semver tag (`vX.Y.Z`)
    - auto create next patch tag (`vX.Y.(Z+1)`)
    - push tag to origin
    - publish GitHub Release with generated notes
  - Skip rule: if current commit already has a semver tag, workflow will skip auto tagging

## 2. Required Repo Secrets

For `staged-deploy.yml`:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`

Recommended: configure GitHub Environments `staging` / `production` and enable approval rules.

For `auto-release.yml`:

- No extra secret required (uses `GITHUB_TOKEN`)
- Ensure repository setting **Workflow permissions** is set to **Read and write permissions** (so Actions can push tags)

## 3. Quality Gate Rules

- `npm run lint` must pass
- `npm test` must pass
- `npm run test:coverage` must pass
  - Current enforced threshold is on `dashboard/lib/api-utils.js`
- Playwright E2E must pass
- Trivy scan exits non-zero on `HIGH/CRITICAL` vulnerabilities

## 4. Local Preflight

Run before pushing:

```bash
npm run lint
npm test
npm run test:coverage
npm run test:e2e
```
