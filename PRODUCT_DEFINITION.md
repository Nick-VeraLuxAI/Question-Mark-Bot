# Product definition — Solomon

## What this product is (simple terms)

**Solomon** is a **dedicated, managed AI chat and integrations system**: for each paying customer, you **deploy and operate their own isolated environment** (database, cache, API, worker). They get **reliable embeddable chat**, **lead and event flows**, and **webhooks / integration APIs** — without building or running that stack themselves.

Inside that **one customer environment**, the product supports **multiple internal tenants** (brands, sites, or lines of business) when needed — separate prompts, keys, and branding per slug — **without** mixing that customer’s data with unrelated companies. Shared infrastructure across **different** customers is **not** the default commercial model.

---

## The problem it solves

| Pain | How Solomon addresses it |
|------|---------------------------|
| “We need AI chat but not another fragile script” | A **full production stack** per customer: API, worker, Postgres, Redis, migrations, health/readiness, operator runbooks. |
| “We have several brands or sites under one company” | **Internal multi-tenancy**: multiple tenant rows in **their** instance, each with its own configuration and embed identity. |
| “We need leads and events in our CRM / tools” | **Outbound webhooks** (signed payloads, event filters) and **inbound integration API** with tenant-scoped keys (as implemented in-repo). |
| “We can’t babysit databases and upgrades” | **Managed dedicated deployment**: you own the lifecycle of **their** instance using the Docker-first path and documented recovery. |

---

## Core capabilities (buyer language)

1. **Embeddable AI chat** — Assistant on their site or product, grounded in prompts and policies; per–internal-tenant behavior and branding where configured.
2. **Dedicated environment** — Their workloads and data run in **their** deployment boundary (your hosting or theirs, per contract) — not a communal pool of strangers.
3. **Internal brands / sites (optional)** — One environment can hold multiple **tenants** for multi-brand or multi-site organizations without separate product instances per slug.
4. **Lead and conversation intelligence** — Capture and score leads; drive automation consistent with the current product.
5. **Integrations layer** — Webhooks, authenticated inbound APIs, adapter patterns documented in `docs/integration-architecture.md`.
6. **Operator-grade operations** — Deploy scripts, readiness endpoints, tenant provisioning (dashboard + CLI), key rotation, troubleshooting and backup guidance.

---

## Who it’s for

| Fit | Examples |
|-----|----------|
| **Strong** | Mid-market companies wanting **their own** managed chat stack; agencies reselling **one dedicated Solomon per end client**; divisions that need **one environment, several internal tenants**. |
| **Moderate** | A single brand that insists on **isolation** and a named URL — still one dedicated instance. |
| **Exception / secondary** | Customers who **must** run software only inside **their** cloud — **standalone install** (license + services), not the default managed offer (see `PACKAGING_STRATEGY.md`). |
| **Weak** | Hyperscale **shared** B2B SaaS where thousands of unrelated orgs live on one footprint with zero per-customer provisioning (this repo is not positioned for that model). |

---

## Included in the “base product” (as shipped in-repo)

- Software and **repeatable deploy** path for **one Solomon stack per customer instance**.
- Embeddable chat and **admin dashboard** (access model per deal — often platform SSO).
- **Tenant lifecycle** inside that instance: create, verify, bootstrap prompts, rotate integration keys (UI + CLI).
- **PostgreSQL + Redis + worker** for queues, rate limits, and reliable webhook delivery.
- **Operator documentation**: install, checklist, managed readiness, troubleshooting.

---

## Intentionally excluded (unless separately sold)

- **Pooling unrelated customers on one production instance** as the default SKU.
- **Public self-serve signup and in-app billing.**
- **First-party admin SSO** for every buyer without integration work (see `MANAGED_PROD_READINESS_REPORT.md`).
- **TLS, DNS, corporate IdP** — wrapped by you or IT per contract.
- **Automated backups** as a product feature — patterns exist; execution is operational scope.
- **24/7 NOC** — unless contracted.

---

## One-line positioning (elevator)

> **Solomon is your customer’s dedicated, managed AI chat and integrations environment — we deploy and operate it so they get enterprise-grade chat, leads, and webhooks without building or sharing a communal platform.**

For a **non-technical buyer**: *“You get your own managed AI assistant on your site, wired to your tools, on infrastructure dedicated to you.”*
