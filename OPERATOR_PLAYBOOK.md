# Operator playbook

Repeatable lifecycle for **you** (the vendor operator) serving **customers**. **Default assumption: one paying customer ↔ one dedicated Solomon environment.** Inside that environment you may run **multiple internal tenants** (brands, sites, staging) as the contract allows.

**Roles:**

- **Operator** — you: deploy and operate **each customer’s instance**.
- **Customer** — their org: keys they own, DNS/CORS, webhook endpoints on **their** systems.

Commands reference this repository; adapt URLs and ports per **customer instance**.

---

## Phase 0 — Sales handoff (before deploy)

1. **Confirm tier** (`PRODUCT_TIERS.md`): **dedicated instance** only unless an explicit exception; **internal** tenant count; integration depth; SLA.
2. **Collect:**
   - Customer identity and **environment name** (for your CMDB).
   - Primary **API hostname** / embed context.
   - **OpenAI** policy (global env key vs per–internal-tenant keys).
   - **Inbound integrations**? → integration API keys per internal tenant as needed.
   - **Webhook** URLs (HTTPS in production).
   - **CORS** origins for **this** customer’s sites.
3. **Set expectations:** No public signup; you provision **internal tenants** in **their** instance; integration keys shown once.

---

## Phase 1 — Deploy **this customer’s** environment (primary path)

Each **new customer** gets a **new** deploy (new compose project, new namespace, or new VM — your standard).

1. **Provision infrastructure** for **this customer only** (isolated Postgres volume, Redis, networks as designed).
2. **Clone / artifact** and configure **`.env`** for **this** instance (`DEPLOY_CHECKLIST.md`, `.env.example`).
3. **Production variables** for **this** stack: `DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY` (or `OPENAI_BOOT_OPTIONAL=1` + per-tenant keys), `KMS_MASTER_KEY` (or documented skip), `CORS_ORIGINS`, `NODE_ENV=production`.
4. Run **`./scripts/start.sh`** (or CI) for **this** environment.
5. Verify: **`healthcheck.sh`**, `/api/health`, `/api/ready`; read **`hints`**.
6. **TLS / reverse proxy** for **this** customer’s hostname(s).
7. **Record:** customer id ↔ **instance id**, API URL, git ref, secret manager paths.

*Deliverable:* “**Your** Solomon base URL is `https://…`”; embed uses `?tenant=<internal_slug>` (or header/subdomain) per your guide.

---

## Phase 2 — Onboard **internal** tenant(s) (within that customer)

Repeat for each brand/site **inside the same customer instance** (or once if single-tenant org).

1. **Slug** = stable id for **that** brand/site in **their** database.
2. **Create:** `/admin` (SSO) **or** `tenant-cli` **against this instance’s** API/DB.
3. OpenAI: global key for instance vs per–internal-tenant key.
4. **Save** integration key (`qmb_*`) if created.
5. **Bootstrap prompts** if needed (`prompts/tenants/<slug>/`).
6. **Hand off** internal slug + embed params + webhook docs to **customer** stakeholders for **that** brand.

---

## Phase 3 — Verify readiness

1. **Per internal tenant:** `/admin` **Verify readiness** or `tenant-cli verify --slug …` on **this** instance (exit **2** if chat blocked).
2. **Instance:** `GET /api/ready` on **this** customer’s URL; interpret **503** reasons.
3. **`./scripts/troubleshoot.sh`** with `SMOKE_BASE_URL` pointing at **this** instance when debugging.

---

## Phase 4 — Common issues (first-line)

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| 503 `bootstrap_tenant_missing` | Seed / `DEFAULT_TENANT` on **this** instance | Migrate + seed **`INSTALL_RUN.md`**. |
| 503 `redis_*` | **This** env’s Redis / `REDIS_URL` | Compose / network for **this** customer only. |
| Browser errors | CORS / tenant resolution | **This** instance’s `CORS_ORIGINS`; `?tenant=` / header. |
| Inbound 401 | Key wrong for **that internal tenant** | Rotate; update **their** systems. |
| Webhooks stuck | **This** worker / Redis | Logs for **this** deployment. |

---

## Phase 5 — Rotate keys / config (per instance / per internal tenant)

- **Integration key:** rotate for the relevant **internal tenant**; old key dies immediately — customer updates callers.
- **Instance secrets:** OpenAI/KMS env changes → restart **this** stack’s API/worker.
- **Never** mix secret rotation between **two customers’** instances.

---

## Phase 6 — Upgrades and maintenance

Performed **per customer instance** (or batched with care and clear customer communication).

1. Window per **tier** / contract.
2. Upgrade **this** deploy; run migrations.
3. Healthcheck **this** URL; spot-verify one **internal** tenant.
4. Backup **this** Postgres before major change (`scripts/backup-postgres.example.sh` patterns).

---

## Artifacts to keep **per customer** (per dedicated instance)

- Tier, **instance** identifiers, API base URL.
- List of **internal tenants** (slugs) and owners.
- Webhook endpoints and filters **they** use.
- Last verify date (per important internal tenant).
- Customer escalation contact.

**Do not** use one runbook row to track unrelated customers on the same instance unless you have explicitly sold and engineered that exception.

Aligned with **`INSTALL_RUN.md`**, **`DEPLOY_CHECKLIST.md`**, **`MANAGED_PROD_READINESS_REPORT.md`**.
