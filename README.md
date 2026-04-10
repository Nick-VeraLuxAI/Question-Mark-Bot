# Question-Mark-Bot (Solomon)

Embeddable AI chat backend: **Node.js + Express**, **PostgreSQL** (Prisma), **Redis** (BullMQ queues and rate limiting), **OpenAI** for inference. Static embed and admin UI are served from this repo (`public/`, `templates/`) — there is no separate frontend build step.

**Commercial model (productization):** Solomon is positioned as a **dedicated managed deployment per customer** — each paying customer gets **their own** isolated stack (this repo deployed once per customer by default). **Tenants** in the database are **internal** brands/sites **within** that customer’s environment, not a default “shared SaaS for many unrelated companies.” See **`PRODUCT_DEFINITION.md`**, **`PACKAGING_STRATEGY.md`**, and **`PRODUCT_TIERS.md`** for sales and operator language; **`PRICING_MODEL.md`** for dedicated-instance economics.

## Prerequisites

- **Docker** and **Docker Compose v2** (recommended path)
- An **OpenAI API key** (required for real chat; set in `.env`)
- **Node.js 20+** only if you run the app on the host without Docker

## Fastest deploy (one command after env)

```bash
git clone <repo-url> Question-Mark-Bot
cd Question-Mark-Bot
cp .env.example .env
# Edit .env: set OPENAI_API_KEY (required). KMS_MASTER_KEY is pre-filled for local demo — replace for production.
./scripts/start.sh
```

**What `start.sh` does:** validates required secrets, runs `docker compose up --build -d` (Postgres, Redis, migrations, **Prisma seed** default tenant, API, worker), waits for `/api/ready`, runs `scripts/healthcheck.sh`, runs a **lite** in-container smoke test (health + ready; no OpenAI call by default).

## Where to open the app

- **API:** `http://127.0.0.1:8080` (or `HOST_PORT` from `.env`)
- **Admin UI:** `http://127.0.0.1:8080/admin`
- **Worker health:** `http://127.0.0.1:9090/health` (or `WORKER_HOST_PORT`)

## Health checks

From the host (after the stack is up):

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 ./scripts/healthcheck.sh
```

For a **non-production** API (no redis/tenant checks in `/api/ready`):

```bash
HEALTHCHECK_RELAXED=1 SMOKE_BASE_URL=http://127.0.0.1:3000 ./scripts/healthcheck.sh
```

**Readiness payload:** when `status` is `ready`, the JSON may include a **`hints`** array (for example, tenants without a per-tenant OpenAI key while the server has no `OPENAI_API_KEY`). The process also logs **`[boot]`** lines in production for escape hatches (`ALLOW_EMPTY_CORS_IN_PRODUCTION`, `SKIP_KMS_MASTER_KEY`, `OPENAI_BOOT_OPTIONAL`).

**First-line troubleshooting:** from the repo root with the stack running, **`./scripts/troubleshoot.sh`** prints health, ready, worker status, and recent Compose logs.

## Environment setup

See **`.env.example`** for the full contract:

| Required | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Chat when tenants have no DB `openaiKey` |
| `KMS_MASTER_KEY` | Encrypt tenant secrets at rest (or `SKIP_KMS_MASTER_KEY=1`) |
| `CORS_ORIGINS` | Browser API access (Compose sets localhost defaults if omitted in compose file) |

Docker Compose overrides **`DATABASE_URL`** and **`REDIS_URL`** for `api` / `worker` to use internal hostnames.

## Tenants & provisioning (no SQL)

### Preferred: Admin dashboard

After deploy, open **`/admin`** with **platform SSO** (operator / admin / owner role). Use the **Tenant onboarding** section to **create** a tenant, **verify** readiness, **bootstrap** prompt files, and **rotate** the integration API key. No CLI required for routine onboarding.

See **`ADMIN_ONBOARDING_REPORT.md`** for routes, permissions, and limits.

### CLI (automation, Docker exec, CI)

```bash
# Inside the api container (correct DATABASE_URL)
docker compose exec -T api node scripts/tenant-cli.js create --slug acme --name "Acme Corp"

# Host with DATABASE_URL to Postgres
npm run tenant:create -- --slug acme --name "Acme Corp"
```

**Other commands:** `npm run tenant:list`, `npm run tenant:verify -- --slug acme`, `npm run tenant:bootstrap-prompts -- --slug acme`  
Shell wrapper: `./scripts/create-tenant.sh --slug acme --name "Acme Corp"`

Integration keys are shown **once** after create or rotate — save them.

### Tenant configuration model (recommended)

| Layer | Use for |
|-------|---------|
| **`Tenant` columns** (`name`, `subdomain`, `plan`, branding fields, `openaiKey`, SMTP, OAuth fields) | Stable, queryable, UI-friendly settings |
| **`Tenant.settings` JSON** | Integrations (`integrations.*`), embed theme, feature flags — see `docs/integration-architecture.md` |
| **`Tenant.prompts` JSON** | Optional DB overrides for system / policy / voice |
| **`prompts/tenants/<subdomain>/`** | File-based prompts; merged after DB and default tenant (see `loadPromptsDBFirst` in `server.js`) |

**Minimum for a usable chat tenant:** a row with **`id` = `subdomain` = slug**, **`name`**, and either **`openaiKey`** or a working global **`OPENAI_API_KEY`**. Integration **`apiKeyHash`** is optional for embed chat; **required** for authenticated inbound integration routes.

**Verify a tenant:** use **Verify readiness** in `/admin`, or `npm run tenant:verify -- --slug acme` / `docker compose exec api node scripts/tenant-cli.js verify --slug acme`.

## Useful commands

| Command | Purpose |
|---------|---------|
| `docker compose logs -f api worker` | Follow logs |
| `docker compose down` | Stop stack |
| `npm run db:deploy` | Migrate + seed (host with DB reachable) |
| `docker compose exec -T api node scripts/tenant-cli.js list` | List tenants (preferred when using Compose) |
| `npm run tenant:create -- --slug … --name "…"` | Create tenant (needs `DATABASE_URL` to Postgres) |
| `SMOKE_LITE=0 SMOKE_TENANT=default npm run smoke:prod` | Full smoke including `/message` (uses OpenAI) |

## Common failure points

1. **Empty `OPENAI_API_KEY`** — `start.sh` exits before Compose; chat will fail at runtime.
2. **CORS errors in the browser** — add your site origin to `CORS_ORIGINS` (and rebuild/restart).
3. **`/api/ready` 503 `bootstrap_tenant_missing`** — run `npm run db:seed` or re-run the `migrate` service (`docker compose run --rm migrate` …).
4. **`/api/ready` 503 `redis_*`** — Redis not reachable from API; check `REDIS_URL` and the `redis` service.
5. **Worker exits** — In production, missing `REDIS_URL` causes the worker to exit; check `docker compose logs worker`.

**Still manual:** **platform SSO** for admin access (no public signup), **TLS**, **DNS**, **billing**, and customer-site **CORS** + embed wiring (`?tenant=slug` or subdomain).

More detail: **`INSTALL_RUN.md`**, **`DEPLOY_CHECKLIST.md`**, **`ONE_CLICK_IMPLEMENTATION_REPORT.md`**, **`ADMIN_ONBOARDING_REPORT.md`**, **`MANAGED_PROD_READINESS_REPORT.md`**.

Product / commercial docs: **`PRODUCT_DEFINITION.md`**, **`PRODUCT_TIERS.md`**, **`PRICING_MODEL.md`**, **`PACKAGING_STRATEGY.md`**, **`OPERATOR_PLAYBOOK.md`**.

## License

See `LICENSE`.
