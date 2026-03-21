# SOC 2 readiness (Solomon / Question-Mark-Bot)

SOC 2 is an **attestation** against the AICPA Trust Services Criteria (TSC), not a library you install. **Type I** describes design at a point in time; **Type II** covers operating effectiveness over a period (typically 3–12 months). Your auditor will expect **evidence** across people, process, and technology.

This document maps what this **repository** implements (technical controls) vs what **your organization** must still provide.

---

## 1. Security (CC) — technical items in-repo

| TSC area | Control intent | Implemented here |
|----------|----------------|------------------|
| **CC6.1** Logical access | Least privilege for admin APIs | `middleware/rbac.js` — **`config:write`** required to rotate API keys, mutate webhooks, and outbound webhook test; viewers/analysts cannot change integration config. |
| **CC6.6** Session / credential protection | HttpOnly cookies, CSRF for cookie sessions | `platform_token` httpOnly + `SameSite` (see `server.js` / SSO callback). **CSRF** for mutating `/api/*` when `platform_token` is present and no `Authorization: Bearer` header (`middleware/csrfApi.js`). |
| **CC6.7** Transmission | TLS in production | Deploy behind HTTPS (Railway, Render, etc.); **HSTS** via `helmet` when `NODE_ENV=production`. |
| **CC7.2** Monitoring / audit trail | Tamper-evident admin actions | `utils/audit.js` + Prisma `AuditLog` on config reads, webhook CRUD, key rotation, SSO callback, etc. |
| **CC8.1** Change management | Code review / deploy | Your Git + CI/CD process (not enforced in app code). |

### Operational flags

| Variable | Purpose |
|----------|---------|
| `DISABLE_CSRF=1` | **Emergency only** — disables CSRF checks (breaks SOC 2 posture; remove in production). |
| `CORS_ORIGINS` | Production **must** be an explicit allowlist (already enforced in `server.js`). |
| `PLATFORM_COOKIE_SAMESITE` | Defaults to `Strict`; keep strict unless a documented integration requires `Lax`. |

### Content-Security-Policy (implemented)

- **Chat shell** (`GET /`): Template `templates/chat.html` + external `solomon.css` / `solomon.js`. Header uses **`EMBED_PAGE_CSP`** (`script-src 'self'`, `style-src 'self' https://fonts.googleapis.com`, `frame-ancestors *` for iframe embeds).
- **Admin** (`GET /admin`): Template `templates/admin.html` + external `admin.css` / `admin.js`. Header uses a **per-request `script-src 'nonce-…'`** matching the `nonce` on the script tag (`utils/csp.js` + `buildAdminPageCsp`).
- **Direct URL gap**: Do not expose duplicate HTML under `public/`; shells live only under `templates/` so `/index.html` is not served as a bypass.

### Known gaps (plan remediation)

- **Tighter embed policy**: If you can pin parent origins, replace `frame-ancestors *` with an allowlist.
- **Bearer token in `localStorage`** (`/admin` dev helper): **XSS-sensitive**. Discouraged in production; prefer SSO cookie only.
- **Penetration test / dependency scanning**: Run `npm audit`, SCA, and periodic pentests outside this repo.
- **Backups, DR, IR playbooks**: Organizational; document RTO/RPO and test restores.

---

## 2. Availability, Confidentiality, Processing integrity, Privacy

These criteria depend heavily on **hosting**, **contracts**, and **data handling**:

- **Availability**: Uptime SLAs, multi-AZ, health checks (`/api/health`, `/api/ready`), incident response.
- **Confidentiality**: Encryption at rest (DB provider), key management (`utils/kms.js` patterns), access to `.env` / secrets stores.
- **Processing integrity**: Validation on inputs, idempotency for webhooks where needed (evaluate per integration).
- **Privacy** (if applicable): Data inventory, subprocessors, DPA, retention (`RetentionPolicy` model directionally supports this).

---

## 3. Evidence pack (what auditors ask for)

Prepare **outside** the codebase:

1. **System description** — architecture diagram, data flows, subprocessor list (OpenAI, host, DB, email).
2. **Access control policy** — who gets `owner` / `admin` / `operator` / `viewer` on the platform; quarterly access reviews.
3. **Onboarding / offboarding** — HR + IT checklist for keys and accounts.
4. **Change management** — PR reviews, deployment approval, release notes.
5. **Incident response** — roles, notification, customer communication template.
6. **Vendor SOC 2** — OpenAI, cloud host, DB, email; keep reports or questionnaires on file.

---

## 4. Summary

This app can **support** a SOC 2 program with **RBAC for sensitive config**, **audit logging**, **CSRF for cookie-based operator sessions**, **security headers**, and **HSTS** — but **SOC 2 compliance is an organizational attestation**, not a property of this repo alone. Use this file as a starting checklist with your compliance advisor and auditor.
