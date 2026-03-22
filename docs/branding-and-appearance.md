# Branding, embed theme, and lead email delivery

## Branding (tenant)

Visual tokens live on the `Tenant` model (`brandColor`, `botBg`, `userBg`, `glassBg`, `fontFamily`, `watermarkUrl`, `headerGlow`, etc.) and optional JSON `branding` (e.g. watermark size/opacity).

- **`GET /env.css?tenant=<slug>`** — injects CSS variables for the chat embed. Cached with `no-store` so changes show up on refresh.
- **Dashboard** — `/admin` → *Branding & embed theme* loads `GET /api/integrations/branding` and saves with `PATCH /api/integrations/branding` (requires `config:read` / `config:write`).

## Embed theme (light / dark / auto)

- **Tenant default** — `settings.appearance.theme`: `auto` | `light` | `dark` (stored in `Tenant.settings` JSON).
- **Public API** — `GET /api/public/embed-config?tenant=` returns `{ tenantId, theme }` for the chat script (rate-limited). Used by `public/solomon.js` before applying `data-theme` on `<html>`.
- **Visitor override** — the widget header includes a theme control. It stores `solomon_theme_user` in `localStorage` (`light` or `dark`) or clears it to follow the tenant default again.
- **CSS** — `public/solomon.css` uses `@media (prefers-color-scheme: dark)` on `html:not([data-theme])` plus `html[data-theme="dark"]` / `html[data-theme="light"]` overrides.

## Lead notification email

When a lead is captured on `POST /message`, the app **enqueues** a BullMQ job `lead-notification-email` on the `events` queue (with retries and exponential backoff). The worker (`npm run worker` / `workers/queueWorker.js`) sends mail via the same Nodemailer transport rules as before.

- **Redis / BullMQ** — queues use a **dedicated Redis client** with `maxRetriesPerRequest: null` (required by BullMQ). Rate limiting still uses the general-purpose Redis client.
- **Idempotency** — after a successful send, `Lead.notificationEmailSentAt` is set. Enqueue, sync fallback, and the worker all **skip** if it is already set, so retries and duplicate requests do not double-email.
- **Redis unavailable** — the server **falls back to a synchronous send** in-process (single attempt); failures are logged to the admin log stream.
- **SMTP not configured** — no job is enqueued; a server log explains that SMTP is missing.
- **Duplicate jobs** — `jobId` `lead-email:<leadId>` deduplicates while a job is still in the queue.
- **Final failure** — the worker emits `failed` only once per permanently failed job; when `job.finishedOn` is set, it records **system audit** (`lead.email.failed`) and `logError` (no spam on intermediate retries).
- **Worker process** — configurable concurrency and lock duration for slow SMTP; optional **`WORKER_HEALTH_PORT`** serves `GET /health` and `GET /ready`. **SIGTERM/SIGINT** close the worker, Prisma, and Redis cleanly. In **production**, if `REDIS_URL` is missing the worker **exits with code 1**.
- **API process** — in production, boot **fails fast** if `DATABASE_URL` is empty; **SIGTERM/SIGINT** close the HTTP server, BullMQ queues, Redis, and Prisma.

Apply schema: `npx prisma migrate deploy` (adds `Lead.notificationEmailSentAt`).

Environment knobs:

- `LEAD_EMAIL_JOB_ATTEMPTS` (default `6`)
- `LEAD_EMAIL_BACKOFF_MS` (default `3000`)
- `EVENTS_WORKER_CONCURRENCY` (default `5`)
- `EVENTS_WORKER_LOCK_MS` (default `120000`, SMTP-friendly lock)
- `WORKER_HEALTH_PORT` (optional, e.g. `9090`)
