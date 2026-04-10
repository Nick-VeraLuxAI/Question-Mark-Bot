# One-click deploy — gap report

**Status (post-implementation):** Critical packaging items (Compose, seed, boot checks, README, health/readiness depth, `start.sh`) are **implemented**. **Additional tenants** are provisioned via **`scripts/tenant-cli.js`** / **`npm run tenant:*`** (no SQL). See **`ONE_CLICK_IMPLEMENTATION_REPORT.md`** for the authoritative change list. Residual work is mostly **TLS**, **secret distribution** (e.g. SSM still optional), and **self-service / in-app tenant UX** (dashboard still leans on platform SSO).

---

*Original assessment below — many critical rows are now addressed in-tree.*

Brutal summary: this repo is a **coherent monolith** with good internal docs under `docs/`, but it ships **without** the packaging layer (Compose, env template, README runbook, seed, strict boot checks) that non-experts need. **One-click is not achieved** until orchestration + bootstrap + validation are first-class.

## Blocker categories

### Critical (must fix for true one-click deploy)

| ID | Blocker | Evidence |
|----|---------|----------|
| C1 | **No bundled orchestration** for Postgres + Redis + API + worker + migrations | No `docker-compose.yml` / `Dockerfile` in repo before remediation; two processes must run |
| C2 | **Worker hard-fails in production without Redis** | `workers/queueWorker.js` exits `1` when `REDIS_URL` unset and `NODE_ENV=production` |
| C3 | **Production CORS defaults to “deny all browsers”** if `CORS_ORIGINS` empty | `server.js` — operators will see opaque CORS failures |
| C4 | **No root runbook** | No `README.md`; only partial docs in `docs/*` |
| C5 | **No committed env contract** | No `.env.example`; env spread across code and `ecosystem.config.js` |
| C6 | **Database schema not applied by npm lifecycle** | `package.json` has no `db:migrate` / `postinstall` prisma generate — fresh clone fails until operator runs Prisma manually |
| C7 | **Tenant / bootstrap data not automated** | Multi-tenant resolution expects rows in `Tenant`; no seed script in repo — **new instance has no tenant until manual SQL/admin** |
| C8 | **`KMS_MASTER_KEY` required for production encrypt paths** | `utils/kms.js` throws on `encrypt()` without key in production — Google OAuth token storage uses `encrypt` in `server.js` |
| C9 | **Secret loading script is AWS-only** | `load-env.sh` assumes SSM path `/solomon` — not usable on generic VPS |

### Important (should fix for reliability)

| ID | Blocker | Evidence |
|----|---------|----------|
| I1 | **Boot validation incomplete** | `utils/bootValidate.js` only enforces `DATABASE_URL`; warns on missing `REDIS_URL` but does not align with worker’s hard requirement |
| I2 | **Readiness omits Redis and queue depth** | `/api/ready` only checks Postgres |
| I3 | **Rate limiting silently falls back to per-process memory** when Redis down | `utils/rateLimit.js` — misleading under multiple API replicas |
| I4 | **PM2 config port default (10000) ≠ server default (8080)** | `ecosystem.config.js` vs `server.js` — confusion for operators |
| I5 | **CI does not run migrations or integration tests with real DB/Redis** | `.github/workflows/ci.yml` — `npm test` only |
| I6 | **OpenAI key not validated at boot** | Chat fails at runtime if neither env nor tenant key exists |
| I7 | **Platform SSO defaults to localhost** | `PLATFORM_URL` — wrong for production if SSO used |

### Nice to have (polish)

| N1 | Heartbeat env (`ENABLE_HEARTBEAT`) undocumented in one place | scattered |
| N2 | Smoke test optional `/message` requires `SMOKE_TENANT` | `smoke-readiness.js` |
| N3 | Legacy env vars in `ecosystem.config.js` (`LEAD_EMAIL_*`) may confuse | grep shows no server use |

## Remediation plan (concrete)

| Step | File(s) | Action |
|------|---------|--------|
| 1 | `docker-compose.yml`, `Dockerfile`, `.dockerignore` | Run Postgres, Redis, migrate job, API, worker with health dependencies |
| 2 | `.env.example` | Single source of truth for variable names and comments |
| 3 | `scripts/start.sh` | Documented local path: optional `docker compose up` wrapper or migrate + dual process |
| 4 | `scripts/healthcheck.sh` | Curl `/api/health`, `/api/ready`; optional worker port |
| 5 | `DEPLOYMENT_AUDIT.md` (this audit set) | Operator-facing truth |
| 6 | `package.json` | Add `db:migrate`, `db:generate` scripts (minimal) |
| 7 | **Follow-up PR** | `prisma/seed.js` + `"prisma": { "seed": ... }` creating default tenant and admin user |
| 8 | **Follow-up PR** | Expand `bootValidate.js`: `CORS_ORIGINS` in production, `REDIS_URL` if `WORKER_REQUIRED=1`, document `KMS_MASTER_KEY` |
| 9 | **Follow-up PR** | `README.md` with “5-minute deploy” using Compose only |

## Config strategy for per-client deployments

- **Prefer DB + `Tenant.settings` JSON** for branding, integrations, webhooks (already the pattern).
- **Use env for deployment-wide** secrets: `DATABASE_URL`, `REDIS_URL`, `KMS_MASTER_KEY`, `OPENAI_API_KEY` (fallback), `CORS_ORIGINS`, `PLATFORM_URL`.
- **Avoid** new per-client code branches; add tenants via DB and `prompts/tenants/<slug>/` or DB prompts only.

## Secrets / env strategy

- **Development:** `.env` gitignored; copy from `.env.example`.
- **Production:** platform secrets (SSM, Vault, etc.); **rotate** API keys per tenant where possible (`openaiKey` in DB).
- **KMS_MASTER_KEY:** treat like a root encryption key; backup and access control are deployment concerns (not solved in app code).

## Health check strategy

- Load balancer: `GET /api/ready` (not just `/api/health`).
- Worker: set `WORKER_HEALTH_PORT` and probe `/ready`.
- Post-deploy: `npm run smoke:prod` with `SMOKE_BASE_URL` and optional `SMOKE_TENANT`.

## Logging & recovery

- Run API and worker under a supervisor (Docker restart policy, systemd, k8s Deployment).
- Alert on **restarts** of worker container — BullMQ jobs retry but operator visibility is thin today.
- **Redis persistence:** AOF/RDB for production if job durability matters during Redis restarts.

---

## Deployment model that fits **right now**

**Docker Compose** (or “Compose-equivalent” on a single host) is the best fit: two Node processes, Postgres, Redis, no GPU, no desktop shell, not inherently multi-tenant SaaS unless you operate one stack per customer or shared stack with row-level tenancy.

Not a fit as primary story today: **Electron/desktop** (this is a web service), **pure single install script without containers** (you still need Postgres + Redis installed somehow — script becomes a thin wrapper around package managers).

**Cloud SaaS** is a *business* model; technically the same codebase can be hosted multi-tenant, but the repo does not include tenant signup, billing, or per-tenant infra automation.

**Hybrid local + cloud control plane** applies if you keep using **platform SSO** (`PLATFORM_URL`) — then you have a **dependency on an external platform** for operator auth, which is a deployment coupling to document explicitly.
