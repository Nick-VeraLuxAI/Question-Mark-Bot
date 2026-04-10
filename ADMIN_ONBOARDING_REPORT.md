# Admin onboarding report

## What was added

A **dashboard-native tenant onboarding** path so operators with platform SSO (and sufficient role) can **create, verify, bootstrap prompts, and rotate integration keys** without using the CLI.

### Routes (HTTP API)

All require **`Authorization` platform user** (SSO cookie or Bearer) and permission **`tenants:provision`** (see `middleware/rbac.js`: **operator**, **admin**, and **owner**; **viewer** and **analyst** are excluded).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/tenants` | List tenants (id, name, plan, flags) + **`serverHints`** (OpenAI global / boot-optional / `NODE_ENV`) |
| `POST` | `/api/admin/tenants` | Create or update tenant (JSON body); response may include **`hints`** and **`serverHints`** |
| `GET` | `/api/admin/tenants/:slug/verify` | Readiness summary + **`badges`**, **`warnings`**, **`readyForChat`**, **`serverHints`** |
| `POST` | `/api/admin/tenants/:slug/bootstrap-prompts` | Copy `prompts/tenants/default/*` → `prompts/tenants/<slug>/` |
| `POST` | `/api/admin/tenants/:slug/rotate-integration-key` | New `qmb_*` key (SHA-256 hash stored) |

Mutating routes use the same **CSRF** rules as other `/api/*` POSTs when using cookie sessions.

### UI

- **Page:** existing **`/admin`** (`templates/admin.html` + `public/admin/admin.js` + `public/admin/admin.css`).
- **Section:** **“Tenant onboarding”** at the top of the dashboard (after the auth banner): form fields for slug, name, plan, global vs per-tenant OpenAI key, optional skip integration key, optional prompt bootstrap, optional force-update; buttons for **Create**, **Verify readiness**, **Bootstrap prompts only**, **Rotate integration key**; list of tenants from the API.

Asset cache-bust: `admin.css` / `admin.js` **v=5**.

**UI (managed polish):** environment banner under onboarding when `serverHints` warrant it; tenant list shows OpenAI / integration-key flags; verify shows badges and warning lines; rotate integration key uses stronger confirmation copy and surfaces the API **`message`** field.

### Shared logic

- **`services/tenantProvisioning.js`** — Used by **`scripts/tenant-cli.js`** and **`server.js`** so CLI and API stay consistent (slug rules, KMS encryption for `openaiKey`, integration key hashing).

### RBAC

- New permission string **`tenants:provision`** granted explicitly to **operator** (in addition to owner/admin who already pass all checks).

---

## How admins create a tenant now

1. Open **`/admin`** with **platform SSO** (or dev Bearer) so `req.platformUser` is set.
2. Ensure platform role is **operator**, **admin**, or **owner**.
3. Fill **Tenant onboarding**: slug, display name; choose plan; choose global OpenAI vs per-tenant key; optionally skip integration key / enable force / prompt copy.
4. Click **Create tenant**. If an integration key was generated, it appears once in the green dashed box — **save it**.
5. Use **Verify readiness** / **Bootstrap prompts** / **Rotate integration key** on the same slug as needed.

The **tenant selector** at the top is updated to the new slug after a successful create so the rest of the dashboard (stats, branding, webhooks for *that* tenant) loads immediately.

---

## What still requires operator work

- **Platform account and SSO** — Admins must still authenticate via the **platform** (`PLATFORM_URL`); there is no public signup.
- **`OPENAI_API_KEY` on the server** — If “use global OpenAI” is chosen, the **deployment** must still supply the env var; the UI does not set server env.
- **KMS / production secrets** — Storing a per-tenant OpenAI key in production still requires **`KMS_MASTER_KEY`** (same as CLI).
- **CORS** — Customer site origins must still be listed in **`CORS_ORIGINS`** for browser calls with credentials.
- **DNS / TLS / embed** — No automation; operators wire `?tenant=` or subdomain and reverse proxy as before.
- **Prompt files in Docker** — Files written under `prompts/tenants/<slug>/` live in the **container filesystem** unless you mount a volume; same limitation as the CLI.

---

## What still blocks true self-service SaaS

- **No end-customer signup**, **no billing**, **no multi-tenant isolation as a product** (single DB, row-level tenancy).
- **Identity is still the platform** — Solomon does not issue customer accounts for “your clients’ clients.”
- **No guided marketing-site embed wizard** — operators still need technical context for CORS and embedding.

---

## Scores (after this pass)

| Metric | Score |
|--------|--------|
| **One-click deploy** | **8 / 10** (unchanged) |
| **Customer-ready deployment** | **9 / 10** |
| **Admin onboarding (product feel)** | **7.5 / 10** — real UI + APIs; still depends on platform SSO and ops env (OpenAI, CORS). |

---

## Single biggest remaining blocker

**Dependence on the external platform for admin authentication** — without a valid platform user/session, the onboarding panel is unusable; there is still no first-party “Solomon admin login” for standalone installs.
