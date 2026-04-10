# Deployment audit — Question-Mark-Bot (“Solomon”)

This document is grounded in the repository as of the audit date. It describes what must run, how configuration flows, and how far the project is from a true one-click customer deploy.

## 1. Repository topology

| Area | Role | Notes |
|------|------|--------|
| `server.js` | HTTP API, SSR-style admin shell, static hosting | Single process; loads `.env` via `dotenv` |
| `public/` | Embed widget assets (`solomon.js`, `solomon.css`), admin UI assets | Served by Express |
| `templates/` | `admin.html`, `chat.html` | Read from disk at request time |
| `prompts/tenants/<slug>/` | Default prompt files (`systemprompt.md`, `policy.md`, `voice.md`) | Overridable by DB `Tenant.prompts`; `PROMPTS_DIR` env |
| `workers/queueWorker.js` | BullMQ consumer on queue `events` | **Exits with code 1 in production if `REDIS_URL` is unset** |
| `prisma/` | PostgreSQL schema + migrations | `DATABASE_URL` required in production boot |
| `integrations/` | Inbound adapters, outbound webhooks | Tenant config in DB (`settings`, `LeadWebhook`) |
| `ecosystem.config.js` | PM2 example | Not wired into npm scripts |
| `load-env.sh` | AWS SSM → `.env` | Operator must have AWS CLI + IAM; not portable |

There is **no separate frontend build** (no React/Vite bundle). There is **no self-hosted model service**: inference is **OpenAI’s HTTP API** (`openai` npm package).

## 2. Runtime components

### 2.1 Application tier

- **Backend / “frontend” delivery**: one Node.js (Express 5) service (`server.js`), default port **8080** (`PORT`).
- **Background worker**: second Node process (`npm run worker` → `workers/queueWorker.js`), same codebase, requires **Redis**.

### 2.2 Data stores

- **PostgreSQL**: sole database via Prisma. All tenant config, conversations, leads, knowledge chunks, webhooks, etc.
- **Redis**: BullMQ + optional **distributed rate limiting** (`utils/rateLimit.js`). If absent, server warns and falls back to in-process rate limits and synchronous webhook/email attempts where implemented; **worker will not run in production** without Redis.

### 2.3 Queues

- **BullMQ** queue name: `events` (`utils/jobQueue.js`, `workers/queueWorker.js`).
- Job types include: `admin-log`, `integration-webhook`, `lead-webhook`, `lead-notification-email`, `persist-outbox-success`.

### 2.4 File / object storage

- **No S3/minio integration** in code paths reviewed. Knowledge content lives in **Postgres** (`KnowledgeDocument` / `KnowledgeChunk`). Prompts can be **files on disk** or **JSON in DB**.

### 2.5 Model / runtime services

- **OpenAI API** (cloud). Model selection: `utils/modelPolicy.js`, tenant policy, `DEFAULT_MODEL` env; default model string `gpt-4o-mini`.
- **RAG** (`services/rag.js`): keyword overlap over stored chunks — **no embedding service**, no vector DB.

### 2.6 External APIs & integrations

- **OpenAI** (required for chat unless every tenant has `openaiKey` in DB).
- **Google APIs** (`googleapis`) for OAuth flows when tenants configure Google.
- **Platform SSO** (`middleware/platformSSO.js`): calls `PLATFORM_URL/auth/verify` when a Bearer/cookie platform token is present.
- **Optional “admin” log sink** (`adminClient.js`): HTTP posts to `ADMIN_URL` with `ADMIN_KEY` / `ADMIN_CUSTOMER_KEY`.
- **Outbound webhooks**: customer endpoints (HMAC); **inbound** integrations via `/api/integrations/v1/inbound/:provider` with tenant API key.
- **SMTP**: per-tenant fields in DB (`smtpHost`, …) via `services/leadEmailDelivery.js` — not a global env requirement for that path.

### 2.7 Local binaries

- **Node.js 20+** (smoke script expects global `fetch`; CI uses Node 20).
- **PostgreSQL** client libraries: Prisma/OpenSSL (Dockerfile installs `openssl` for typical Prisma images).
- **`load-env.sh`**: AWS CLI for SSM.

### 2.8 Build steps

- `npm ci` (or `npm install`).
- `npx prisma generate` (required before running if `node_modules` fresh; **not** declared in `package.json` `postinstall` today).
- `npx prisma migrate deploy` (or equivalent) against the target database **before** serving traffic.
- No webpack/tsc build; server runs plain CommonJS.

## 3. Environment variables (inventory)

Variables observed in application code (non-test). **Production-critical** behavior depends on several not validated at boot.

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `production` enables stricter paths (CORS, cookies, HTTPS redirect for some flows, KMS, worker exit) |
| `PORT` | HTTP port (default 8080) |
| `DATABASE_URL` | PostgreSQL connection | **Required in production** (`utils/bootValidate.js`) |
| `REDIS_URL` | Redis for BullMQ + rate limiter | **Required for worker in production**; optional for API with degraded behavior |
| `OPENAI_API_KEY` | Fallback API key when tenant has no `openaiKey` | Effectively required for `/message` to work for typical tenants |
| `KMS_MASTER_KEY` | AES envelope for tenant secrets | **Required in production when `encrypt()` runs** (e.g. Google token storage) — see `utils/kms.js` |
| `CORS_ORIGINS` | Comma-separated allowlist | **If empty in production, CORS rejects browser `Origin`** (`server.js`) |
| `DEFAULT_TENANT` | Fallback tenant slug | |
| `PROMPTS_DIR` | Override prompt file root | |
| `HOT_RELOAD_PROMPTS` | `1` to disable prompt file cache | |
| `PLATFORM_URL` | Platform SSO verify endpoint base | Defaults to `http://localhost:4000` |
| `STRICT_TENANT_BINDING` | `1` enforces platform tenant vs header/query match | |
| `PLATFORM_COOKIE_SAMESITE` | Cookie SameSite for platform flows | |
| `DISABLE_CSRF` | `1` skips CSRF middleware | |
| `CSP_EMBED_FRAME_ANCESTORS` | CSP `frame-ancestors` for embed | |
| `MESSAGE_RATE_*`, `AUTH_RATE_*`, `PUBLIC_EMBED_RATE_MAX` | Rate limits | |
| `BLOCK_PROMPT_INJECTION` | `1` blocks flagged messages | |
| `DEFAULT_MONTHLY_CAP_USD` | Cost cap fallback | |
| `DEFAULT_MODEL` | Model fallback | |
| `MAX_MESSAGE_CHARS` | Guardrail length | |
| `ALLOW_ADMIN_BEARER_DEV_TOOLS` | Hides dev admin tools in production when unset | |
| `ENABLE_HEARTBEAT` | `1` enables periodic `logSuccess` | |
| `ADMIN_URL`, `ADMIN_KEY`, `ADMIN_CUSTOMER_KEY` | External admin logging | |
| `LOG_WRITE_MODE`, `LOG_FALLBACK_LOCAL_ON_FAIL`, `ADMIN_LOG_ASYNC` | Admin client behavior | |
| `EVENTS_WORKER_CONCURRENCY`, `EVENTS_WORKER_LOCK_MS` | Worker tuning | |
| `WORKER_HEALTH_PORT` | If &gt; 0, worker exposes `/health` and `/ready` on HTTP | |
| `LEAD_EMAIL_JOB_ATTEMPTS`, `LEAD_EMAIL_BACKOFF_MS` | Queue retry policy | |
| `SMOKE_BASE_URL`, `SMOKE_TENANT` | `smoke-readiness.js` | |

`ecosystem.config.js` also references `LEAD_EMAIL_USER`, `LEAD_EMAIL_PASS`, `LEAD_EMAIL_TO`, `TENANT`, branding env vars — these are **not** used by `services/leadEmailDelivery.js` (tenant DB drives SMTP). Treat as **legacy/PM2-only** unless you verify otherwise.

## 4. Health checks (existing)

| Endpoint / mechanism | Behavior |
|----------------------|----------|
| `GET /api/health` | JSON liveness; **no DB** |
| `GET /api/ready` | `SELECT 1` with 2s timeout → 503 on failure |
| Worker | HTTP `/health` and `/ready` **only if** `WORKER_HEALTH_PORT` &gt; 0 |
| `npm run smoke:prod` | `smoke-readiness.js` — hits health, ready, optional `/message` |

**Updated (productization pass):** `GET /api/ready` in **production** now verifies **Postgres**, **Redis** (`PING`), and presence of the **`DEFAULT_TENANT`** row. Docker Compose runs **migrate + seed** before `api`/`worker`. See `ONE_CLICK_IMPLEMENTATION_REPORT.md`.

## 5. One-click deploy score: **8 / 10**

**Rationale:** Docker Compose is the **primary** path (`docker-compose.yml`, `Dockerfile`, `./scripts/start.sh`). **Migrations + Prisma seed** remove manual SQL. **Boot validation** enforces `DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY` (unless opted out), `KMS_MASTER_KEY` (unless opted out), and `CORS_ORIGINS` (unless opted out) in production. **Health** and **readiness** are documented and scripted. Remaining gaps: operators must still **supply a real `OPENAI_API_KEY`**, **TLS/reverse proxy** is external, **`load-env.sh`** remains AWS-specific for secret fetch, and **second-tenant provisioning** is not a guided product flow.

## 6. Fastest path to client-deployable

1. `cp .env.example .env` → set **`OPENAI_API_KEY`**; replace demo **`KMS_MASTER_KEY`** for real environments.
2. **`./scripts/start.sh`** — builds stack, waits for readiness, runs **`scripts/healthcheck.sh`**, lite smoke.
3. Open **`http://127.0.0.1:8080/admin`** (adjust `HOST_PORT` if needed).

## 7. Recommended deploy architecture (practical)

- **Small / single customer:** one VM or single Compose stack: `postgres` (volume), `redis` (volume or ephemeral if acceptable), `api` ×1, `worker` ×1, TLS via reverse proxy (Caddy/Traefik/nginx).
- **Scale-out:** multiple API replicas behind a load balancer; **one Redis**; **one Postgres**; **multiple workers** (BullMQ supports); ensure `trust proxy` and sticky sessions if you add stateful cookies without shared secret discipline (you already use `trust proxy: 1`).
- **Secrets:** inject via platform secret store (SSM, Vault, K8s secrets); **never** bake into images. **Rotate** `KMS_MASTER_KEY` only with a documented re-encryption strategy (not implemented in-repo).

## 8. Logging & failure recovery

- Today: `console.error` / `console.log` in many paths; audit helpers write to DB (`utils/audit.js`).
- **Recommendation:** process manager or container runtime captures stdout; add structured JSON logging in a follow-up; alert on **worker exit** (production fatal when Redis missing) and on **503** from `/api/ready`.

---

*Generated as part of the deployment productization audit.*
