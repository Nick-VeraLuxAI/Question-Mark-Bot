# Integration architecture (flexible by design)

This service implements a **canonical domain** plus **pluggable adapters**, **versioned outbound webhooks**, **inbound normalization**, **tenant config**, and **async delivery** (queue with sync fallback).

## 1. Canonical domain API

Stable concepts live in code as event names and envelope shape:

| Constant / field | Meaning |
|------------------|---------|
| `lead.created` | Lead captured (chat or forms) |
| `campaign.launched` | Re-engagement campaign scheduled |
| `context.patch` | Generic inbound context (adapter) |
| `profile.updated` | CRM-style profile (e.g. HubSpot) |

Envelope (outbound):

```json
{
  "schemaVersion": "1.0",
  "event": "lead.created",
  "occurredAt": "2025-03-20T12:00:00.000Z",
  "tenantId": "…",
  "data": { "lead": { "name", "email", "phone", "tags", "score", "status", "snippet" } }
}
```

`lead.created` also duplicates legacy flat fields at the root (`name`, `email`, `phone`, …) for existing consumers.

Verify HMAC with header `x-qmb-signature`: hex SHA-256 HMAC of the **raw JSON body string** (same bytes the server signed). Helpers: `x-qmb-schema-version`, `x-qmb-event`.

## 2. Adapters (per system)

- Registry: `integrations/adapters/index.js`
- Built-in: `generic` (pass-through / `{ type, data }`), `hubspot` (contact properties → `profile.updated`)

Add a provider: new file under `integrations/adapters/`, export `normalize(body, settings)`, register in `index.js`.

**Tenant allowlist** (optional): `tenant.settings.integrations.enabledProviders` = `["generic","hubspot"]`

**HubSpot field map** (optional): `tenant.settings.integrations.hubspot.fieldMap` maps canonical keys → HubSpot property names.

## 3. Outbound webhooks / events

- Each `LeadWebhook` row has optional **`events`** (`text[]` in Postgres): canonical event names to receive.
  - **Omit, `null`, or `[]`** → receive **all** event types (default; backward compatible).
  - **`["*"]`** → explicit “all events” (same behavior, self-documenting).
  - **`["lead.created","campaign.launched"]`** → only those events.
- Delivery: BullMQ job `integration-webhook` when Redis is available; otherwise direct HTTP.
- Implementation: `services/outboundEvents.js` + `integrations/domain.js` (`webhookSubscribesToEvent`) + `utils/webhook.js`

Discovery: `GET /api/integrations/v1/adapters` returns `eventTypes` (all canonical strings you can filter on).

## 4. Inbound integration endpoints

- `POST /api/integrations/v1/inbound/:provider` — body = vendor payload; normalized and stored as `Event` with type `integration.inbound.<canonicalType>`.
- Auth: **tenant API key** — `Authorization: Bearer <key>` or `X-Api-Key`, plus tenant resolution via `X-Tenant` / query / subdomain (same as `/message`).
- Key issuance: platform-authenticated `POST /api/keys/rotate`.

Discovery:

- `GET /api/integrations/v1/adapters` — same API key auth; lists `eventTypes`, adapters, and which adapters are enabled for the tenant.

## 5. Config + registry

- **DB**: `Tenant.settings` JSON for `integrations.*`
- **Code**: adapter registry in `integrations/adapters/`
- **DB**: `LeadWebhook` for outbound URLs, secrets, and optional **`events`** filter array

## 6. Async jobs

- Queue: `events` / job `integration-webhook` (payload: `endpoint`, `secret`, `body`).
- Legacy job name `lead-webhook` is still processed by the worker for old queued items.

## 7. Operator dashboard (in-repo)

- **URL:** `/admin` — HTML shell from `templates/admin.html` (CSP nonce + external `public/admin/admin.css` & `admin.js`).
- **Auth:** Platform SSO cookie from `/sso/callback`, or **Bearer** under *Developer* (local only; discouraged for production — see `docs/soc2-readiness.md`).
- **CSRF:** Browser sessions that use the `platform_token` cookie must send **`X-CSRF-Token`** on mutating `/api/*` calls. The dashboard fetches a token from **`GET /api/security/csrf-token`** before POST/PATCH/DELETE. Requests that use **`Authorization: Bearer`** only (no cookie) skip CSRF at the edge.
- **RBAC:** Viewing config/stats/webhooks requires **`config:read`**. Rotating the integration API key, creating/updating/deleting webhooks, and **`POST /api/integrations/webhook-test`** require **`config:write`** (operators, owners, admins — not viewers/analysts).
- **Tenant:** Query `?tenant=slug`, or use the tenant field in the header (persisted locally).
- **Features:** Overview stats (`/api/stats`), tenant config summary (`/api/config`), rotate API key, outbound webhook CRUD + event checkboxes (`/api/integrations/webhooks/meta`).

---

**Summary:** New systems integrate by (a) subscribing to versioned webhooks, (b) posting to `/api/integrations/v1/inbound/:provider` with an API key, and/or (c) adding an adapter + tenant settings — without changing core chat logic. Operators configure webhooks and keys from **`/admin`** without a separate portal repo.
