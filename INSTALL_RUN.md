# Install and run — operator runbook

## Intended flow

1. Clone the repository.
2. `cp .env.example .env` and set **`OPENAI_API_KEY`** (mandatory for chat).
3. **`./scripts/start.sh`** — single entrypoint for Docker Compose.

No manual SQL: the **`migrate`** service runs **`prisma migrate deploy`** then **`prisma db seed`**, which upserts the default tenant (`DEFAULT_TENANT`, default `default`).

## New customer / new tenant (after deploy)

### Dashboard (default)

1. Sign in via **platform SSO** with role **operator**, **admin**, or **owner**.
2. Open **`/admin`** → section **Tenant onboarding**.
3. Create tenant, then **Verify readiness** / **Bootstrap prompts** / **Rotate integration key** as needed.

See **`ADMIN_ONBOARDING_REPORT.md`** for API routes and auth details.

### CLI (optional)

Use **`scripts/tenant-cli.js`** — no SQL, idempotent rules (fails if slug exists unless `--force`).

**With Docker Compose** (Postgres is not published on the host by default):

```bash
docker compose exec -T api node scripts/tenant-cli.js create --slug acme --name "Acme Corp"
```

The command prints a **`qmb_*` integration API key** once; store it for `X-Api-Key` / Bearer on inbound integration routes.

| Command | Purpose |
|---------|---------|
| `node scripts/tenant-cli.js list` | All tenants (summary) |
| `node scripts/tenant-cli.js verify --slug <slug>` | Row exists + OpenAI / integration key / prompts + readiness badges and warnings (exits **2** if chat is blocked) |
| `node scripts/tenant-cli.js bootstrap-prompts --slug <slug>` | Copy `prompts/tenants/default/*.md` into `prompts/tenants/<slug>/` if missing |

npm equivalents: `npm run tenant:list`, `npm run tenant:create -- --slug … --name "…"`, etc.

### Config: where things live

1. **Prisma `Tenant` columns** — identity (`id`, `subdomain`, `name`, `plan`), branding, `openaiKey`, SMTP, OAuth.
2. **`Tenant.settings` JSON** — integrations, embed appearance; see `docs/integration-architecture.md`.
3. **`Tenant.prompts` JSON** — optional DB prompt overrides.
4. **`prompts/tenants/<subdomain>/`** — optional files (`systemprompt.md`, `policy.md`, `voice.md`); app merges with default tenant.

**Embed / chat resolution:** `X-Tenant` header, `?tenant=`, or subdomain of host → must match `Tenant.id` or `Tenant.subdomain`.

## Startup order (Docker Compose)

1. **postgres** — waits until healthy (`pg_isready`).
2. **redis** — waits until healthy (`PING`).
3. **migrate** — one-shot: migrations + seed, then exits successfully.
4. **api** and **worker** — start after migrate completes; both use the same image and env file.

Persistence: named volumes **`solomon_pgdata`**, **`solomon_redisdata`**.

## Bootstrap / seed

- **File:** `prisma/seed.js`
- **Command:** `npm run db:seed` (or invoked automatically after migrate in Compose).
- **Effect:** `upsert` on `Tenant` with `id` = `DEFAULT_TENANT` (default `default`), `name` = `Default`, `subdomain` aligned with slug.
- **Idempotent:** safe to re-run.

## Verify the worker

The worker exposes HTTP health when **`WORKER_HEALTH_PORT=9090`** (set in Compose for the `worker` service).

```bash
curl -sf http://127.0.0.1:9090/health
```

Host port defaults to **9090** (`WORKER_HOST_PORT`).

## Readiness semantics

**`GET /api/ready`** when **`NODE_ENV=production`**:

- PostgreSQL: `SELECT 1` (2s timeout).
- Redis: `PING` via the shared rate-limit client (`REDIS_URL`).
- Bootstrap: a `Tenant` row must exist for **`DEFAULT_TENANT`** (by `id` or `subdomain`).

Non-production: only the database check runs (keeps local tests/dev lightweight).

On **any** successful ready response, the JSON includes **`hints`** (may be empty). Example: a warning when some tenants have no `openaiKey` while **`OPENAI_API_KEY`** is unset and **`OPENAI_BOOT_OPTIONAL`** is not `1`. The service can still be “ready” while chat would fail for those tenants — use **`/admin`** → **Verify readiness** or **`tenant:verify`** per slug.

## Boot logs (production)

On startup, **`utils/bootValidate.js`** may log:

- **`[boot] Production configuration validation passed`** after required env checks.
- **`[boot] Production configuration notes`** when escape hatches are set (`ALLOW_EMPTY_CORS_IN_PRODUCTION`, `SKIP_KMS_MASTER_KEY`, `OPENAI_BOOT_OPTIONAL`).
- **`[boot] NODE_ENV is not production`** when `NODE_ENV` is missing or `development` (API and worker).

## Structured troubleshooting

From the repo root (with Docker Compose or reachable `SMOKE_BASE_URL`):

```bash
./scripts/troubleshoot.sh
# or
SMOKE_BASE_URL=https://api.example.com ./scripts/troubleshoot.sh
```

## Backups

There is no automatic backup inside the app. See **`scripts/backup-postgres.example.sh`** for `pg_dump` / `pg_restore` patterns and schedule backups with your platform (volume snapshots or logical dumps). Test a restore in staging before relying on it in production.

## Smoke tests

- **Lite (default in `start.sh`):** `SMOKE_LITE=1` — no `POST /message`, so no OpenAI token use.
- **Full:** `SMOKE_LITE=0` and `SMOKE_TENANT=default` — exercises `/message` (uses OpenAI).

```bash
docker compose exec -T -e SMOKE_BASE_URL=http://127.0.0.1:8080 -e SMOKE_TENANT=default -e SMOKE_LITE=0 api node smoke-readiness.js
```

## Recover from a failed startup

1. **Inspect logs:** `docker compose logs migrate`, `api`, `worker`.
2. **Re-run migrations + seed:**  
   `docker compose run --rm migrate`  
   (runs `sh -c "npx prisma migrate deploy && npm run db:seed"`).
3. **Restart app processes:** `docker compose up -d api worker`.
4. **Nuclear reset (dev only):** `docker compose down -v` — **destroys database and Redis data**.

## Recover from common operator mistakes

| Situation | What to do |
|-----------|------------|
| **Lost integration key** | **`/admin`** → **Rotate integration key** for that tenant, or `tenant-cli` / API rotate route; update all clients with the new `qmb_*` value. |
| **Bad tenant slug / wrong `DEFAULT_TENANT`** | Fix env + DB row (`id` / `subdomain`), or re-provision with **`force`** from admin/CLI; re-run seed if bootstrap tenant is missing. |
| **Redis or Postgres restarted** | Processes reconnect on next use; if the API stays unhealthy, check **`REDIS_URL`** / **`DATABASE_URL`** and **`docker compose ps`**. |
| **Secret misconfiguration** | Fix `.env` / secret manager, restart **api** and **worker**; read **`[boot]`** stderr for missing vars in production. |
| **Chat works in dev but not prod** | Confirm **`NODE_ENV=production`**, **`OPENAI_API_KEY`** or per-tenant keys, and **`/api/ready`** + **Verify readiness** output. |

## Run without Docker (developers)

```bash
cp .env.example .env
# Run Postgres and Redis locally; set DATABASE_URL and REDIS_URL
npm ci
npm run db:deploy
npm start
# second terminal:
npm run worker
```

Use **`HEALTHCHECK_RELAXED=1 ./scripts/healthcheck.sh`** if `NODE_ENV` is not `production`.
