# Deploy checklist (operators)

Use this for a new machine or new environment.

## Before first start

- [ ] Docker Engine + Compose v2 installed
- [ ] `cp .env.example .env` completed
- [ ] **`OPENAI_API_KEY`** set in `.env` (required unless `OPENAI_BOOT_OPTIONAL=1`)
- [ ] **`KMS_MASTER_KEY`** set or **`SKIP_KMS_MASTER_KEY=1`** documented and accepted
- [ ] For public browser traffic: **`CORS_ORIGINS`** lists every HTTPS origin that calls the API (Compose adds localhost defaults only)
- [ ] **`POSTGRES_PASSWORD`** matches between `.env` (if used) and Compose, if you changed the default

## Start

- [ ] Run `./scripts/start.sh` from repo root
- [ ] Script ends with “Stack is up” and no errors

## Verify

- [ ] `curl -sf http://127.0.0.1:8080/api/health` returns JSON with `"status":"ok"`
- [ ] `curl -sf http://127.0.0.1:8080/api/ready` returns JSON with `"status":"ready"` and checks `database` / `redis` / `defaultTenant` all `"ok"`
- [ ] Inspect **`hints`** in the ready JSON (may be non-empty when tenants lack per-tenant OpenAI keys and no global key is configured)
- [ ] `curl -sf http://127.0.0.1:9090/health` returns worker JSON (adjust port if `WORKER_HOST_PORT` changed)
- [ ] Optional: `./scripts/troubleshoot.sh` for a single paste-friendly diagnostic bundle
- [ ] Optional: full OpenAI smoke — `SMOKE_LITE=0` in-container smoke (see `INSTALL_RUN.md`)

## New tenant (per customer)

- [ ] **Preferred:** open **`/admin`** → **Tenant onboarding** → create tenant (platform SSO, operator/admin/owner role)
- [ ] Save printed **`qmb_*`** integration key if shown (inbound integrations)
- [ ] Use **Verify readiness** in the dashboard (or CLI `tenant:verify`)
- [ ] **Or CLI:** `docker compose exec -T api node scripts/tenant-cli.js create --slug <slug> --name "<display name>"` (+ optional bootstrap/verify commands)
- [ ] Add **`CORS_ORIGINS`** entries for that customer’s sites if browsers call the API with credentials
- [ ] Wire embed: `?tenant=<slug>` or DNS subdomain per `resolveTenantSlug` in `server.js`

## After deploy

- [ ] TLS termination configured on a reverse proxy (production) — not provided by this repo
- [ ] Secrets stored in a proper secret manager for non-demo environments
- [ ] Backups for Postgres volume / instance scheduled (see `scripts/backup-postgres.example.sh` for `pg_dump` patterns)
- [ ] **`MANAGED_PROD_READINESS_REPORT.md`** reviewed for operator expectations and remaining risks

## Rollback / rebuild

- [ ] `docker compose down` then `./scripts/start.sh` for code updates (migrations run on migrate container)
- [ ] If schema is broken: read `docker compose logs migrate` before wiping volumes
