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

- **Chat shell** (`GET /`): Template `templates/chat.html` + external `solomon.css` / `solomon.js`. Header uses **`buildEmbedPageCsp()`** (`script-src 'self'`, …, **`frame-ancestors`** from env **`CSP_EMBED_FRAME_ANCESTORS`** or `*` by default for iframe embeds).
- **Admin** (`GET /admin`): Template `templates/admin.html` + external `admin.css` / `admin.js`. Header uses a **per-request `script-src 'nonce-…'`** matching the `nonce` on the script tag (`utils/csp.js` + `buildAdminPageCsp`).
- **Direct URL gap**: Do not expose duplicate HTML under `public/`; shells live only under `templates/` so `/index.html` is not served as a bypass.

### Known gaps (plan remediation)

- **Tighter embed policy**: Set **`CSP_EMBED_FRAME_ANCESTORS`** to pin parent origins when known.
- **Bearer token in `localStorage`** (`/admin` dev helper): **XSS-sensitive**; panel is **hidden in production** unless **`ALLOW_ADMIN_BEARER_DEV_TOOLS=1`**.
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

## 3. SOC 2 Type II (operating effectiveness)

**Type II** is not a feature flag. Over **3–12 months** you must **operate** controls (access reviews, change management, incidents, vendor reviews, backups) and keep **evidence**.

Use **[`soc2-type2-operating-program.md`](./soc2-type2-operating-program.md)** as the recurring calendar and audit-packet checklist. CI in **`.github/workflows/ci.yml`** supports **change-management** evidence (tests + critical dependency gate).

### Technical additions in-app (audit / correlation)

- **`X-Request-Id`** — middleware sets/propagates a correlation id; **`AuditLog.details.requestId`** links events to logs.
- **Broader `writeAudit` coverage** — appointments, quotes, consent, compliance export, optimization, campaigns, benchmarks, onboarding steps, integration inbound, webhook test, channel inbound; **SSO callback** audit now persists when the tenant resolves in DB.
- **Embed CSP** — optional **`CSP_EMBED_FRAME_ANCESTORS`** (see `utils/csp.js`) to replace `frame-ancestors *` when you can list parent origins.
- **Admin Bearer panel** — hidden in **production** unless **`ALLOW_ADMIN_BEARER_DEV_TOOLS=1`**.

---

## 4. Evidence pack (what auditors ask for)

Prepare **outside** the codebase:

1. **System description** — architecture diagram, data flows, subprocessor list (OpenAI, host, DB, email).
2. **Access control policy** — who gets `owner` / `admin` / `operator` / `viewer` on the platform; quarterly access reviews.
3. **Onboarding / offboarding** — HR + IT checklist for keys and accounts.
4. **Change management** — PR reviews, deployment approval, release notes.
5. **Incident response** — roles, notification, customer communication template.
6. **Vendor SOC 2** — OpenAI, cloud host, DB, email; keep reports or questionnaires on file.

---

## 5. Summary

This app can **support** a SOC 2 program (including **Type II** preparation) with **RBAC**, **expanded audit logging**, **request correlation**, **CSRF for cookie-based operator sessions**, **security headers**, **HSTS**, **CI gates**, and **configurable embed CSP** — but **SOC 2 compliance is an organizational attestation**, not a property of this repo alone. Use **`soc2-readiness.md`** + **`soc2-type2-operating-program.md`** with your compliance advisor and auditor.
