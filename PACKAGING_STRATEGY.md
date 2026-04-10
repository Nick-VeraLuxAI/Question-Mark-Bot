# Packaging strategy — dedicated managed deployment first

How **Solomon** is **delivered and sold** as a product **without** changing the codebase architecture.

---

## Primary delivery: **dedicated managed instance per customer**

**Default commercial model:** **1 paying customer = 1 deployed Solomon environment** (isolated Postgres, Redis, API, worker, and secrets boundary). Unrelated companies **do not** share that runtime by default.

**What the customer buys:** A **named, managed AI chat and integrations service** at URLs you agree — **their** traffic, **their** configuration, **your** operational responsibility for the stack you deploy.

**What you deliver:**

- **Dedicated** hosting footprint (your account standard) **or** deployment into **their** cloud only when sold as **standalone** (see below).
- Go-live: migrate, seed, health/readiness, **internal tenant(s)** provisioned and verified.
- Embed + integration documentation (PDF/Notion — optional out-of-repo).
- Access model per contract: typically **platform SSO** for `/admin` when integrated; otherwise agreed operator + customer workflow.

**What the customer does not do (managed path):** Run `docker compose` or own day-two patching — unless they buy **standalone** and take ownership.

**Internal multi-brand:** Explain as *“multiple sites or brands **inside your** Solomon — still **your** dedicated system.”* The repo’s **tenant** model maps cleanly to that story; it is **not** the headline for pooling **external** customers.

**Positioning line:** *“Your own managed AI chat stack — we deploy it, run it, and connect it to your tools.”*

---

## Secondary delivery: **standalone install (exception / premium path)**

**When:** Customer **requires** software and data only in **their** subscription (VPC), **OEM** embedding, or procurement forbids vendor-hosted production.

**What they buy:** **License / artifact access** (private repo, releases, or fork) **plus** professional services for deploy, handoff, and bounded support.

**Pricing posture:** **Setup and monthly both tend higher** — you carry less infra margin but **more** risk (their network, their change control, their backup gaps). Scope **support boundaries** tightly in the SOW.

**Positioning line:** *“We deploy Solomon in **your** cloud under a defined handoff — you own the bill and the keys; we sell clarity and hours.”*

**Do not** position standalone as the **cheap** option; position it as **control-first**, priced accordingly.

---

## Customer-visible vs operator-managed

| Customer sees / owns | You manage (dedicated managed offer) |
|----------------------|--------------------------------------|
| Chat embed, branding, business prompts (per agreement) | **Their** Solomon instance lifecycle: images, migrate, worker |
| Webhook **receivers** on **their** systems | **Their** Postgres/Redis/API containers (your hosting) |
| OpenAI org and billing (typical) | Secrets storage discipline, key rotation ceremonies |
| DNS names pointing at **their** instance | Reading `/api/ready`, hints, `troubleshoot.sh`, incident response per tier |
| Internal org: how many brands → how many **internal tenants** | Provisioning those tenants inside **their** env |

**Never imply** another company’s traffic lives in **their** instance unless true.

---

## Marketing narrative (three bullets)

1. **“Your dedicated AI chat engine.”** — Isolated deployment per customer; managed by you.
2. **“Chat on your site, events in your stack.”** — Embeds + signed webhooks + integration API (truthful to repo).
3. **“Optional: several brands, one environment.”** — Internal tenants for multi-site orgs — secondary message, not “multitenant SaaS for the world.”

Avoid: **shared platform** language as the default story, **unlimited scale**, **compliance certification** unless you have it.

---

## Collateral checklist

| Asset | Purpose |
|-------|---------|
| **1-pager** (`PRODUCT_DEFINITION.md`) | Buyer understands **dedicated** + outcomes |
| **Diagram** | Browser → **Customer’s** Solomon URL → OpenAI → **their** webhooks |
| **SOW** | One instance, internal tenant cap, support hours, exclusions |
| **Embed + webhook samples** | Their developers |
| **FAQ** | Who hosts, who pays OpenAI, data isolation, DR |

---

## Competitive framing (honest)

| Alternative | Solomon angle |
|-------------|----------------|
| **DIY** | Same openness as code, but you sell **repeatable dedicated deploy + ops**. |
| **Shared chat SaaS** | You sell **isolation and control** — **their** environment, **your** runbooks. |
| **Enterprise CCaaS** | You are **lighter**; you don’t claim full contact-center parity unless scoped. |

---

## Internal repo map → external language

| Repo reality | Say to buyers |
|--------------|----------------|
| `docker compose` + `start.sh` | “We stand up **your** production stack on go-live.” |
| `Tenant` rows | “**Your** brands or sites **inside your** instance — separate config where needed.” |
| `/api/health` + `/api/ready` | “Hooks **your** IT can monitor for **your** deployment.” |
| No in-app billing | “B2B contract: we invoice for **your** managed environment.” |

---

## “Is this SaaS?”

**Accurate:** *“It’s managed software: **by default you get your own dedicated Solomon environment**. We’re not a consumer signup product, and we don’t put you on a random shared app tier unless we explicitly contract something different.”*

That supports **setup + monthly** pricing in **`PRICING_MODEL.md`**.
