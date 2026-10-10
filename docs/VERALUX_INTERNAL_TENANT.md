# VeraLux internal tenant — Solomon (Question Mark Bot)

This document describes the **product-side** tenant for VeraLux’s own Solomon deployment (`deploymentId: solomon-veratitan-prod` in VeraLux OS). It does **not** change OS telemetry or deployment IDs.

## Tenant slug

- **`veralux`** — public chat: `?tenant=veralux` or host first label `veralux` (not reserved; `admin` is reserved in `server.js` `resolveTenantSlug`).

## Display & URLs (reference)

| Field | Value |
|--------|--------|
| Display name | VeraLux AI |
| Website | https://veralux.ai |
| Contact email (business profile) | veralux.team@gmail.com |
| Public URL (deployment / marketing) | https://solomon.veralux.ai |

## Idempotent setup

From the **Question-Mark-Bot** repo root (with `.env` / `DATABASE_URL` pointing at the same DB your API uses):

```bash
npm run seed:veralux-internal
```

This script (`scripts/seed-veralux-internal-tenant.js`):

- Upserts Prisma `Tenant` id **`veralux`**, name **VeraLux AI**, subdomain **`veralux`**.
- Merges **`settings.businessProfile`**, **`settings.behavior`**, **`settings.appearance`** (does not wipe unrelated `settings` keys).
- Sets **branding columns** (charcoal + gold palette).

Filesystem prompts (optional layer) live under:

- `prompts/tenants/veralux/systemprompt.md`
- `prompts/tenants/veralux/policy.md`
- `prompts/tenants/veralux/voice.md`

You can re-run `npm run tenant:bootstrap-prompts -- --slug veralux` if you want DB copies of file prompts (optional).

## Chat readiness vs VeraLux OS “not_ready”

**OS “not_ready” on the Solomon card** comes from the **Solomon** reporter calling **`GET http://127.0.0.1:$PORT/api/ready`** and requiring `status === "ready"` (`services/veraluxOsReporter.js`). That reflects **API process readiness** (Postgres, Redis in production, default tenant row, `STRICT_TENANT_BINDING` when `PLATFORM_URL` is set, etc.) — **not** whether the `veralux` tenant exists.

**Tenant “ready for chat”** in admin (`verifyTenantForAdmin` in `services/tenantProvisioning.js`) requires a **usable OpenAI path**: per-tenant `openaiKey`, or global **`OPENAI_API_KEY`**, or **`OPENAI_BOOT_OPTIONAL=1`**.

The seed script **does not** set `openaiKey` (KMS/secret handling is operator-specific).

## Human follow-ups

1. Ensure **`OPENAI_API_KEY`** (or per-tenant key + KMS) is configured for production.
2. **`CORS_ORIGINS`** must include `https://solomon.veralux.ai` (and admin origins if applicable).
3. Map **Cloudflare / DNS** to the Solomon service; use **`?tenant=veralux`** on the public site if the hostname does not use the `veralux` label.
4. Optional: integration API key for inbound integrations (`tenant-cli` rotate / admin).

## Verification

```bash
npm run tenant:list
npm run tenant:verify -- --slug veralux
curl -sS "http://127.0.0.1:8080/api/public/embed-config?tenant=veralux" | head
```

## Risk notes

- Re-running the seed **re-applies** the same `SETTINGS_PATCH` values for `businessProfile`, `behavior`, and `appearance` (nested keys in those objects follow `mergeDeep`). Other top-level `settings` keys you added manually are preserved.
- Do **not** commit `.env` or API keys.
