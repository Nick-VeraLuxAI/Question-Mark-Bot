# Solomon additive VeraTitan deployment

Use this when the workstation **already runs other apps** (Docker, tunnels, Redis, Postgres). This path **does not** replace global configs or existing tunnel files; it adds **`/opt/solomon`**, **`/etc/solomon/solomon.env`**, and **`solomon` / `solomon-worker`** systemd units.

**Preflight (read-only):** from repo root, run `./scripts/solomon-additive-preflight.sh`.

---

## Existing host findings (this machine, inspected)

| Observation | Detail |
|---------------|--------|
| **Repo / cwd** | `/home/ndesantis/Documents/GitHub/Question-Mark-Bot` |
| **Hostname** | `De-Santis-Workstation` |
| **Docker: QMB stack** | `question-mark-bot-api-1` publishes **host `8081` → container 8080**; `question-mark-bot-api_internal-1` → **8082**; `question-mark-bot-worker-1` → **9090** |
| **Postgres on host** | **`qmb-postgres`** maps **host `5433` → 5432** (superuser/credentials are whatever that container was created with — discover before `CREATE USER`) |
| **Redis on host** | **`127.0.0.1:6379`** is in use (**`veralux-voice-runtime-redis-1`** maps host 6379). Other stacks also use Redis internally. |
| **`cloudflared`** | **Installed** (`/usr/local/bin/cloudflared`), **systemd `cloudflared.service` active**, config **`/etc/cloudflared/config.yml`** (do not replace; merge ingress only). |
| **`/opt/solomon`** | Not present at inspection time |
| **`/etc/solomon/solomon.env`** | Not present |
| **`solomon` systemd units** | No `solomon` / `solomon-worker` unit files found |
| **`psql` on PATH** | Not found — use **`docker exec … psql`** into your Postgres container or install `postgresql-client` |

**Re-check before cutover:** ports and container names change over time; always run `./scripts/solomon-additive-preflight.sh` and `docker ps` on the target day.

---

## Collision risks

1. **Port `8081` is occupied** by the existing **Question-Mark-Bot** Docker API mapping — **do not** bind systemd Solomon to `8081` without stopping that container.
2. **`9090`** is occupied by **`question-mark-bot-worker-1`** — systemd **`solomon-worker`** must use a **different** `WORKER_HEALTH_PORT` (e.g. **9091**).
3. **Redis `6379`** is shared — BullMQ queue names in this repo are **not** namespaced with a per-deployment prefix (`utils/jobQueue.js`). A **second** Solomon connecting to the **same** Redis **logical DB** as another Solomon (or compatible BullMQ app) can **corrupt queues**. **Use a dedicated Redis** for the systemd deployment (recommended: **host `6380` → new small Redis container** only for `/opt/solomon`).
4. **Postgres** — prefer a **new database + role** on an existing server (e.g. `qmb-postgres` on **5433**) so you never touch other databases except `CREATE DATABASE` / `GRANT`.

---

## Recommended port and hostnames

| Role | Recommended value | Rationale |
|------|-------------------|-----------|
| **API `PORT`** | **8083** | **8081** taken; **8080** free but easy to confuse with in-container `8080`; **8083** was free at inspection. |
| **Worker `WORKER_HEALTH_PORT`** | **9091** | **9090** taken by existing QMB worker. |
| **Dedicated Redis (new)** | **6380** | Avoids BullMQ / rate-limit key collisions on **6379**. |
| **Postgres** | **`127.0.0.1:5433`** (if `qmb-postgres` remains your chosen server) | Add **new** DB + user only. |

**Public hostnames:** choose new DNS names (e.g. `solomon-api.yourdomain.com`) — do **not** remove existing tunnel routes. Put **Cloudflare Access** on any **admin** hostname. Append ingress rules that point to **`http://127.0.0.1:8083`** (or your chosen port).

---

## Database / Redis plan

### Postgres (reuse server, new DB only)

- **Reuse** the existing Postgres **instance** on **5433** only if you accept its backup/upgrade lifecycle.
- **Create** a dedicated role and database (example names: `solomon_prod` / `solomon_prod`) — see **Commands in order** below.
- **Do not** change `pg_hba.conf` if the new user can authenticate the same way as other local apps (e.g. password in `DATABASE_URL`).

### Redis (dedicated instance strongly recommended)

- Start a **separate** Redis for systemd Solomon only, e.g. Docker:

  ```bash
  docker run -d --name solomon-systemd-redis --restart unless-stopped \
    -p 127.0.0.1:6380:6379 redis:7-alpine redis-server --appendonly yes
  ```

- Set in **`/etc/solomon/solomon.env`**: `REDIS_URL=redis://127.0.0.1:6380`

---

## Env file

Copy **`deploy/systemd/solomon.env.additive.example`** → `/etc/solomon/solomon.env`, **`chmod 600`**, replace secrets and URLs. It sets **`PORT=8083`**, **`WORKER_HEALTH_PORT=9091`**, **`REDIS_URL`** to **6380**, and a **`DATABASE_URL`** template on **5433**.

---

## systemd services

Use **`deploy/systemd/solomon.service`** and **`deploy/systemd/solomon-worker.service`** unchanged in **naming**; ensure **`ExecStart`** uses the same `node` binary as your install (`command -v node`).

Add **`After=`** / **`Requires=`** only if you add a dedicated `solomon-redis.service` — avoid `Conflicts=` with unrelated units.

---

## Cloudflare tunnel additions

**Never** overwrite **`/etc/cloudflared/config.yml`**. Edit manually:

1. Open the existing file and find the **final** catch-all rule (often `service: http_status:404`).
2. **Insert** new `hostname` / `service` blocks **above** that catch-all.
3. Validate: `sudo cloudflared tunnel ingress validate` (or your usual check).
4. Reload tunnel only when ready: `sudo systemctl reload cloudflared` **or** `restart` per your runbook — **avoid** if validation fails.

See **`deploy/cloudflare/ingress-append.SOLOMON.example.yml`** for paste-ready YAML (comments only — not a full config).

---

## Commands in order

### 0) Preflight

```bash
cd /home/ndesantis/Documents/GitHub/Question-Mark-Bot
./scripts/solomon-additive-preflight.sh
```

### 1) Dedicated Redis (optional but recommended)

```bash
docker run -d --name solomon-systemd-redis --restart unless-stopped \
  -p 127.0.0.1:6380:6379 redis:7-alpine redis-server --appendonly yes
```

### 2) OS user and directories

```bash
sudo useradd --system --home /opt/solomon --shell /usr/sbin/nologin solomon 2>/dev/null || true
sudo mkdir -p /opt/solomon /etc/solomon /var/log/solomon /var/backups/solomon
sudo chown -R solomon:solomon /opt/solomon /var/log/solomon /var/backups/solomon
```

### 3) Rsync repo → `/opt/solomon` (exclude secrets and heavy dirs)

```bash
sudo rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .env \
  /home/ndesantis/Documents/GitHub/Question-Mark-Bot/ /opt/solomon/
sudo chown -R solomon:solomon /opt/solomon
```

### 4) Install deps and migrate (as `solomon`)

```bash
sudo cp /opt/solomon/deploy/systemd/solomon.env.additive.example /etc/solomon/solomon.env
sudo chmod 600 /etc/solomon/solomon.env
sudo nano /etc/solomon/solomon.env   # set DATABASE_URL, OPENAI_API_KEY, KMS_MASTER_KEY, CORS_ORIGINS, PLATFORM_URL, secrets, etc.

sudo -u solomon -H bash -lc 'cd /opt/solomon && npm ci && npx prisma generate && npx prisma migrate deploy'
# If DB is empty for this DATABASE_URL:
sudo -u solomon -H bash -lc 'cd /opt/solomon && npm run db:seed'
```

### 5) Create Postgres role + database (example via Docker — adjust user/host)

Replace **`SUPERUSER`** and container name if different:

```bash
docker exec -i qmb-postgres psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE USER solomon_systemd WITH PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
CREATE DATABASE solomon_systemd OWNER solomon_systemd;
GRANT ALL PRIVILEGES ON DATABASE solomon_systemd TO solomon_systemd;
SQL
```

Then set **`DATABASE_URL`** in **`/etc/solomon/solomon.env`**, e.g.:

`postgresql://solomon_systemd:REPLACE_WITH_STRONG_PASSWORD@127.0.0.1:5433/solomon_systemd`

### 6) Install systemd units

```bash
sudo cp /opt/solomon/deploy/systemd/solomon.service /etc/systemd/system/solomon.service
sudo cp /opt/solomon/deploy/systemd/solomon-worker.service /etc/systemd/system/solomon-worker.service
sudo systemctl daemon-reload
sudo systemctl enable solomon solomon-worker
sudo systemctl start solomon solomon-worker
```

### 7) Cloudflare — merge ingress (manual), then reload

See **`deploy/cloudflare/ingress-append.SOLOMON.example.yml`**.

---

## Smoke test plan

**Local (systemd Solomon on 8083):**

```bash
curl -fsS http://127.0.0.1:8083/healthz
curl -fsS http://127.0.0.1:8083/api/ready
SMOKE_BASE_URL=http://127.0.0.1:8083 WORKER_HEALTH_PORT=9091 ./scripts/healthcheck.sh
```

**Public (after tunnel DNS + ingress):**

```bash
curl -fsS https://YOUR_PUBLIC_CHAT_HOST/healthz
curl -fsS https://YOUR_PUBLIC_CHAT_HOST/api/ready
```

**Admin:** open `https://YOUR_ADMIN_HOST/admin` — APIs require platform SSO; edge **Cloudflare Access** recommended. Confirm Developer/Bearer UI hidden: **`NODE_ENV=production`** and **`ALLOW_ADMIN_BEARER_DEV_TOOLS`** not `1`.

---

## Rollback plan

```bash
sudo systemctl disable --now solomon solomon-worker
# optional: remove units
sudo rm -f /etc/systemd/system/solomon.service /etc/systemd/system/solomon-worker.service
sudo systemctl daemon-reload
```

- **Remove tunnel lines** you added (restore from backup or VCS for `/etc/cloudflared/config.yml`), then **`sudo systemctl reload cloudflared`** only after validation.
- **Redis:** `docker stop solomon-systemd-redis && docker rm solomon-systemd-redis` (only the dedicated Solomon Redis).
- **Postgres:** do **not** drop the DB until you have a backup; optional `DROP DATABASE` only after explicit approval.

---

## Go / no-go

| Condition | Verdict |
|-----------|---------|
| **8081** chosen for systemd Solomon on **this** host | **No-go** (already mapped to Docker QMB API). |
| **6379** shared with another Solomon / BullMQ without code changes | **No-go** — use **6380** (or another dedicated Redis). |
| **8083** + **9091** + **6380** + new Postgres DB + merged tunnel ingress + prod env | **Go** (additive, collision-aware). |
