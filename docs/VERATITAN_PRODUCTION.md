# VeraTitan local production (Solomon / Question-Mark-Bot)

This document matches the **Question-Mark-Bot** repo layout: single Express app (`server.js`), Prisma + **PostgreSQL** only (`prisma/schema.prisma`), Redis + BullMQ worker (`workers/queueWorker.js`), static assets under `public/` (no build step).

Canonical copies of **systemd** and **Cloudflare Tunnel** examples live under `deploy/systemd/` and `deploy/cloudflare/`.

**Shared / non-fresh host:** if this machine already runs other apps (Docker, tunnels, Redis on `6379`, etc.), use **`docs/SOLOMON_ADDITIVE_VERATITAN.md`**, **`deploy/systemd/solomon.env.additive.example`**, and **`./scripts/solomon-additive-preflight.sh`** instead of assuming free ports `8080`/`8081`/`9090`.

## Executive summary

| Topic | Recommendation |
|--------|----------------|
| Database | **PostgreSQL** (SQLite is not supported by Prisma schema) |
| App + worker | **Two systemd units** OR keep **Docker Compose** from this repo (data volume → `/var/lib/solomon/...`) |
| Public HTTPS | **Cloudflare Tunnel** → `http://127.0.0.1:8080` |
| Liveness | **`GET /healthz`** (no DB) — see `server.js` |
| Readiness | **`GET /api/ready`** (DB + Redis + bootstrap checks in production) — see `server.js` |
| Admin API | **Platform JWT** via `middleware/platformSSO.js` — `/admin` HTML is still publicly fetchable; use **Cloudflare Access** on `admin.*` if you need shell-level gate |

## Repo-local commands (this machine)

```bash
cd /home/ndesantis/Documents/GitHub/Question-Mark-Bot   # or /opt/solomon after copy
cp .env.example .env   # if creating fresh; production should use /etc/solomon/solomon.env
npm ci
npx prisma generate
npx prisma migrate deploy   # or docker compose flow: see README.md
npm run db:seed             # if empty DB (creates DEFAULT_TENANT)
NODE_ENV=production node server.js
```

Worker (second terminal or second unit):

```bash
NODE_ENV=production node workers/queueWorker.js
```

Docker path (often simpler on one box): `./scripts/start.sh` — see `docker-compose.yml` (Postgres data in Docker volume `solomon_pgdata`; bind-mount that volume to `/var/lib/solomon/pgdata` if you customize compose).

## systemd install (summary)

1. `sudo useradd --system --home /opt/solomon --shell /usr/sbin/nologin solomon || true`
2. `sudo mkdir -p /opt/solomon /var/lib/solomon /var/log/solomon /var/backups/solomon`
3. `sudo rsync -a --delete --exclude node_modules --exclude .git … /opt/solomon/` (from repo root)
4. `sudo -u solomon npm ci` in `/opt/solomon`
5. `sudo cp deploy/systemd/solomon.env.example /etc/solomon/solomon.env` and edit (`chmod 600`)
6. `sudo cp deploy/systemd/solomon.service deploy/systemd/solomon-worker.service /etc/systemd/system/`
7. `sudo systemctl daemon-reload && sudo systemctl enable --now solomon solomon-worker`

Full templates: `deploy/systemd/solomon.service`, `deploy/systemd/solomon-worker.service`, `deploy/systemd/solomon.env.example`.

## Backups

Script: `scripts/backup-solomon.sh` (requires `pg_dump` on PATH, `DATABASE_URL` in env file).

Example timer: run daily as `solomon` user via `systemd timer` or cron calling that script with `/etc/solomon/solomon.env`.

## Cloudflare

Example ingress: `deploy/cloudflare/config.yml.example`.

## Tenant resolution

Order in `server.js` → `resolveTenantSlug`: platform SSO override → `X-Tenant` → `?tenant=` → **hostname first label** (excluding `www`, `localhost`, `127.0.0.1`, `::1`, **`admin`**) → `DEFAULT_TENANT`.

So **`admin.veralux.ai`** does **not** select tenant `admin`; it falls through to **default**. Use **`bot.veralux.ai`** only if you have a tenant whose subdomain/id is `bot`, or use **`?tenant=`** / **`X-Tenant`** / a dedicated hostname whose first label matches the tenant slug.

## Health endpoints

| Route | Auth | Use |
|-------|------|-----|
| `GET /healthz` | None | Liveness (tunnel / LB) |
| `GET /api/health` | None | Simple JSON `status: ok` |
| `GET /api/ready` | None | Deep readiness; may 503 in production |

`scripts/healthcheck.sh` checks `/healthz`, `/api/health`, `/api/ready`, and worker `http://127.0.0.1:9090/health`.
