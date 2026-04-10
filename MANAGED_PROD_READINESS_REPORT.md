# Managed production readiness report

This document describes how far the repo is suited for **operator-led / managed** deployments (no public self-serve SaaS, no billing in scope). It summarizes strengths, residual risks, what changed in the latest hardening pass, and what still blocks “enterprise-grade” readiness.

---

## Managed-product strengths

- **Docker-first path:** `./scripts/start.sh` brings up Postgres, Redis, migrate + seed, API, worker, then probes readiness and runs a lite smoke test.
- **Fail-fast production boot:** `utils/bootValidate.js` requires `DATABASE_URL`, `REDIS_URL`, OpenAI/KMS/CORS rules (with documented escape hatches). Worker validates DB + Redis in production.
- **Readiness semantics:** `GET /api/ready` checks DB (always), and in production Redis + default bootstrap tenant — reduces “green health but broken app” for the orchestration layer.
- **Tenant lifecycle without SQL:** Admin UI (`/admin`), shared `services/tenantProvisioning.js`, and `scripts/tenant-cli.js` for create, list, verify, bootstrap prompts, rotate integration key.
- **Observability hooks:** `/api/health` vs `/api/ready` separation; worker HTTP health on a dedicated port; structured `checks` and optional `hints` on ready responses.
- **Operator documentation:** `README.md`, `INSTALL_RUN.md`, `DEPLOY_CHECKLIST.md`, `ONE_CLICK_IMPLEMENTATION_REPORT.md`, `ADMIN_ONBOARDING_REPORT.md`, and this report.

---

## Risks remaining

- **No first-party admin authentication** for standalone installs — `/admin` and admin APIs still assume **platform SSO** (or dev Bearer). This is the largest gap for “install anywhere” enterprise stories.
- **Secrets at rest:** Tenant OpenAI keys use KMS when configured; operators must still manage rotation, backup encryption, and secret manager integration outside the repo.
- **No automated backups** inside the application — Postgres/Redis durability depends on platform practices (see `scripts/backup-postgres.example.sh`).
- **CORS and TLS** are environment concerns; misconfiguration can look like “app bugs” in the browser.
- **Readiness vs. functional correctness:** `/api/ready` can return 200 while specific tenants lack keys; `hints` and per-tenant verify reduce but do not eliminate that class of issue.

---

## Exact changes made in this pass

| File / area | Change |
|-------------|--------|
| `server.js` | `getAdminServerHints()`; startup calls `logRuntimeModeHint` + `logProductionBootWarnings`; `/api/ready` returns `hints`; admin list/create/verify/rotate responses enriched as described in `ADMIN_ONBOARDING_REPORT.md`. |
| `workers/queueWorker.js` | Same boot hint + warning logging as API worker process. |
| `services/tenantProvisioning.js` | `verifyTenantForAdmin` takes env hints; returns `readyForChat`, `badges`, `warnings`, `serverHints`. |
| `scripts/tenant-cli.js` | Verify passes env hints; prints badges/warnings; exit code **2** if chat blocked. |
| `public/admin/admin.js`, `public/admin/admin.css`, `templates/admin.html` | Environment banner, tenant list flags, verify output, provision hints, stronger rotate messaging; asset `v=5`. |
| `scripts/troubleshoot.sh` | One-shot diagnostics (health, ready, worker, compose logs). |
| `scripts/backup-postgres.example.sh` | Documented `pg_dump` / restore patterns (no auto-backup). |
| `README.md`, `INSTALL_RUN.md`, `DEPLOY_CHECKLIST.md`, `ADMIN_ONBOARDING_REPORT.md`, `ONE_CLICK_IMPLEMENTATION_REPORT.md` | Updated for the above; cross-links to this report. |

---

## What an operator can now reliably do

- Deploy with Compose, confirm **liveness** and **readiness**, and interpret **503** reasons (`database_*`, `redis_*`, `bootstrap_tenant_missing`).
- Read **`hints`** on a ready response and **`[boot]`** logs for escape hatches and `NODE_ENV` mistakes.
- Run **`./scripts/troubleshoot.sh`** for a quick snapshot when something fails.
- Onboard tenants via **`/admin`** or CLI with clearer **warnings** when global OpenAI is missing, integration keys are skipped, or chat is not viable.
- Use **Verify readiness** (or CLI) to see **badges** and structured **warnings** per tenant.
- Rotate integration keys with explicit **API and UI messaging** about immediate invalidation of the old key.
- Follow **`INSTALL_RUN.md`** recovery tables for lost keys, bad slugs, Redis/Postgres restarts, and secret misconfiguration.

---

## What still blocks “enterprise-grade” readiness

- **Durable first-party operator authentication** (SSO integration is not a substitute for every customer’s IdP story without more product work).
- **Formal backup/restore automation** tested per environment (scripts here are guidance only).
- **SLO-oriented monitoring** (metrics, tracing, alerting integrations) — not included in this repo.
- **Pen-test / compliance packaging** beyond existing RBAC and audit hooks — out of scope for this pass.

---

## Scores (subjective)

| Dimension | Score | Notes |
|-----------|-------|--------|
| **Managed production readiness** | **8.7 / 10** | Boot + ready + hints + runbook scripts + docs; backups and SSO still external concerns. |
| **Admin onboarding** | **8.2 / 10** | Stronger verify/provision/rotate UX; still blocked by lack of standalone admin auth for some installs. |

---

## Single biggest remaining blocker

**First-party admin / operator authentication** for deployments that do not use the bundled platform SSO — without it, `/admin` remains awkward for pure standalone operator-led installs (CLI and Bearer workarounds only).
