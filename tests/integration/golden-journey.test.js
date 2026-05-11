const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const request = require("supertest");
const mock = require("mock-require");

const ROOT = path.join(__dirname, "..", "..");
const SERVER_PATH = path.join(ROOT, "server.js");

function clearIntegrationModuleCache() {
  const modules = [
    SERVER_PATH,
    path.join(ROOT, "services", "outboundEvents.js"),
    path.join(ROOT, "integrations", "domain.js"),
    path.join(ROOT, "integrations", "adapters", "index.js"),
    path.join(ROOT, "integrations", "adapters", "generic.js"),
    path.join(ROOT, "integrations", "adapters", "hubspot.js"),
    path.join(ROOT, "middleware", "tenantApiKey.js"),
    path.join(ROOT, "middleware", "csrfApi.js"),
    path.join(ROOT, "utils", "csp.js"),
    path.join(ROOT, "utils", "jobQueue.js"),
    path.join(ROOT, "utils", "webhook.js"),
  ];
  for (const p of modules) delete require.cache[p];
}

function createPrismaState() {
  const state = {
    tenant: {
      id: "default",
      name: "Default Tenant",
      subdomain: "default",
      plan: "basic",
      apiKeyHash: "stub_hash",
      settings: {
        behavior: {
          tone: "professional",
          primaryGoal: "Help customers",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        businessProfile: {
          businessName: "Default Tenant",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      },
      openaiKey: "sk-test",
      smtpHost: "smtp.test",
      smtpPort: 587,
      smtpUser: "from@test.com",
      smtpPass: "pass",
      emailFrom: "from@test.com",
      emailTo: "to@test.com",
      prompts: {
        system: "You are a helpful assistant.",
        policy: "Be accurate.",
        voice: "Be concise.",
      },
    },
    conversations: [{ id: "conv1", tenantId: "default", sessionId: "sid1", summary: "", summaryUpdatedAt: null }],
    messages: [],
    leads: [{ id: "lead1", tenantId: "default", email: "a@test.com", phone: "555-111-2222", createdAt: new Date() }],
    handoffs: [],
    identities: [],
    channelMessages: [],
    appointments: [],
    quotes: [],
    consents: [],
    audits: [],
    revenue: [],
    optimization: [],
    campaigns: [],
    benchmarks: [],
    onboarding: [],
    leadWebhooks: [
      {
        id: "hook1",
        tenantId: "default",
        endpoint: "https://example.com/hook",
        secret: "sec",
        enabled: true,
        events: [],
      },
      {
        id: "hook2",
        tenantId: "default",
        endpoint: "https://example.com/leads-only",
        secret: "sec",
        enabled: true,
        events: ["lead.created"],
      },
    ],
    webhookCalls: [],
    enqueueCalls: [],
    knowledgeDocs: [
      { id: "kd1", tenantId: "default", title: "FAQ", content: "Hello", status: "active", createdAt: new Date(), updatedAt: new Date() },
    ],
    memberships: [
      {
        id: "mem_default_u1",
        tenantId: "default",
        userId: "u1",
        email: "op@test.com",
        role: "owner",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    tenantAcme: {
      id: "acme",
      name: "Acme Corp",
      subdomain: "acme",
      plan: "basic",
      apiKeyHash: "stub_hash_acme",
      settings: {
        behavior: { tone: "professional", primaryGoal: "Help", updatedAt: "2024-01-01T00:00:00.000Z" },
        businessProfile: { businessName: "Acme", updatedAt: "2024-01-01T00:00:00.000Z" },
      },
      openaiKey: "sk-test",
      smtpHost: "smtp.test",
      smtpPort: 587,
      smtpUser: "from@test.com",
      smtpPass: "pass",
      emailFrom: "from@test.com",
      emailTo: "to@test.com",
      prompts: { system: "Hi", policy: "Be good", voice: "Short" },
    },
  };
  return state;
}

function sortAndTake(rows, orderBy, take) {
  let out = [...rows];
  if (orderBy?.createdAt === "desc") out.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  if (orderBy?.lastSeenAt === "desc") out.sort((a, b) => +new Date(b.lastSeenAt) - +new Date(a.lastSeenAt));
  if (typeof take === "number") out = out.slice(0, take);
  return out;
}

function createPrismaMock(state) {
  let seq = 1;
  const id = (pfx) => `${pfx}_${seq++}`;

  class PrismaClient {
    constructor() {
      this.tenant = {
        findFirst: async ({ where } = {}) => {
          if (!where?.OR || !Array.isArray(where.OR)) return state.tenant;
          for (const cond of where.OR) {
            let cand = cond.subdomain || cond.id || null;
            if (!cand && cond.name && typeof cond.name === "object" && cond.name.equals != null) {
              cand = cond.name.equals;
            }
            if (!cand && typeof cond.name === "string") cand = cond.name;
            if (!cand) continue;
            const low = String(cand).toLowerCase();
            if (state.tenantAcme && (low === state.tenantAcme.id || low === String(state.tenantAcme.subdomain).toLowerCase())) {
              return state.tenantAcme;
            }
            if (
              low === state.tenant.id ||
              low === String(state.tenant.subdomain).toLowerCase() ||
              low === String(state.tenant.name).toLowerCase()
            ) {
              return state.tenant;
            }
          }
          return null;
        },
        update: async ({ where, data }) => {
          const wid = where?.id;
          if (state.tenantAcme && wid === state.tenantAcme.id) {
            state.tenantAcme = { ...state.tenantAcme, ...data };
            return state.tenantAcme;
          }
          state.tenant = { ...state.tenant, ...data };
          return state.tenant;
        },
        findMany: async () => {
          const rows = [state.tenant];
          if (state.tenantAcme) rows.push(state.tenantAcme);
          return rows;
        },
      };
      this.tenantMembership = {
        findFirst: async ({ where } = {}) => {
          const tid = where?.tenantId;
          const st = where?.status;
          if (!tid) return null;
          if (st != null && String(st).toLowerCase() !== "active") return null;
          const orList = where?.OR;
          if (!Array.isArray(orList)) return null;
          for (const m of state.memberships || []) {
            if (m.tenantId !== tid) continue;
            if (String(m.status || "").toLowerCase() !== "active") continue;
            for (const br of orList) {
              if (br.userId != null && m.userId === br.userId) return m;
              const eq = br.email && typeof br.email === "object" ? br.email.equals : null;
              if (eq != null && m.email && String(m.email).toLowerCase() === String(eq).toLowerCase()) return m;
            }
          }
          return null;
        },
        findMany: async ({ where, include, orderBy: _orderBy } = {}) => {
          let rows = [...(state.memberships || [])].filter((m) => {
            if (where?.userId != null && m.userId !== where.userId) return false;
            if (where?.status != null && String(m.status).toLowerCase() !== String(where.status).toLowerCase())
              return false;
            return true;
          });
          if (include?.tenant) {
            rows = rows.map((m) => ({
              ...m,
              tenant: m.tenantId === state.tenantAcme?.id ? state.tenantAcme : state.tenant,
            }));
          }
          return rows;
        },
      };
      this.conversation = {
        upsert: async ({ where, create }) => {
          const key = where.tenantId_sessionId;
          let row = state.conversations.find((c) => c.tenantId === key.tenantId && c.sessionId === key.sessionId);
          if (!row) {
            row = { id: id("conv"), ...create, summary: "", summaryUpdatedAt: null };
            state.conversations.push(row);
          }
          return row;
        },
        findUnique: async ({ where }) => {
          const key = where.tenantId_sessionId;
          const row = state.conversations.find((c) => c.tenantId === key.tenantId && c.sessionId === key.sessionId);
          if (!row) return null;
          const messages = state.messages
            .filter((m) => m.conversationId === row.id)
            .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
            .slice(0, 8);
          return { ...row, messages };
        },
        update: async ({ where, data }) => {
          const key = where.tenantId_sessionId;
          const idx = state.conversations.findIndex((c) => c.tenantId === key.tenantId && c.sessionId === key.sessionId);
          state.conversations[idx] = { ...state.conversations[idx], ...data };
          return state.conversations[idx];
        },
        count: async ({ where } = {}) => {
          let rows = state.conversations;
          if (where?.tenantId) rows = rows.filter((c) => c.tenantId === where.tenantId);
          return rows.length;
        },
      };
      this.message = {
        create: async ({ data }) => {
          const row = { id: id("msg"), ...data, createdAt: new Date() };
          state.messages.push(row);
          return row;
        },
        count: async () => state.messages.length,
      };
      this.tagDictionary = { findMany: async () => [] };
      this.lead = {
        findFirst: async () => state.leads[0] || null,
        findUnique: async ({ where }) => state.leads.find((x) => x.id === where.id) || null,
        update: async ({ where, data }) => {
          const i = state.leads.findIndex((x) => x.id === where.id);
          state.leads[i] = { ...state.leads[i], ...data };
          return state.leads[i];
        },
        count: async () => state.leads.length,
      };
      this.leadWebhook = {
        findMany: async ({ where } = {}) => {
          let rows = [...state.leadWebhooks];
          if (where?.tenantId) rows = rows.filter((x) => x.tenantId === where.tenantId);
          if (where?.enabled !== undefined) rows = rows.filter((x) => x.enabled === where.enabled);
          if (where?.id) rows = rows.filter((x) => x.id === where.id);
          return rows;
        },
        findFirst: async ({ where }) =>
          state.leadWebhooks.find((x) => x.id === where.id && x.tenantId === where.tenantId) || null,
        create: async ({ data }) => {
          const row = {
            id: id("wh"),
            tenantId: data.tenantId,
            endpoint: data.endpoint,
            secret: data.secret ?? null,
            enabled: data.enabled !== false,
            events: Array.isArray(data.events) ? data.events : [],
            createdAt: new Date(),
          };
          state.leadWebhooks.push(row);
          return row;
        },
        updateMany: async ({ where, data }) => {
          const i = state.leadWebhooks.findIndex((x) => x.id === where.id && x.tenantId === where.tenantId);
          if (i < 0) return { count: 0 };
          state.leadWebhooks[i] = { ...state.leadWebhooks[i], ...data };
          return { count: 1 };
        },
        update: async ({ where, data }) => {
          const i = state.leadWebhooks.findIndex((x) => x.id === where.id);
          if (i < 0) throw new Error("webhook_not_found");
          state.leadWebhooks[i] = { ...state.leadWebhooks[i], ...data };
          return state.leadWebhooks[i];
        },
        delete: async ({ where }) => {
          const i = state.leadWebhooks.findIndex((x) => x.id === where.id);
          if (i >= 0) state.leadWebhooks.splice(i, 1);
        },
        deleteMany: async ({ where }) => {
          const tid = where?.tenantId;
          const wid = where?.id;
          const before = state.leadWebhooks.length;
          state.leadWebhooks = state.leadWebhooks.filter((x) => !(x.id === wid && (!tid || x.tenantId === tid)));
          return { count: before - state.leadWebhooks.length };
        },
        count: async ({ where } = {}) => {
          let rows = [...state.leadWebhooks];
          if (where?.tenantId) rows = rows.filter((x) => x.tenantId === where.tenantId);
          if (where?.enabled !== undefined) rows = rows.filter((x) => x.enabled === where.enabled);
          return rows.length;
        },
      };
      this.knowledgeDocument = {
        count: async ({ where } = {}) => {
          const rows = state.knowledgeDocs || [];
          if (!where?.tenantId) return rows.length;
          return rows.filter(
            (d) => d.tenantId === where.tenantId && (!where.status || d.status === where.status)
          ).length;
        },
      };
      this.usage = { aggregate: async () => ({ _sum: { cost: 0, promptTokens: 0, completionTokens: 0 }, _count: 1 }) };
      this.metric = { aggregate: async () => ({ _avg: { value: 50 } }) };
      this.event = { create: async () => ({ id: id("evt") }) };
      this.alertRule = { findMany: async () => [] };
      this.alertIncident = { create: async () => ({ id: id("inc") }) };
      this.promptVersion = { findMany: async () => [] };
      this.knowledgeChunk = { findMany: async () => [] };
      this.auditLog = {
        create: async ({ data }) => {
          const row = { id: id("audit"), ...data, createdAt: new Date() };
          state.audits.push(row);
          return row;
        },
        findMany: async () => state.audits,
      };
      this.outboxJob = { create: async () => ({ id: id("job") }) };
      this.handoffSession = {
        create: async ({ data }) => {
          const row = { id: id("handoff"), ...data, createdAt: new Date(), resolvedAt: null };
          state.handoffs.push(row);
          return row;
        },
        findFirst: async ({ where }) =>
          state.handoffs.find((x) => x.id === where.id && x.tenantId === where.tenantId) || null,
        updateMany: async ({ where, data }) => {
          const i = state.handoffs.findIndex((x) => x.id === where.id && x.tenantId === where.tenantId);
          if (i < 0) return { count: 0 };
          state.handoffs[i] = { ...state.handoffs[i], ...data };
          return { count: 1 };
        },
        update: async ({ where, data }) => {
          const i = state.handoffs.findIndex((x) => x.id === where.id);
          if (i < 0) throw new Error("handoff_not_found");
          state.handoffs[i] = { ...state.handoffs[i], ...data };
          return state.handoffs[i];
        },
      };
      this.channelIdentity = {
        upsert: async ({ where, update, create }) => {
          const key = where.tenantId_channel_externalUserId;
          let row = state.identities.find(
            (x) => x.tenantId === key.tenantId && x.channel === key.channel && x.externalUserId === key.externalUserId
          );
          if (!row) {
            row = { id: id("cid"), ...create, lastSeenAt: new Date(), createdAt: new Date() };
            state.identities.push(row);
          } else {
            row = { ...row, ...update };
            const idx = state.identities.findIndex((x) => x.id === row.id);
            state.identities[idx] = row;
          }
          return row;
        },
        findMany: async ({ orderBy, take }) => sortAndTake(state.identities, orderBy, take),
      };
      this.channelMessage = {
        create: async ({ data }) => {
          const row = { id: id("cmsg"), ...data, createdAt: new Date() };
          state.channelMessages.push(row);
          return row;
        },
      };
      this.appointment = {
        create: async ({ data }) => {
          const row = { id: id("appt"), ...data, createdAt: new Date() };
          state.appointments.push(row);
          return row;
        },
      };
      this.quote = {
        create: async ({ data }) => {
          const row = { id: id("quote"), ...data, createdAt: new Date(), acceptedAt: null };
          state.quotes.push(row);
          return row;
        },
      };
      this.consentRecord = {
        create: async ({ data }) => {
          const row = { id: id("consent"), ...data, createdAt: new Date() };
          state.consents.push(row);
          return row;
        },
        findMany: async () => state.consents,
      };
      this.revenueEvent = {
        create: async ({ data }) => {
          const row = { id: id("rev"), ...data, createdAt: new Date() };
          state.revenue.push(row);
          return row;
        },
        count: async ({ where }) =>
          state.revenue.filter((x) => (!where.stage || x.stage === where.stage) && (!where.tenantId || x.tenantId === where.tenantId)).length,
        aggregate: async ({ where }) => {
          const rows = state.revenue.filter((x) => (!where.stage || x.stage === where.stage) && x.tenantId === where.tenantId);
          const amount = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
          return { _count: rows.length, _sum: { amount } };
        },
      };
      this.optimizationRun = {
        upsert: async ({ where, update, create }) => {
          const key = where.tenantId_experimentKey_variant;
          let row = state.optimization.find(
            (x) => x.tenantId === key.tenantId && x.experimentKey === key.experimentKey && x.variant === key.variant
          );
          if (!row) {
            row = { id: id("opt"), ...create, createdAt: new Date(), updatedAt: new Date() };
            state.optimization.push(row);
          } else {
            row = {
              ...row,
              impressions: row.impressions + Number(update.impressions?.increment || 0),
              conversions: row.conversions + Number(update.conversions?.increment || 0),
              revenue: row.revenue + Number(update.revenue?.increment || 0),
              updatedAt: new Date(),
            };
            const idx = state.optimization.findIndex((x) => x.id === row.id);
            state.optimization[idx] = row;
          }
          return row;
        },
        findMany: async ({ where }) => state.optimization.filter((x) => x.tenantId === where.tenantId && x.experimentKey === where.experimentKey),
      };
      this.reengagementCampaign = {
        create: async ({ data }) => {
          const row = { id: id("camp"), ...data, createdAt: new Date() };
          state.campaigns.push(row);
          return row;
        },
      };
      this.benchmarkRun = {
        create: async ({ data }) => {
          const row = { id: id("bench"), ...data, createdAt: new Date() };
          state.benchmarks.push(row);
          return row;
        },
        findMany: async ({ orderBy, take }) => sortAndTake(state.benchmarks, orderBy, take),
      };
      this.onboardingSession = {
        create: async ({ data }) => {
          const row = { id: id("onboard"), ...data, createdAt: new Date(), completedAt: null };
          state.onboarding.push(row);
          return row;
        },
        findUnique: async ({ where }) => state.onboarding.find((x) => x.id === where.id) || null,
        update: async ({ where, data }) => {
          const idx = state.onboarding.findIndex((x) => x.id === where.id);
          state.onboarding[idx] = { ...state.onboarding[idx], ...data };
          return state.onboarding[idx];
        },
      };
      this.$queryRaw = async () => 1;
    }
  }

  return PrismaClient;
}

function buildApp({ role = "operator", blockPromptInjection = "0" } = {}) {
  const state = createPrismaState();
  process.env.BLOCK_PROMPT_INJECTION = blockPromptInjection;
  process.env.DEFAULT_TENANT = "default";
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_EVENTS_SECRET = "test_channel_events_secret";
  process.env.CONSENT_WRITE_SECRET = "test_consent_write_secret";
  delete process.env.PLATFORM_URL;

  mock("@prisma/client", { PrismaClient: createPrismaMock(state) });
  mock(path.join(ROOT, "middleware", "platformSSO.js"), {
    platformSSOMiddleware: () => (req, _res, next) => {
      req.platformUser = { id: "u1", email: "op@test.com", role };
      req.platformTenant = { slug: "default", name: "Default Tenant" };
      const q = req.query && req.query.tenant;
      if (q == null || String(q).trim() === "") {
        req.tenantSlugOverride = "default";
      }
      next();
    },
    verifyPlatformToken: async () => ({ valid: true, user: { id: "u1" }, tenant: { slug: "default" } }),
  });
  mock("nodemailer", {
    createTransport: () => ({ sendMail: async () => ({ response: "ok" }) }),
  });
  mock("openai", class OpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async () => ({
            model: "gpt-4o-mini",
            usage: { prompt_tokens: 12, completion_tokens: 18, cached_tokens: 0 },
            choices: [{ message: { content: "Assistant response" } }],
          }),
        },
      };
    }
  });
  mock(path.join(ROOT, "adminClient.js"), {
    logEvent: async () => {},
    logError: async () => {},
    logUsage: async () => {},
    logMetric: async () => {},
    logConversation: async () => {},
    logLead: async () => {},
    logLatency: async () => {},
    logSuccess: async () => {},
  });
  mock(path.join(ROOT, "utils", "jobQueue.js"), {
    enqueue: async (...args) => {
      state.enqueueCalls.push(args);
      return true;
    },
  });
  mock(path.join(ROOT, "utils", "webhook.js"), {
    sendGenericWebhook: async (endpoint, body) => {
      state.webhookCalls.push({ endpoint, body });
      return { status: 200, ok: true };
    },
  });

  clearIntegrationModuleCache();
  const { app } = require(SERVER_PATH);
  return {
    app,
    state,
    cleanup() {
      delete process.env.CHANNEL_EVENTS_SECRET;
      delete process.env.CONSENT_WRITE_SECRET;
      delete process.env.ALLOW_PLATFORM_SUPER_ADMIN_ALL_TENANTS;
      mock.stopAll();
      clearIntegrationModuleCache();
    },
  };
}

test("golden journey: message -> handoff -> appointment -> quote -> funnel", async () => {
  const ctx = buildApp();
  const { app, cleanup } = ctx;

  const msg = await request(app).post("/message?tenant=default").send({ message: "Need pricing for kitchen remodel" });
  assert.equal(msg.status, 200);
  assert.equal(typeof msg.body.reply, "string");

  const handoff = await request(app)
    .post("/api/handoff/sessions?tenant=default")
    .send({ sessionId: "sid1", reason: "high intent", priority: "high" });
  assert.equal(handoff.status, 201);

  const assign = await request(app)
    .post(`/api/handoff/${handoff.body.handoff.id}/assign?tenant=default`)
    .send({ assignedTo: "agent@company.com", status: "in_progress" });
  assert.equal(assign.status, 200);
  assert.equal(assign.body.handoff.assignedTo, "agent@company.com");

  const appt = await request(app)
    .post("/api/appointments?tenant=default")
    .send({ leadId: "lead1", title: "Consult Call", startsAt: new Date().toISOString() });
  assert.equal(appt.status, 201);

  const quote = await request(app)
    .post("/api/quotes?tenant=default")
    .send({ leadId: "lead1", amount: 2500, notes: "Initial estimate" });
  assert.equal(quote.status, 201);

  // Simulate a closed deal for funnel revenue.
  ctx.state.revenue.push({ id: "won1", tenantId: "default", stage: "deal_won", amount: 2500, createdAt: new Date() });
  const funnel = await request(app).get("/api/revenue/funnel?tenant=default");
  assert.equal(funnel.status, 200);
  assert.ok(funnel.body.leads >= 1);
  assert.ok(funnel.body.wonRevenue >= 2500);

  cleanup();
});

test("channels identity + consent export + webhook test", async () => {
  const { app, state, cleanup } = buildApp();

  const evt = await request(app)
    .post("/api/channels/events?tenant=default")
    .set("X-Channel-Events-Secret", "test_channel_events_secret")
    .send({
      channel: "web",
      externalUserId: "user-123",
      text: "Hello there",
    });
  assert.equal(evt.status, 200);

  const ids = await request(app).get("/api/channels/identities?tenant=default");
  assert.equal(ids.status, 200);
  assert.equal(ids.body.identities.length, 1);

  const consent = await request(app)
    .post("/api/compliance/consent?tenant=default")
    .set("X-Consent-Write-Secret", "test_consent_write_secret")
    .send({
      subject: "user-123",
      purpose: "marketing",
      granted: true,
      source: "web",
    });
  assert.equal(consent.status, 201);

  const exportRes = await request(app).get("/api/compliance/export?tenant=default");
  assert.equal(exportRes.status, 200);
  assert.ok(Array.isArray(exportRes.body.consents));

  const web = await request(app).post("/api/integrations/webhook-test?tenant=default").send({
    webhookId: "hook1",
  });
  assert.equal(web.status, 200);
  assert.ok(state.webhookCalls.length >= 1);

  cleanup();
});

test("channel events rejects wrong secret when CHANNEL_EVENTS_SECRET is set", async () => {
  const { app, cleanup } = buildApp();
  const bad = await request(app)
    .post("/api/channels/events?tenant=default")
    .set("X-Channel-Events-Secret", "wrong")
    .send({ channel: "web", externalUserId: "u1", text: "hi" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, "channel_events_secret_invalid");
  cleanup();
});

test("handoff assign is tenant-scoped (cannot assign another tenant session)", async () => {
  const { app, state, cleanup } = buildApp();
  state.handoffs.push({
    id: "handoff_other_tenant",
    tenantId: "other-tenant",
    sessionId: "sid-x",
    status: "open",
    assignedTo: null,
    priority: "normal",
    reason: null,
    transcript: null,
    createdAt: new Date(),
    resolvedAt: null,
  });
  const assign = await request(app)
    .post("/api/handoff/handoff_other_tenant/assign?tenant=default")
    .send({ assignedTo: "evil@x.com" });
  assert.equal(assign.status, 404);
  assert.equal(assign.body.error, "not_found");
  cleanup();
});

test("optimization + benchmarks + onboarding + campaign dispatch", async () => {
  const { app, state, cleanup } = buildApp();

  const o1 = await request(app).post("/api/optimize/record?tenant=default").send({
    experimentKey: "prompt-v1",
    variant: "A",
    impressions: 100,
    conversions: 10,
    revenue: 500,
  });
  assert.equal(o1.status, 200);

  const o2 = await request(app).post("/api/optimize/record?tenant=default").send({
    experimentKey: "prompt-v1",
    variant: "B",
    impressions: 100,
    conversions: 20,
    revenue: 700,
  });
  assert.equal(o2.status, 200);

  const rec = await request(app).get("/api/optimize/recommendation?tenant=default&experimentKey=prompt-v1");
  assert.equal(rec.status, 200);
  assert.equal(rec.body.recommendation.variant, "B");

  const bench = await request(app).post("/api/benchmarks/run?tenant=default").send({
    name: "Model Comparison",
    baseline: { conversionRate: 0.12 },
    candidate: { conversionRate: 0.19 },
  });
  assert.equal(bench.status, 201);

  const list = await request(app).get("/api/benchmarks?tenant=default");
  assert.equal(list.status, 200);
  assert.equal(list.body.benchmarks.length, 1);

  const onboard = await request(app).post("/api/onboarding/start?tenant=default").send({});
  assert.equal(onboard.status, 201);

  const step = await request(app)
    .post(`/api/onboarding/${onboard.body.onboarding.id}/step?tenant=default`)
    .send({ step: "branding" });
  assert.equal(step.status, 200);
  assert.ok(step.body.onboarding.progress > 0);

  const camp = await request(app).post("/api/reengagement/campaigns?tenant=default").send({
    name: "Stale Leads",
    template: "Still interested in your project?",
    criteria: { staleDays: 14 },
  });
  assert.equal(camp.status, 201);
  assert.equal(camp.body.dispatchedWebhooks, 1);
  assert.equal(state.enqueueCalls.length > 0, true);

  cleanup();
});

test("GET /admin/ serves dashboard (trailing slash)", async () => {
  const { app, cleanup } = buildApp();
  const res = await request(app).get("/admin/");
  assert.equal(res.status, 200);
  assert.ok(String(res.headers["content-security-policy"] || "").includes("script-src 'nonce-"));
  assert.ok(res.text.includes("admin.js?v=18"));
  assert.ok(res.text.includes('data-portal="operator"'));
  cleanup();
});

test("GET /admin/client serves client portal shell", async () => {
  const { app, cleanup } = buildApp();
  const res = await request(app).get("/admin/client");
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('data-portal="client"'));
  assert.ok(res.text.includes("admin-portal-client"));
  cleanup();
});

test("dashboard: webhook meta and list", async () => {
  const { app, cleanup } = buildApp();
  const meta = await request(app).get("/api/integrations/webhooks/meta?tenant=default");
  assert.equal(meta.status, 200);
  assert.ok(Array.isArray(meta.body.eventTypes));
  assert.ok(meta.body.eventTypes.includes("lead.created"));
  const list = await request(app).get("/api/integrations/webhooks?tenant=default");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.webhooks));
  assert.ok(list.body.webhooks.length >= 1);
  const probe = await request(app).get("/api/integrations/webhook-test?tenant=default");
  assert.equal(probe.status, 200);
  assert.equal(probe.body.ok, true);
  cleanup();
});

test("viewer cannot provision tenants (tenants:provision)", async () => {
  const { app, cleanup } = buildApp({ role: "viewer" });
  const list = await request(app).get("/api/admin/tenants?tenant=default");
  assert.equal(list.status, 403);
  const create = await request(app)
    .post("/api/admin/tenants?tenant=default")
    .send({ slug: "acme", name: "Acme" });
  assert.equal(create.status, 403);
  cleanup();
});

test("viewer cannot mutate integration config (SOC2 RBAC)", async () => {
  const ctx = buildApp({ role: "viewer" });
  ctx.state.memberships[0].role = "viewer";
  const { app, cleanup } = ctx;
  const rot = await request(app).post("/api/keys/rotate?tenant=default").send({});
  assert.equal(rot.status, 403);
  const wh = await request(app)
    .post("/api/integrations/webhooks?tenant=default")
    .send({ endpoint: "https://example.com/h" });
  assert.equal(wh.status, 403);
  const ping = await request(app)
    .post("/api/integrations/webhook-test?tenant=default")
    .send({ webhookId: "hook1" });
  assert.equal(ping.status, 403);
  const pingGet = await request(app).get("/api/integrations/webhook-test?tenant=default");
  assert.equal(pingGet.status, 403);
  cleanup();
});

test("RBAC enforcement denies viewer write access", async () => {
  const ctx = buildApp({ role: "viewer" });
  ctx.state.memberships[0].role = "viewer";
  const { app, cleanup } = ctx;
  const res = await request(app).post("/api/appointments?tenant=default").send({
    title: "Consult",
    startsAt: new Date().toISOString(),
  });
  assert.equal(res.status, 403);
  cleanup();
});

test("GET /api/public/embed-config returns theme for tenant", async () => {
  const { app, cleanup } = buildApp();
  const res = await request(app).get("/api/public/embed-config?tenant=default");
  assert.equal(res.status, 200);
  assert.equal(res.body.tenantSlug, "default");
  assert.equal(res.body.theme, "auto");
  assert.equal(res.body.uiProfile, "client");
  assert.ok(typeof res.body.headerTitle === "string" && res.body.headerTitle.length > 0);
  assert.ok(Array.isArray(res.body.starters));
  cleanup();
});

test("integrations branding: read and patch embed theme", async () => {
  const { app, cleanup } = buildApp();
  const get = await request(app).get("/api/integrations/branding?tenant=default");
  assert.equal(get.status, 200);
  assert.equal(get.body.appearance.theme, "auto");
  const patch = await request(app)
    .patch("/api/integrations/branding?tenant=default")
    .send({ appearance: { theme: "dark" } });
  assert.equal(patch.status, 200);
  const get2 = await request(app).get("/api/integrations/branding?tenant=default");
  assert.equal(get2.body.appearance.theme, "dark");
  cleanup();
});

test("viewer cannot patch branding (config:write)", async () => {
  const ctx = buildApp({ role: "viewer" });
  ctx.state.memberships[0].role = "viewer";
  const { app, cleanup } = ctx;
  const res = await request(app)
    .patch("/api/integrations/branding?tenant=default")
    .send({ appearance: { theme: "light" } });
  assert.equal(res.status, 403);
  cleanup();
});

test("GET /api/admin/pilot-readiness returns scored checklist", async () => {
  const { app, cleanup } = buildApp();
  const r = await request(app).get("/api/admin/pilot-readiness?tenant=default");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.tenant && r.body.tenant.slug);
  assert.ok(["ready", "needs_attention", "operator_required"].includes(r.body.readiness.status));
  assert.ok(typeof r.body.readiness.score === "number");
  assert.ok(Array.isArray(r.body.readiness.items) && r.body.readiness.items.length > 5);
  cleanup();
});

test("business profile read and patch merge settings", async () => {
  const { app, cleanup } = buildApp();
  const g = await request(app).get("/api/admin/business-profile?tenant=default");
  assert.equal(g.status, 200);
  assert.equal(g.body.source, "tenant.settings.businessProfile");
  assert.ok(g.body.businessProfile);
  const p = await request(app)
    .patch("/api/admin/business-profile?tenant=default")
    .send({
      businessProfile: {
        businessName: "Acme Remodeling",
        phone: "555-0100",
        website: "https://example.com/acme",
      },
    });
  assert.equal(p.status, 200);
  assert.equal(p.body.businessProfile.businessName, "Acme Remodeling");
  assert.equal(p.body.businessProfile.phone, "555-0100");
  assert.equal(p.body.businessProfile.website, "https://example.com/acme");
  const g2 = await request(app).get("/api/admin/business-profile?tenant=default");
  assert.equal(g2.body.businessProfile.businessName, "Acme Remodeling");
  cleanup();
});

test("viewer cannot patch business profile (config:write)", async () => {
  const ctx = buildApp({ role: "viewer" });
  ctx.state.memberships[0].role = "viewer";
  const { app, cleanup } = ctx;
  const res = await request(app)
    .patch("/api/admin/business-profile?tenant=default")
    .send({ businessProfile: { businessName: "X" } });
  assert.equal(res.status, 403);
  cleanup();
});

test("client portal: /api/client/me lists allowed tenants; stats forbidden for wrong tenant", async () => {
  const { app, cleanup } = buildApp();
  const me = await request(app).get("/api/client/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.portalMode, "client");
  assert.ok(Array.isArray(me.body.allowedTenants));
  assert.ok(me.body.allowedTenants.some((t) => t.slug === "default"));
  assert.equal(me.body.signedIn, true);
  const okStats = await request(app).get("/api/client/stats?tenant=default");
  assert.equal(okStats.status, 200);
  const bad = await request(app).get("/api/client/stats?tenant=nope");
  assert.equal(bad.status, 403);
  assert.equal(bad.body.error, "tenant_not_allowed");
  const pr = await request(app).get("/api/client/pilot-readiness?tenant=default");
  assert.equal(pr.status, 200);
  assert.ok(pr.body.launch && pr.body.launch.headline);
  assert.equal(pr.body.readiness, undefined);
  cleanup();
});

test("client portal: viewer membership cannot PATCH bot behavior", async () => {
  const ctx = buildApp();
  ctx.state.memberships[0].role = "viewer";
  const { app, cleanup } = ctx;
  const p = await request(app)
    .patch("/api/client/bot-behavior?tenant=default")
    .send({ behavior: { tone: "friendly" } });
  assert.equal(p.status, 403);
  cleanup();
});

test("POST /api/keys/rotate: owner membership succeeds even when platform role is viewer", async () => {
  const ctx = buildApp({ role: "viewer" });
  ctx.state.memberships[0].role = "owner";
  const { app, cleanup } = ctx;
  const r = await request(app).post("/api/keys/rotate?tenant=default").send({});
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.apiKey === "string" && r.body.apiKey.startsWith("qmb_"));
  cleanup();
});

test("POST /api/keys/rotate: no membership and no super-admin bypass is denied", async () => {
  const ctx = buildApp({ role: "operator" });
  ctx.state.memberships = [];
  const { app, cleanup } = ctx;
  const r = await request(app).post("/api/keys/rotate?tenant=default").send({});
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("POST /api/keys/rotate: analyst membership denied", async () => {
  const ctx = buildApp({ role: "operator" });
  ctx.state.memberships[0].role = "analyst";
  const { app, cleanup } = ctx;
  const r = await request(app).post("/api/keys/rotate?tenant=default").send({});
  assert.equal(r.status, 403);
  cleanup();
});

test("POST /api/keys/rotate: tenant operator membership allowed", async () => {
  const ctx = buildApp({ role: "viewer" });
  ctx.state.memberships[0].role = "operator";
  const { app, cleanup } = ctx;
  const r = await request(app).post("/api/keys/rotate?tenant=default").send({});
  assert.equal(r.status, 200);
  cleanup();
});

test("POST /api/keys/rotate: membership on default cannot rotate acme tenant", async () => {
  const ctx = buildApp({ role: "operator" });
  const { app, cleanup } = ctx;
  const r = await request(app).post("/api/keys/rotate?tenant=acme").send({});
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("POST /api/keys/rotate: super-admin bypass without membership", async () => {
  process.env.ALLOW_PLATFORM_SUPER_ADMIN_ALL_TENANTS = "1";
  const ctx = buildApp({ role: "admin" });
  ctx.state.memberships = [];
  const { app, cleanup } = ctx;
  const r = await request(app).post("/api/keys/rotate?tenant=default").send({});
  assert.equal(r.status, 200);
  cleanup();
});

test("POST /api/keys/rotate: super-admin flag does not bypass for platform operator role", async () => {
  process.env.ALLOW_PLATFORM_SUPER_ADMIN_ALL_TENANTS = "1";
  const ctx = buildApp({ role: "operator" });
  ctx.state.memberships = [];
  const { app, cleanup } = ctx;
  const r = await request(app).post("/api/keys/rotate?tenant=default").send({});
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("operator tenant routes: default member cannot access acme tenant (knowledge)", async () => {
  const { app, cleanup } = buildApp({ role: "operator" });
  const r = await request(app).get("/api/admin/knowledge?tenant=acme");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("operator tenant routes: viewer membership cannot PATCH /api/admin/bot-behavior", async () => {
  const ctx = buildApp({ role: "operator" });
  ctx.state.memberships[0].role = "viewer";
  const { app, cleanup } = ctx;
  const r = await request(app).patch("/api/admin/bot-behavior?tenant=default").send({ behavior: { tone: "friendly" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "forbidden");
  cleanup();
});

test("operator tenant routes: wrong tenant conversations denied", async () => {
  const { app, cleanup } = buildApp({ role: "operator" });
  const r = await request(app).get("/api/admin/conversations?tenant=acme");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("operator tenant routes: compliance export wrong tenant denied", async () => {
  const { app, cleanup } = buildApp({ role: "operator" });
  const r = await request(app).get("/api/compliance/export?tenant=acme");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("operator tenant routes: POST webhooks wrong tenant denied", async () => {
  const { app, cleanup } = buildApp({ role: "operator" });
  const r = await request(app)
    .post("/api/integrations/webhooks?tenant=acme")
    .send({ endpoint: "https://example.com/h" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("operator tenant routes: GET /auth wrong tenant denied before redirect", async () => {
  const { app, cleanup } = buildApp({ role: "operator" });
  const r = await request(app).get("/auth?tenant=acme");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("POST /api/integrations/webhook-test rejects arbitrary endpoint", async () => {
  const { app, cleanup } = buildApp();
  const r = await request(app)
    .post("/api/integrations/webhook-test?tenant=default")
    .send({ endpoint: "https://evil.example/hook" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "arbitrary_endpoint_disabled");
  cleanup();
});

test("tenant analyst: stats read ok, optimize write denied", async () => {
  const ctx = buildApp({ role: "operator" });
  ctx.state.memberships[0].role = "analyst";
  const { app, cleanup } = ctx;
  const st = await request(app).get("/api/stats?tenant=default");
  assert.equal(st.status, 200);
  const op = await request(app).post("/api/optimize/record?tenant=default").send({
    experimentKey: "e1",
    variant: "A",
    impressions: 1,
    conversions: 0,
    revenue: 0,
  });
  assert.equal(op.status, 403);
  assert.equal(op.body.error, "forbidden");
  cleanup();
});

test("no membership: GET /api/config denied", async () => {
  const ctx = buildApp({ role: "operator" });
  ctx.state.memberships = [];
  const { app, cleanup } = ctx;
  const r = await request(app).get("/api/config?tenant=default");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "tenant_access_denied");
  cleanup();
});

test("platform operator cannot list tenants (provisioning owner/admin only)", async () => {
  const { app, cleanup } = buildApp({ role: "operator" });
  const r = await request(app).get("/api/admin/tenants?tenant=default");
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "tenant_provisioning_requires_platform_owner_admin");
  cleanup();
});

test("platform admin can list tenants for provisioning", async () => {
  const { app, cleanup } = buildApp({ role: "admin" });
  const r = await request(app).get("/api/admin/tenants?tenant=default");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.tenants));
  cleanup();
});

test("client portal: GET /api/client/config has no tenantId field", async () => {
  const { app, cleanup } = buildApp();
  const r = await request(app).get("/api/client/config?tenant=default");
  assert.equal(r.status, 200);
  assert.equal(r.body.tenantId, undefined);
  assert.ok(typeof r.body.name === "string");
  cleanup();
});

test("client portal: launch items expose only customer-safe fields", async () => {
  const { app, cleanup } = buildApp();
  const pr = await request(app).get("/api/client/pilot-readiness?tenant=default");
  assert.equal(pr.status, 200);
  const items = pr.body.launch && Array.isArray(pr.body.launch.items) ? pr.body.launch.items : [];
  const allowed = new Set(["label", "message", "status", "group"]);
  for (const it of items) {
    for (const k of Object.keys(it)) {
      assert.ok(allowed.has(k), "unexpected field: " + k);
    }
  }
  cleanup();
});

test("client portal: analyst membership cannot PATCH branding", async () => {
  const ctx = buildApp();
  ctx.state.memberships[0].role = "analyst";
  const { app, cleanup } = ctx;
  const r = await request(app).patch("/api/client/branding?tenant=default").send({ brandColor: "#111111" });
  assert.equal(r.status, 403);
  cleanup();
});

test("client portal: operator membership can PATCH branding", async () => {
  const ctx = buildApp();
  ctx.state.memberships[0].role = "operator";
  const { app, cleanup } = ctx;
  const r = await request(app).patch("/api/client/branding?tenant=default").send({ brandColor: "#222222" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  cleanup();
});
