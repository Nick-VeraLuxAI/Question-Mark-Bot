# Product tiers

**Commercial default:** **1 customer = 1 dedicated Solomon environment** (own database, Redis, API, worker, secrets). Tiers differ by **how much you include inside that environment** and **how deeply you operate and support it** — not by placing unrelated customers on the same production stack.

**Internal multi-tenancy:** Within a customer’s dedicated instance, you may provision **multiple tenants** (brands, sites, business units). Tier limits refer to those **internal** tenants unless stated otherwise.

The application does not enforce commercial limits in code — contracts, monitoring, and sizing enforce them.

---

## Tier comparison (at a glance)

| Dimension | **Base** | **Pro** | **Enterprise** |
|-----------|----------|---------|----------------|
| **Deployment model** | **Dedicated instance** per customer (default for all tiers) | Same | Same + HA / sizing / residency discussions |
| **Internal tenants (typical)** | **1–2** (e.g. prod + staging) | **Up to ~10** | **10+** (negotiated) |
| **Integration depth** | 1–2 webhook destinations; standard inbound patterns | Several webhooks + event filters; inbound design review | Custom adapter workshops, more endpoints, CRM mapping |
| **Support** | Email / ticket, next business day | Priority queue, named channel (e.g. Slack) | SLA windows, escalation, governance pack |
| **Operational cadence** | Reactive + security patches | **Monthly** health summary + agreed patch windows | **Quarterly** reviews, change management, optional on-call retainer |
| **Governance** | Standard terms | Named contacts, maintenance windows | SLA language, security questionnaire support, DR/runbook appendix |

**Not in the table:** Unrelated customers **sharing** one Solomon instance as the default — that is **out of scope** for standard tier definitions.

---

## Base

**Audience:** One organization that needs **one dedicated managed environment** and a **single primary brand/site** (plus optional non-prod tenant).

**Included:**

- **One dedicated Solomon deployment** (your standard footprint: VM/namespace + Postgres + Redis + API + worker).
- **Internal tenants:** typically **1 production** + **1 non-production** if you bundle it.
- Standard **embed** and **branding** configuration.
- **Outbound webhooks** — one primary destination (second optional); one-time event-filter guidance.
- **Integration API key** issuance and rotation guidance for inbound routes.
- Initial **go-live:** deploy, migrate, seed, `/api/ready`, first tenant **verify readiness**, embed smoke check.

**Contractual limits (typical):**

- **Internal tenants:** 1–2.
- **Integrations:** 1–2 webhook URLs; no custom adapter build in base fee.
- **AI usage:** Customer-owned **OpenAI** (or equivalent) billing; fair use; you monitor for abuse.

**Operational expectations:**

- **Customer:** API keys they own, DNS/TLS handoff targets, **CORS** origins, webhook receivers.
- **You:** Operate **their** instance; first-line incidents per support tier.

**Configurable vs fixed:**

- **Per internal tenant:** prompts, branding, webhook config, `Tenant.settings` as supported by the product.
- **Fixed in tier:** No HA cluster, no unlimited integration builds.

---

## Pro

**Audience:** Organizations that need **one dedicated environment** but **several internal brands or sites** (multiple tenants in the **same** instance).

**Everything in Base, plus:**

- **Higher internal tenant allowance** (suggest **up to 10** in standard Pro; overage → custom).
- **Tenant onboarding playbook** repeated per internal brand: create → verify → bootstrap → key handoff.
- **Deeper integrations:** multiple `LeadWebhook` rows, event-type filtering, inbound use-case review against `docs/integration-architecture.md`.
- **Operational discipline:** use `/api/ready` **hints**, per-tenant verify badges, **`troubleshoot.sh`** in support workflow.

**Typical limits:**

- **Internal tenants:** up to 10.
- **Support:** priority response (e.g. 8×5 in customer timezone).
- **Cadence:** **monthly** automated health check + short written summary; agreed upgrade windows.

**Configurable vs fixed:**

- **Configurable:** per-tenant `plan` / settings flags where implemented.
- **Fixed:** custom dev beyond scoped integration work → Enterprise or SOW.

---

## Enterprise

**Audience:** Strict IT, regulated contexts, or large orgs needing **paperwork, stronger promises, and larger internal estates** — still **one dedicated environment per contract** unless explicitly scoped otherwise (e.g. separate DR site = second instance = second fee).

**Everything in Pro, plus:**

- **Internal tenant count and integration scope** negotiated; infrastructure **sizing** and optional **HA** patterns.
- **Data residency / region** discussion (within what your cloud and contract allow).
- **Governance pack:** data-flow summary, RBAC/audit description, backup/restore expectations — grounded in repo reality.
- **Small custom work bucket:** e.g. extra adapter review, IdP planning **around** existing platform auth — not a full rewrite.
- **SLA-shaped availability** (e.g. 99.5% monthly on **your** API layer, excluding OpenAI and customer network) — must match how you actually host.

**Exclusions (explicit):**

- Unlimited pen-test remediation, unlimited feature development, unsupported on-prem hardware — unless separately sold.

---

## How to explain tiers to a non-technical buyer

- **Base:** “You get **your own** managed AI chat environment — typically one live site and staging — with standard hooks to your tools.”
- **Pro:** “Same **dedicated** setup, but we support **more brands or sites inside your world** and faster, deeper integration help.”
- **Enterprise:** “**Your** environment with stronger uptime and security promises, more tenants, and room for legal and IT review.”
