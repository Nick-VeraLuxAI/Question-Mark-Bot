# Pricing model (practical) — dedicated instance economics

Framework for selling **managed Solomon** when **each customer gets their own deployed environment** (compute + database + Redis + your labor). Numbers are **USD**, illustrative — not legal or tax advice. Adjust for region and margin.

**Core economic idea:** Your **monthly** fee must cover **(a)** the infrastructure footprint of **one stack per customer**, **(b)** your time for patches, tickets, and upgrades, and **(c)** risk buffer. That is **higher** than “one slice of a shared multitenant cluster” pricing.

**OpenAI (and similar):** Almost always **customer-owned billing** or explicit pass-through. Your recurring fee is **platform + operations + support**, not their token spend.

---

## What setup vs monthly vs extra means

| Component | What it covers (dedicated-instance model) |
|-----------|-------------------------------------------|
| **One-time setup** | Provision **their** environment (or first deploy to **their** account in standalone deals); secrets wiring; DNS/TLS handoff checklist; **first internal tenant(s)** to go-live; readiness + embed sanity check; runbook handoff for their contacts |
| **Monthly recurring** | **Their** hosting baseline (VM/DB/Redis/network), monitoring discipline, patch cadence, support channel per tier, **N× internal tenants** within agreed cap |
| **Extra (priced separately)** | Additional **internal** tenants beyond tier; net-new **integration** builds; after-hours / on-call; **second** dedicated instance (e.g. true DR); compliance-heavy workshops beyond governance pack |

**Usage-based (optional):**

- **AI:** Keep OpenAI on **their** invoice; if you aggregate, add a documented **admin fee** (e.g. 10–25%) only if you want that overhead.
- **Chat volume:** If you need caps, use **tier step-up** or negotiated overage after observable metrics (logs / usage tables) — the repo does not bill automatically.

---

## Suggested ranges (SMB / mid-market US, 2026)

Assumes **you** host **one full Solomon stack per customer** (small-to-mid footprint). If their cloud bills **them** directly (standalone), shift monthly toward **pure managed services** and keep setup for handoff + integration.

### One-time setup fee

| Tier | Range | Notes |
|------|--------|--------|
| **Base** | **$5,000 – $15,000** | Full dedicated env, 1–2 internal tenants, 1–2 webhooks, standard go-live |
| **Pro** | **$12,000 – $35,000** | Same dedicated env, more internal tenants + integrations + migration from pilot |
| **Enterprise** | **$30,000 – $95,000+** | HA/sizing, security reviews, DR planning, custom adapter scoping, multiple workshops |

*Lower* if customer provides cloud subscription and you only deploy; *higher* if you procure infra, attend legal/IT meetings, and own backup design.

### Monthly recurring (per customer, per dedicated instance)

| Tier | Range (monthly) | What it roughly includes |
|------|------------------|---------------------------|
| **Base** | **$1,200 – $2,800** | Dedicated small/medium footprint + email/NBD support + security patch cadence |
| **Pro** | **$2,800 – $6,500** | Larger footprint or higher contact volume + priority support + **monthly** health summary + more internal tenants |
| **Enterprise** | **$6,000 – $15,000+** | Sized/HA options + SLA language + named channel + optional on-call retainer |

**Internal tenant overage (optional arithmetic):** **$75 – $350 / month per additional internal tenant** beyond tier inclusion — covers extra verify/onboarding touch and config surface.

---

## Optional line items

| Add-on | Range |
|--------|--------|
| **Major new integration** (net-new system) | **$2,000 – $8,000** one-time |
| **Hourly consulting** | **$175 – $325 / hr** |
| **On-call / after-hours** | **$750 – $3,000 / mo** retainer or per-incident |
| **Second dedicated instance** (e.g. prod + isolated DR) | **Duplicate monthly** at discount or scoped SOW |

---

## What NOT to bundle for free

- Unlimited internal tenants or unlimited webhook destinations.
- Sharing **one** billed instance across **unrelated** customers without explicit margin and isolation review (off-model for default SKUs).
- 24/7 phone without a retainer.
- Their **OpenAI** spend.

---

## Simple packages (copy-paste for proposals)

**“Dedicated managed chat — Base”**

- **Setup:** **$8,500**
- **Monthly:** **$1,899**
- **Includes:** **One dedicated Solomon environment**, 1 production + 1 staging internal tenant, 2 webhook destinations, standard go-live, email support (next business day)

**“Dedicated multi-brand — Pro”**

- **Setup:** **$22,000**
- **Monthly:** **$4,200**
- **Includes:** **One dedicated environment**, up to **8 internal tenants**, up to **5 webhook endpoints**, priority Slack, monthly health summary

**Enterprise**

- Scoped SOW; monthly **$8k+** typical with SLA appendix and governance deliverables

---

## Qualification (fast)

1. **One dedicated instance** confirmed — not “slot on shared SaaS.”
2. How many **internal tenants** (brands/sites)?
3. How many **webhooks** / **inbound** systems?
4. Who pays **OpenAI**?
5. Compliance keywords → usually **Enterprise** or separate discovery; don’t bury in Base.

See **`PACKAGING_STRATEGY.md`** for how to say this in sales copy.
