# SOC 2 Type II — operating program (Solomon)

**Type II** means an auditor evaluates whether controls **operated effectively over a period** (typically **3–12 months**). No repository change can “grant” Type II; your **organization** must run the program and retain **evidence**.

This document is a **practical operating template** aligned with this codebase. Pair it with [`soc2-readiness.md`](./soc2-readiness.md) (technical mapping) and your compliance advisor.

---

## 1. Scope you tell the auditor

- **Product**: Solomon / Question-Mark-Bot (API, embed, admin dashboard, worker).
- **Trust Services Criteria**: usually **Security** first; add **Availability**, **Confidentiality**, **Processing integrity**, **Privacy** only if in scope.
- **Systems**: app host, Postgres, Redis, secrets store, CI (GitHub Actions), identity provider / platform portal, OpenAI, email (SMTP), customer embed origins.

---

## 2. Evidence calendar (recurring)

| Cadence | Activity | Evidence to retain |
|--------|----------|--------------------|
| **Each change** | PR review + merge | PR links, reviewers, CI green (`.github/workflows/ci.yml`) |
| **Each deploy** | Tagged release or deploy log | Who approved, what version, rollback note |
| **Weekly** | Review `npm audit` / SCA | Export or screenshot; ticket for highs |
| **Monthly** | Access review (platform roles) | Spreadsheet: users × role × tenant; removals signed |
| **Quarterly** | Vendor attestations | OpenAI, cloud, DB, Redis, email — SOC 2 / SIG |
| **Quarterly** | DR / backup test | Restore test log, RTO/RPO vs actual |
| **Annually** | Policy refresh + training attestation | Policies v-dated; LMS completion export |
| **As needed** | Incident response | Timeline, impact, customer notice, root cause |

---

## 3. Control themes ↔ what you show

### Security (CC)

- **Logical access**: Platform roles (`owner` / `admin` / `operator` / …) documented; quarterly review.
- **Authentication**: SSO for operators; integration API keys rotated via audited `POST /api/keys/rotate`.
- **Session**: HttpOnly cookies; CSRF on cookie-backed mutations (`middleware/csrfApi.js`).
- **Audit trail**: `AuditLog` rows for sensitive actions (see server routes calling `writeAudit`). Requests include **`requestId`** in `details` when using `requestCorrelation` middleware.
- **Network**: TLS termination; `CORS_ORIGINS` allowlist in production; optional **`CSP_EMBED_FRAME_ANCESTORS`** instead of `*` for embed CSP.
- **Admin XSS posture**: In **production**, the **Developer / Bearer** panel is **hidden** unless `ALLOW_ADMIN_BEARER_DEV_TOOLS=1`.

### Availability (A) — if in scope

- Uptime monitors on `/api/health`, `/api/ready`, worker **`WORKER_HEALTH_PORT`** if enabled.
- Incident tickets + postmortems.

### Confidentiality (C) — if in scope

- Encryption at rest from cloud/DB vendor; KMS patterns in `utils/kms.js`.
- Subprocessor list + DPAs.

### Privacy (P) — if in scope

- Data inventory, retention (`RetentionPolicy` direction), consent flows; legal basis documented.

---

## 4. Technical artifacts to attach to the audit packet

1. **Architecture diagram** — browser → API → DB/Redis/OpenAI/SMTP/worker.
2. **`.github/workflows/ci.yml`** — proves automated test + critical CVE gate on each PR.
3. **Environment inventory** — prod/staging vars (`DATABASE_URL`, `REDIS_URL`, `CORS_ORIGINS`, `CSP_EMBED_FRAME_ANCESTORS`, etc.) without secret values.
4. **Sample `AuditLog` export** — `GET /api/compliance/export` (role `audit:read`) redacted for the auditor.
5. **Penetration test / DAST** — external report (annual or on major release).

---

## 5. Honest “A” bar

An **A** Type II outcome means: **no material exceptions** in the auditor’s period, **evidence is complete and consistent**, and **issues found are remediated with tracked closure**. The application code **supports** that; the **grade is earned in operations**, not in Git alone.

---

## 6. Environment reference (SOC 2–relevant)

| Variable | Intent |
|----------|--------|
| `CSP_EMBED_FRAME_ANCESTORS` | Tighten embed `frame-ancestors` (default `*` if unset). |
| `ALLOW_ADMIN_BEARER_DEV_TOOLS` | Set `1` only if you accept XSS risk to show Bearer tools in prod admin. |
| `DISABLE_CSRF` | **Never** in production SOC 2 posture. |
| `STRICT_TENANT_BINDING` | Enforce platform tenant vs requested tenant. |
