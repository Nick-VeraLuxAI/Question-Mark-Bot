// server.js
const express = require('express');
const fsp = require("fs").promises;
const path = require('path');
const { randomUUID, randomBytes, createHash } = require('crypto');
const OpenAI = require('openai');
const { google } = require('googleapis');
const cookieParser = require('cookie-parser');

const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { encrypt, hasKey } = require('./utils/kms');
const { materializeTenantSecrets } = require("./utils/tenantSecrets");
const { platformSSOMiddleware } = require('./middleware/platformSSO');
const { requirePermission } = require("./middleware/rbac");
const { applyGuardrails } = require("./utils/guardrails");
const { writeAudit } = require("./utils/audit");
const { createDistributedRateLimiter } = require("./utils/rateLimit");
const { loadConversationMemory, updateConversationSummary } = require("./services/memory");
const { retrieveContext } = require("./services/rag");
const { evaluateMetricAlerts } = require("./services/alerts");
const { chooseModel, enforceMonthlyCap } = require("./utils/modelPolicy");
const { loadPromptBundle } = require("./utils/promptManager");
const { scoreLead } = require("./utils/leadScoring");
const { enqueue, closeAllQueues } = require("./utils/jobQueue");
const { quitRedisClients } = require("./utils/redis");
const { validateProductionBoot } = require("./utils/bootValidate");
const { sendGenericWebhook } = require("./utils/webhook");
const {
  EventType,
  SCHEMA_VERSION: INTEGRATION_SCHEMA_VERSION,
  listEventTypes,
} = require("./integrations/domain");
const { emitIntegrationEvent } = require("./services/outboundEvents");
const { enqueueLeadNotificationEmail } = require("./services/leadEmailQueue");
const { createRequireTenantApiKey } = require("./middleware/tenantApiKey");
const { normalizeInbound, listAdapters } = require("./integrations/adapters");
const PROMPTS_DIR = process.env.PROMPTS_DIR || "prompts/tenants";
const DEFAULT_TENANT = (process.env.DEFAULT_TENANT || "default").toLowerCase();
const HOT = process.env.HOT_RELOAD_PROMPTS === "1";
const cache = new Map(); // key=abs path -> contents

// ---------- Tenant resolver (SSO → header → query → subdomain → DEFAULT_TENANT) ----------
function resolveTenantSlug(req) {
  const sanitize = s => String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");

  // Platform SSO override (set by platformSSOMiddleware)
  if (req.tenantSlugOverride) return sanitize(req.tenantSlugOverride);

  const fromHeader = sanitize(req.headers["x-tenant"]);
  if (fromHeader) return fromHeader;

  const fromQuery = sanitize(req.query.tenant);
  if (fromQuery) return fromQuery;

  const host = String(req.hostname || "").toLowerCase();
  const sub = host.split(".")[0];
  if (sub && !["www", "localhost", "127.0.0.1", "::1", "admin"].includes(sub)) {
    return sanitize(sub);
  }

  return (process.env.DEFAULT_TENANT || "default").toLowerCase();
}

function normalizeEmbedTheme(v) {
  const x = String(v || "").toLowerCase();
  return x === "light" || x === "dark" ? x : "auto";
}

const BRANDING_COLUMNS = [
  "brandColor",
  "brandHover",
  "botBg",
  "botText",
  "userBg",
  "userText",
  "glassBg",
  "glassTop",
  "blurPx",
  "headerGlow",
  "watermarkUrl",
  "fontFamily",
];

/** Strip XSS-y patterns; keep values short enough for CSS / URLs. */
function clipCssishToken(value, maxLen = 600) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = String(value).trim().slice(0, maxLen);
  if (!t) return null;
  if (/javascript:/i.test(t) || /<\/script/i.test(t) || /data:text\/html/i.test(t)) return null;
  return t;
}

async function readFileCached(p) {
  if (!HOT && cache.has(p)) return cache.get(p);
  try {
    const txt = await fsp.readFile(p, "utf8");
    if (!HOT) cache.set(p, txt);
    return txt;
  } catch { return ""; }
}

async function loadPrompts(tenant) {
  const base = path.join(__dirname, PROMPTS_DIR, tenant);
  const baseDefault = path.join(__dirname, PROMPTS_DIR, DEFAULT_TENANT);

  // Prefer tenant file; fall back to default
  const [systemTenant, systemDefault] = await Promise.all([
    readFileCached(path.join(base, "systemprompt.md")),
    readFileCached(path.join(baseDefault, "systemprompt.md"))
  ]);
  const [policyTenant, policyDefault] = await Promise.all([
    readFileCached(path.join(base, "policy.md")),
    readFileCached(path.join(baseDefault, "policy.md"))
  ]);
  const [voiceTenant, voiceDefault] = await Promise.all([
    readFileCached(path.join(base, "voice.md")),
    readFileCached(path.join(baseDefault, "voice.md"))
  ]);

  return {
    system: systemTenant || systemDefault || "",
    policy: policyTenant || policyDefault || "",
    voice:  voiceTenant  || voiceDefault  || ""
  };
}



// Admin logging helpers
const {
  logEvent,
  logError,
  logUsage,
  logMetric,
  logConversation,
  logLead,
  logLatency,
  logSuccess
} = require('./adminClient');


const { calculateCost } = require('./pricing');
const helmet = require('helmet');
const { csrfProtectionForMutations, issueCsrfToken } = require('./middleware/csrfApi');
const { buildAdminPageCsp, EMBED_PAGE_CSP } = require('./utils/csp');

const app = express();
const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const CORS_ORIGINS = new Set(
  String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
app.disable("x-powered-by"); // hide Express header
app.set("trust proxy", 1);   // needed on Render/Railway/Heroku for correct IP/proto

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // Framing is governed per-page by CSP frame-ancestors (embed: *; admin: none).
    xFrameOptions: false,
    hsts: COOKIE_SECURE
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false,
  })
);

app.use(cors({
  origin(origin, callback) {
    // Non-browser/server-to-server traffic often has no Origin header.
    if (!origin) return callback(null, true);

    // In production, require explicit allowlist configuration.
    if (CORS_ORIGINS.size === 0) {
      return process.env.NODE_ENV === 'production'
        ? callback(new Error('CORS origin not allowed'))
        : callback(null, true);
    }

    return CORS_ORIGINS.has(origin)
      ? callback(null, true)
      : callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant', 'X-CSRF-Token'],
  maxAge: 600,
}));
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

async function serveAdminPage(_req, res, next) {
  try {
    const nonce = randomBytes(16).toString("base64url");
    const tpl = await fsp.readFile(path.join(__dirname, "templates", "admin.html"), "utf8");
    res.setHeader("Content-Security-Policy", buildAdminPageCsp(nonce));
    res.type("html").send(tpl.replace(/__CSP_NONCE__/g, nonce));
  } catch (e) {
    next(e);
  }
}
// Browsers / links often use trailing slash; only "/admin" matched before, so "/admin/" 404'd.
app.get("/admin", serveAdminPage);
app.get("/admin/", serveAdminPage);

app.use(express.static(path.join(__dirname, 'public')));

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Platform SSO — verify platform JWTs and map to local tenant
app.use(platformSSOMiddleware(prisma));
app.use(csrfProtectionForMutations);

const messageLimiter = createDistributedRateLimiter({
  windowMs: Number(process.env.MESSAGE_RATE_WINDOW_MS || 60_000),
  max: Number(process.env.MESSAGE_RATE_MAX || 30),
  keyPrefix: 'message',
  resolveTenant: resolveTenantSlug,
});

const authLimiter = createDistributedRateLimiter({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 60_000),
  max: Number(process.env.AUTH_RATE_MAX || 20),
  keyPrefix: 'auth',
  resolveTenant: resolveTenantSlug,
});

const publicEmbedLimiter = createDistributedRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.PUBLIC_EMBED_RATE_MAX || 120),
  keyPrefix: "embedcfg",
  resolveTenant: resolveTenantSlug,
});

// ---------- DB-first prompts loader with fallback to DEFAULT + files ----------
async function loadPromptsDBFirst(req) {
  // 1) This tenant's DB prompts
  const p = (req.tenant?.prompts) || {};
  let out = {
    system: p.system || '',
    policy: p.policy || '',
    voice:  p.voice  || ''
  };

  // 2) Fill gaps from DEFAULT tenant's DB prompts
  const thisIdLower = (req.tenant?.id || '').toLowerCase();
  if ((!out.system || !out.policy || !out.voice) && thisIdLower !== DEFAULT_TENANT) {
    const def = await prisma.tenant.findFirst({
      where: { OR: [{ id: DEFAULT_TENANT }, { subdomain: DEFAULT_TENANT }] },
      select: { prompts: true }
    });
    const d = (def?.prompts) || {};
    out.system ||= d.system || '';
    out.policy ||= d.policy || '';
    out.voice  ||= d.voice  || '';
  }

  // 3) Still missing? Fall back to filesystem (legacy)
  if (!out.system || !out.policy || !out.voice) {
    const files = await loadPrompts(req.tenant?.subdomain || DEFAULT_TENANT);
    out.system ||= files.system || '';
    out.policy ||= files.policy || '';
    out.voice  ||= files.voice  || '';
  }

  return out;
}


function ensureSid(req, res) {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = randomUUID();
    res.cookie('sid', sid, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24 * 30,
      path: '/',
    });
  }
  return sid;
}

// ---------- /message middleware: resolve tenant, ensure real tenantId, persist messages ----------
app.use(async (req, res, next) => {
  if (req.method !== 'POST' || req.path !== '/message') return next();

  try {
    const tenantSlug = resolveTenantSlug(req);

    // Look up tenant by subdomain OR id, else fall back to DEFAULT_TENANT
    const tenantSelect = {
      id: true, name: true, subdomain: true,
      plan: true, settings: true,
      apiKeyHash: true, apiKeyLast4: true, apiKeyRotatedAt: true,
      openaiKey: true,
      smtpHost: true, smtpPort: true, smtpUser: true, smtpPass: true,
      emailFrom: true, emailTo: true,
      brandColor: true, brandHover: true, botBg: true, botText: true,
      userBg: true, userText: true, glassBg: true, glassTop: true, blurPx: true,
      headerGlow: true, watermarkUrl: true, fontFamily: true,
      googleClientId: true, googleClientSecret: true, googleRedirectUri: true, googleTokens: true,
      prompts: true  
    };

    let tenantRow = await prisma.tenant.findFirst({
      where: { OR: [{ subdomain: tenantSlug }, { id: tenantSlug }] },
      select: tenantSelect
    });

    if (!tenantRow && tenantSlug !== DEFAULT_TENANT) {
      tenantRow = await prisma.tenant.findFirst({
        where: { OR: [{ subdomain: DEFAULT_TENANT }, { id: DEFAULT_TENANT }] },
        select: tenantSelect
      });
    }

    if (!tenantRow) {
      console.warn("tenant_not_found", { tenantSlug });
      return res.status(404).json({ error: "tenant_not_found", tenant: tenantSlug });
    }

    
    // Attach decrypted/materialized tenant to req
    const tenantRowDec = materializeTenantSecrets(tenantRow);
    req.tenant = tenantRowDec;
    req.tenantId = tenantRowDec.id;

    req.sessionId = ensureSid(req, res);

    // Capture user text (if missing, still allow route handler to decide)
    const userTextRaw = (req.body?.message || req.body?.content || req.body?.text || req.body?.prompt || "").toString().trim();
    const guarded = applyGuardrails(userTextRaw, { redactForLogs: true });
    const userText = guarded.safeMessage;
    req.guardrails = guarded;

    // Upsert conversation & save user turn if we have text
    const convo = await prisma.conversation.upsert({
      where: { tenantId_sessionId: { tenantId: req.tenantId, sessionId: req.sessionId } },
      update: {},
      create: { tenantId: req.tenantId, sessionId: req.sessionId }
    });

    if (userText) {
      await prisma.message.create({ data: { conversationId: convo.id, role: "user", content: userText } });
    }

    // Hook res.json to capture assistant reply automatically
    const origJson = res.json.bind(res);
    res.json = async (body) => {
      try {
        const replyText = (body && (body.reply || body.message || body.content || body.text))?.toString();
        if (replyText) {
          await prisma.message.create({ data: { conversationId: convo.id, role: "assistant", content: replyText } });
        }
      } catch (e) {
        console.error("post-reply save failed", e);
      }
      return origJson(body);
    };

    next();
  } catch (e) {
    console.error("tenant middleware failed", e);
    next(); // don't block the bot if logging fails
  }
});


// Put this near resolveTenantSlug():
async function loadTenant(req, res, next) {
  try {
    const tenantSlug = resolveTenantSlug(req);
    const tenantRow = await prisma.tenant.findFirst({
      where: {
        OR: [
          { subdomain: tenantSlug },
          { id: tenantSlug },
          { name: { equals: tenantSlug, mode: 'insensitive' } }
        ]
      }
    });
    if (!tenantRow) return res.status(404).send('Tenant not found');
    const dec = materializeTenantSecrets(tenantRow);
    req.tenant = dec;
    req.tenantId = dec.id;
    next();
  } catch (e) {
    console.error('loadTenant failed:', e);
    res.status(500).send('Tenant lookup failed');
  }
}

const requireTenantApiKey = createRequireTenantApiKey({
  prisma,
  materializeTenantSecrets,
  resolveTenantSlug,
});

function requirePlatformAuth(req, res, next) {
  if (!req.platformUser) {
    return res.status(401).json({ error: 'Platform authentication required' });
  }
  next();
}

// --- Simple fuzzy tagger (no extra AI call) ---
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function similar(a, b) {
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}
async function getTagDict(tenantId) {
  const tagDict = await prisma.tagDictionary.findMany({
    where: { tenantId },
  });

  const dict = {};
  for (const entry of tagDict) {
    dict[entry.category] = entry.keywords;
  }
  return dict;
}


async function extractTags(message, tenantId) {
  const TAG_DICT = await getTagDict(tenantId); // fetch from DB per tenant

  const safeMessage = String(message || '').slice(0, 2000);
  const text = normalize(safeMessage);
  if (!text) return [];
  const tokens = text.split(" ").filter(Boolean).slice(0, 220);
  const contains = (needle) => text.includes(normalize(needle));
  const tokenFuzzyHas = (kw) => {
    const k = normalize(kw).slice(0, 64);
    if (!k) return false;
    if (k.includes(" ")) return contains(k);
    for (const t of tokens) {
      if (t.length > 40) continue;
      if (t === k) return true;
      if (t.length >= 4 && similar(t, k) >= 0.84) return true;
    }
    return false;
  };

  const tags = new Set();
  for (const [tag, kws] of Object.entries(TAG_DICT)) {
    const keywords = Array.isArray(kws) ? kws : [];
    if (keywords.some(tokenFuzzyHas)) tags.add(tag);
  }

  if (tags.has("budget") && (tags.has("flooring") || /floor/.test(text))) {
    tags.add("flooring");
  }

  return Array.from(tags);
}

// ----------------- Main chat endpoint -----------------
app.post('/message', messageLimiter, async (req, res) => {
  const { message, source } = req.body;
  const rawText = (message ?? req.body?.content ?? req.body?.text ?? req.body?.prompt ?? '').toString();
  const guardrails = req.guardrails || applyGuardrails(rawText, { redactForLogs: true });
  const text = guardrails.safeMessage;
  const { tenant, tenantId, sessionId } = req; // ✅ provided by middleware

  console.log("📨 Received message:", text);
  if (source) console.log("📍 Source:", source);

  if (guardrails.injectionDetected && process.env.BLOCK_PROMPT_INJECTION === "1") {
    await logEvent("guardrails", "Prompt injection pattern detected", tenantId);
    return res.status(400).json({ reply: "Please rephrase your request without system override instructions." });
  }

  // ✅ Logging now uses tenantId (PII redacted log payload)
  await logEvent("user", guardrails.messageForLogs, tenantId);


  // -------- Lead capture detection --------
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/);
  const phoneMatch = text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const nameRegex = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/;
  const nameLikely = nameRegex.test(text);

  console.log('leadCheck', { source, nameLikely, email: !!emailMatch, phone: !!phoneMatch });

  const explicitContact = source === "contact";
  const hasLeadContactData = !!(emailMatch && phoneMatch);
  if (explicitContact && !hasLeadContactData) {
    return res.json({
      reply: "Please include both your email and phone number so our team can follow up."
    });
  }

  if (explicitContact || (hasLeadContactData && nameLikely)) {
    const nameMatch = text.match(nameRegex);
    const name = nameMatch ? nameMatch[0] : "N/A";
    const email = emailMatch?.[0] || "";
    const phone = phoneMatch?.[0] || "";

    const tags = await extractTags(text, tenantId);
    const scored = scoreLead({
      message: text,
      source,
      hasEmail: Boolean(email),
      hasPhone: Boolean(phone),
      tags,
    });
    console.log('leadTags', tags);

    // Log to admin + DB
    let leadRecord = null;
    try {
      await logLead({ name, email, phone, snippet: text, tags }, tenantId);
      leadRecord = await prisma.lead.findFirst({
        where: { tenantId, email, phone },
        orderBy: { createdAt: "desc" },
      });
      if (leadRecord) {
        await prisma.lead.update({
          where: { id: leadRecord.id },
          data: {
            score: scored.score,
            status: scored.status,
            source: source || null,
            scoredAt: new Date(),
          },
        });
      }
    } catch (e) {
      console.error("Failed to log lead to admin:", e.message);
    }

    await emitIntegrationEvent(
      prisma,
      tenantId,
      EventType.LEAD_CREATED,
      {
        lead: {
          name,
          email,
          phone,
          tags,
          score: scored.score,
          status: scored.status,
          snippet: text,
        },
      },
      {
        tenantId,
        name,
        email,
        phone,
        tags,
        score: scored.score,
        status: scored.status,
        snippet: text,
      }
    );

    const emailOutcome = await enqueueLeadNotificationEmail(prisma, {
      tenantId,
      leadId: leadRecord?.id,
      payload: {
        name,
        email,
        phone,
        tags,
        text,
        score: scored.score,
        status: scored.status,
      },
    });

    if (emailOutcome.skipped) {
      let line;
      if (emailOutcome.reason === "already_sent") {
        line = `Lead captured; notification email already sent for this lead: ${name}`;
      } else if (emailOutcome.reason === "smtp_not_configured") {
        line = `Lead captured; notification email not sent (configure SMTP): ${name}`;
      } else {
        line = `Lead captured; notification email skipped (${emailOutcome.reason || "unknown"}): ${name}`;
      }
      await logEvent("server", line, tenantId).catch(() => {});
    } else if (!emailOutcome.queued && emailOutcome.sync) {
      const s = emailOutcome.sync;
      if (s.skipped) {
        await logEvent("server", `Lead captured; email skipped (${s.reason})`, tenantId).catch(() => {});
      } else if (s.ok) {
        console.log("Lead notification email sent (sync fallback):", s.response);
        await Promise.all([
          logSuccess(tenantId),
          logEvent("server", `Captured new lead: ${name}, ${email}, ${phone}`, tenantId),
          logEvent("ai", "AI replied with: consultation confirmation", tenantId),
        ]).catch(() => {});
      } else {
        console.error("Lead notification email failed (sync fallback):", s.error);
        await logError("Email", `Lead email failed (sync): ${s.error}`, tenantId);
      }
    }

    return res.json({
      reply: "Thanks, I've submitted your information to our team! We'll reach out shortly to schedule your consultation."
    });
  }

  // -------- Normal AI response flow --------
  try {
    console.log("🧠 Sending to OpenAI:", message);

    // Always load prompts (tenant OR default), then overlay versioned prompt variants.
    const basePrompts = await loadPromptsDBFirst(req);
    const { system, policy, voice } = await loadPromptBundle(prisma, tenantId, basePrompts);
    const systemPrompt = system || "You are Solomon, the professional AI assistant.";
    const memory = await loadConversationMemory(prisma, tenantId, sessionId, { limit: 8 });
    const ragSnippets = await retrieveContext(prisma, tenantId, text, 4);
    const chosenModel = chooseModel(tenant, text);
    const spendCap = Number(tenant?.settings?.costCapUsd || process.env.DEFAULT_MONTHLY_CAP_USD || 0);
    const cap = await enforceMonthlyCap(prisma, tenantId, spendCap);
    if (!cap.ok) {
      await logError("Billing", `Monthly cap exceeded (${cap.spent}/${spendCap})`, tenantId);
      return res.status(402).json({ reply: "This tenant has reached the monthly AI budget cap." });
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...(policy ? [{ role: "system", content: `Tenant Policy (${tenant?.name || tenantId}):\n${policy}` }] : []),
      ...(voice  ? [{ role: "system", content: `Voice & Style Guide (${tenant?.name || tenantId}):\n${voice}` }] : []),
      ...(memory.summary ? [{ role: "system", content: `Conversation Summary:\n${memory.summary}` }] : []),
      ...memory.messages.slice(-8),
      ...(ragSnippets.length
        ? [{
            role: "system",
            content: `Knowledge Context:\n${ragSnippets
              .map((x) => `- ${x.documentTitle}${x.sourceUrl ? ` (${x.sourceUrl})` : ""}: ${x.content}`)
              .join("\n")}`,
          }]
        : []),
      { role: "user", content: text }
    ];

    const openai = new OpenAI({ apiKey: tenant?.openaiKey || process.env.OPENAI_API_KEY });

    const start = Date.now();
    const aiResponse = await openai.chat.completions.create({
      model: chosenModel,
      messages
    });
    const latency = Date.now() - start;
    await logMetric("latency", latency, tenantId);
    await evaluateMetricAlerts(prisma, tenantId, "latency");
    await logSuccess(tenantId);

    // ✅ Normalize model & map tokens to camelCase for DB
    const modelKey = (aiResponse.model || "gpt-4o-mini").toLowerCase();
    const usage = aiResponse.usage || {};
    const promptTokens     = usage.prompt_tokens     ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const cachedTokens     = usage.cached_tokens     ?? 0;

    // ✅ Price with your new pricing.js
    const costs = calculateCost(modelKey, promptTokens, completionTokens, cachedTokens);

    // ✅ Persist usage in the shape your Prisma schema expects
    await logUsage({
      model: modelKey,
      promptTokens,
      completionTokens,
      cachedTokens,
      cost: costs.total,
      breakdown: costs
    }, tenantId);

    const reply =
      aiResponse.choices?.[0]?.message?.content ||
      "✅ Solomon received your message but didn’t return a clear reply. Please try rephrasing.";

    await logEvent("ai", reply, tenantId);
    await logConversation(sessionId, {
      userMessage: text,
      aiReply: reply,
      tokens: { promptTokens, completionTokens, cachedTokens },
      cost: costs.total
    }, tenantId);
    await updateConversationSummary(prisma, tenantId, sessionId, text, reply);

    res.json({ reply });

  } catch (err) {
    console.error("❌ OpenAI Error:", err.message);
    const category = err.message.includes("ENOTFOUND") ? "Network"
                    : err.message.includes("OpenAI")    ? "OpenAI"
                    : err.message.includes("SMTP")      ? "Email" : "Server";
    await logError(category, err.message, tenantId);
    res.status(500).json({ reply: "⚠️ Sorry, Solomon had trouble processing your request. Please try again shortly." });
  }
});

// ----------------- Google Drive OAuth -----------------
function getOAuthClient(tenant) {
  if (!tenant?.googleClientId || !tenant?.googleClientSecret || !tenant?.googleRedirectUri) {
    throw new Error("Google OAuth not configured for tenant");
  }

  return new google.auth.OAuth2(
    tenant.googleClientId,
    tenant.googleClientSecret,
    tenant.googleRedirectUri
  );
}

// --- Begin per-tenant Google OAuth routes ---
app.get('/auth', authLimiter, requirePlatformAuth, requirePermission("config:read"), loadTenant, async (req, res) => {
  try {
    const { tenant } = req; // now defined
    const oauth2Client = getOAuthClient(tenant);
    const state = randomBytes(24).toString('hex');
    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'Lax',
      maxAge: 10 * 60 * 1000,
      path: '/',
    });
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.file'],
      redirect_uri: tenant.googleRedirectUri,
      state
    });
    await writeAudit(prisma, req, {
      action: "oauth.start",
      resource: "google_oauth",
      outcome: "ok",
      details: { tenantId: req.tenantId },
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error("❌ OAuth Auth Error:", err.message);
    res.status(500).send("OAuth initialization failed");
  }
});

app.get('/api/oauth2callback', authLimiter, requirePlatformAuth, requirePermission("config:read"), loadTenant, async (req, res) => {
  try {
    const code = req.query.code;
    const state = String(req.query.state || '');
    const stateCookie = String(req.cookies?.oauth_state || '');
    if (!state || !stateCookie || state !== stateCookie) {
      return res.status(401).send("OAuth state verification failed");
    }
    res.clearCookie('oauth_state', {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'Lax',
      path: '/',
    });

    const { tenant, tenantId } = req; // now defined
    const oauth2Client = getOAuthClient(tenant);
    const { tokens } = await oauth2Client.getToken(code);

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { googleTokens: encrypt(JSON.stringify(tokens)) }
    });


    oauth2Client.setCredentials(tokens);
    await writeAudit(prisma, req, {
      action: "oauth.callback",
      resource: "google_oauth",
      outcome: "ok",
      details: { tenantId },
    });
    res.send("✅ Authorization successful! You may close this window.");
  } catch (err) {
    console.error("❌ Error retrieving access token:", err.message);
    res.status(500).send("Failed to authorize. Please try again.");
  }
});



// ---- Platform Integration API ----

// CSRF token for browser sessions using platform_token cookie (SOC 2 / OWASP)
app.get(
  "/api/security/csrf-token",
  requirePlatformAuth,
  requirePermission("config:read"),
  (req, res) => issueCsrfToken(req, res)
);

// Health check (used by platform to verify Solomon is reachable)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', product: 'solomon', version: '1.0.0' });
});

app.get('/api/ready', async (_req, res) => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db_timeout')), 2_000)),
    ]);
    res.json({ status: 'ready', product: 'solomon' });
  } catch (err) {
    console.error('readiness check failed:', err.message);
    res.status(503).json({ status: 'not_ready', reason: 'database_unreachable' });
  }
});

// Public embed hints (theme); rate-limited. No secrets.
app.get("/api/public/embed-config", publicEmbedLimiter, async (req, res) => {
  try {
    const slug = resolveTenantSlug(req);
    let tenant = await prisma.tenant.findFirst({
      where: { OR: [{ subdomain: slug }, { id: slug }] },
      select: { id: true, settings: true },
    });
    if (!tenant && slug !== DEFAULT_TENANT) {
      tenant = await prisma.tenant.findFirst({
        where: { OR: [{ subdomain: DEFAULT_TENANT }, { id: DEFAULT_TENANT }] },
        select: { id: true, settings: true },
      });
    }
    const settings =
      tenant?.settings && typeof tenant.settings === "object" ? tenant.settings : {};
    const appearance = settings.appearance && typeof settings.appearance === "object" ? settings.appearance : {};
    const theme = normalizeEmbedTheme(appearance.theme);
    res.set("Cache-Control", "public, max-age=60");
    res.json({ tenantId: tenant?.id ?? null, theme });
  } catch (e) {
    console.error("embed-config", e);
    res.status(500).json({ error: "embed_config_failed" });
  }
});

// GET /api/config — tenant config for portal (requires platform SSO)
app.get('/api/config', requirePlatformAuth, requirePermission("config:read"), loadTenant, async (req, res) => {
  if (!req.platformUser) {
    return res.status(401).json({ error: 'Platform authentication required' });
  }

  const t = req.tenant;
  if (!t) return res.status(404).json({ error: 'Tenant not found' });

  await writeAudit(prisma, req, {
    action: "config.read",
    resource: "tenant_config",
    outcome: "ok",
    details: { tenantId: t.id },
  });

  res.json({
    tenantId: t.id,
    name: t.name,
    subdomain: t.subdomain,
    hasOpenAIKey: !!t.openaiKey,
    hasSmtpConfig: !!(t.smtpHost && t.smtpUser),
    hasGoogleOAuth: !!t.googleClientId,
    branding: {
      brandColor: t.brandColor,
      brandHover: t.brandHover,
      fontFamily: t.fontFamily,
      watermarkUrl: t.watermarkUrl,
    },
  });
});

// GET /api/stats — aggregate stats for portal dashboard (requires platform SSO)
app.get('/api/stats', requirePlatformAuth, requirePermission("stats:read"), loadTenant, async (req, res) => {
  const tenantId = req.tenantId;
  try {
    const [conversations, leads, messages, recentUsage] = await Promise.all([
      prisma.conversation.count({ where: { tenantId } }),
      prisma.lead.count({ where: { tenantId } }),
      prisma.message.count({
        where: { conversation: { tenantId } },
      }),
      prisma.usage.aggregate({
        where: {
          tenantId,
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        _sum: { promptTokens: true, completionTokens: true, cost: true },
        _count: true,
      }),
    ]);

    await writeAudit(prisma, req, {
      action: "stats.read",
      resource: "tenant_stats",
      outcome: "ok",
      details: { tenantId },
    });
    res.json({
      conversations,
      leads,
      messages,
      usage30d: {
        requests: recentUsage._count,
        promptTokens: recentUsage._sum.promptTokens ?? 0,
        completionTokens: recentUsage._sum.completionTokens ?? 0,
        cost: recentUsage._sum.cost ?? 0,
      },
    });
  } catch (err) {
    console.error('Stats fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.post('/api/keys/rotate', authLimiter, requirePlatformAuth, requirePermission("config:write"), loadTenant, async (req, res) => {
  const tenantId = req.tenantId;
  try {
    const clearKey = `qmb_${randomBytes(24).toString("hex")}`;
    const hash = createHash("sha256").update(clearKey).digest("hex");
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        apiKeyHash: hash,
        apiKeyLast4: clearKey.slice(-4),
        apiKeyRotatedAt: new Date(),
      },
    });
    await writeAudit(prisma, req, {
      action: "apikey.rotate",
      resource: "tenant_apikey",
      outcome: "ok",
      details: { tenantId },
    });
    res.json({ apiKey: clearKey, rotatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("API key rotate failed", err);
    await writeAudit(prisma, req, {
      action: "apikey.rotate",
      resource: "tenant_apikey",
      outcome: "error",
      details: { message: err.message, tenantId },
    });
    res.status(500).json({ error: "api_key_rotate_failed" });
  }
});

function assertAllowedWebhookUrl(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint).trim());
  } catch {
    return { error: "invalid_endpoint" };
  }
  const host = url.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !isLocal) {
    return { error: "https_required" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "invalid_endpoint" };
  }
  return { ok: true };
}

// Canonical event types for outbound webhook filters (dashboard + API clients)
app.get("/api/integrations/webhooks/meta", requirePlatformAuth, requirePermission("config:read"), (_req, res) => {
  res.json({ schemaVersion: INTEGRATION_SCHEMA_VERSION, eventTypes: listEventTypes() });
});

app.get("/api/integrations/webhooks", requirePlatformAuth, requirePermission("config:read"), loadTenant, async (req, res) => {
  const rows = await prisma.leadWebhook.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      endpoint: true,
      enabled: true,
      events: true,
      createdAt: true,
    },
  });
  res.json({ webhooks: rows });
});

app.post("/api/integrations/webhooks", authLimiter, requirePlatformAuth, requirePermission("config:write"), loadTenant, async (req, res) => {
  try {
    const body = req.body || {};
    const endpoint = String(body.endpoint || "").trim();
    if (!endpoint) return res.status(400).json({ error: "endpoint_required" });
    const chk = assertAllowedWebhookUrl(endpoint);
    if (chk.error) return res.status(400).json({ error: chk.error });

    const enabled = body.enabled !== false;
    const events = Array.isArray(body.events)
      ? body.events.filter((e) => typeof e === "string").map((e) => e.slice(0, 128)).slice(0, 32)
      : [];
    const secret =
      body.secret === undefined || body.secret === null || body.secret === ""
        ? null
        : String(body.secret).slice(0, 512);

    const row = await prisma.leadWebhook.create({
      data: {
        tenantId: req.tenantId,
        endpoint: endpoint.slice(0, 2048),
        secret,
        enabled,
        events,
      },
      select: { id: true, endpoint: true, enabled: true, events: true, createdAt: true },
    });

    await writeAudit(prisma, req, {
      action: "webhook.create",
      resource: "lead_webhook",
      resourceId: row.id,
      outcome: "ok",
    });
    res.status(201).json({ webhook: row });
  } catch (err) {
    console.error("webhook create failed", err);
    res.status(500).json({ error: "webhook_create_failed" });
  }
});

app.patch("/api/integrations/webhooks/:id", authLimiter, requirePlatformAuth, requirePermission("config:write"), loadTenant, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.leadWebhook.findFirst({
      where: { id, tenantId: req.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "not_found" });

    const body = req.body || {};
    const data = {};
    if (typeof body.endpoint === "string") {
      const ep = body.endpoint.trim();
      const chk = assertAllowedWebhookUrl(ep);
      if (chk.error) return res.status(400).json({ error: chk.error });
      data.endpoint = ep.slice(0, 2048);
    }
    if (typeof body.enabled === "boolean") data.enabled = body.enabled;
    if (Array.isArray(body.events)) {
      data.events = body.events.filter((e) => typeof e === "string").map((e) => e.slice(0, 128)).slice(0, 32);
    }
    if (body.secret === null) data.secret = null;
    else if (typeof body.secret === "string" && body.secret.length > 0) {
      data.secret = String(body.secret).slice(0, 512);
    }

    const row = await prisma.leadWebhook.update({
      where: { id },
      data,
      select: { id: true, endpoint: true, enabled: true, events: true, createdAt: true },
    });

    await writeAudit(prisma, req, {
      action: "webhook.update",
      resource: "lead_webhook",
      resourceId: id,
      outcome: "ok",
    });
    res.json({ webhook: row });
  } catch (err) {
    console.error("webhook update failed", err);
    res.status(500).json({ error: "webhook_update_failed" });
  }
});

app.delete("/api/integrations/webhooks/:id", authLimiter, requirePlatformAuth, requirePermission("config:write"), loadTenant, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.leadWebhook.findFirst({
      where: { id, tenantId: req.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "not_found" });

    await prisma.leadWebhook.delete({ where: { id } });
    await writeAudit(prisma, req, {
      action: "webhook.delete",
      resource: "lead_webhook",
      resourceId: id,
      outcome: "ok",
    });
    res.status(204).end();
  } catch (err) {
    console.error("webhook delete failed", err);
    res.status(500).json({ error: "webhook_delete_failed" });
  }
});

app.get(
  "/api/integrations/branding",
  requirePlatformAuth,
  requirePermission("config:read"),
  loadTenant,
  async (req, res) => {
    try {
      const t = req.tenant;
      if (!t) return res.status(404).json({ error: "tenant_not_found" });
      const branding = t.branding && typeof t.branding === "object" ? t.branding : {};
      const settings = t.settings && typeof t.settings === "object" ? t.settings : {};
      await writeAudit(prisma, req, {
        action: "branding.read",
        resource: "tenant_branding",
        outcome: "ok",
        details: { tenantId: t.id },
      });
      res.json({
        tenantId: t.id,
        brandColor: t.brandColor,
        brandHover: t.brandHover,
        botBg: t.botBg,
        botText: t.botText,
        userBg: t.userBg,
        userText: t.userText,
        glassBg: t.glassBg,
        glassTop: t.glassTop,
        blurPx: t.blurPx,
        headerGlow: t.headerGlow,
        watermarkUrl: t.watermarkUrl,
        fontFamily: t.fontFamily,
        branding,
        appearance: (() => {
          const app =
            settings.appearance && typeof settings.appearance === "object" ? settings.appearance : {};
          return { ...app, theme: normalizeEmbedTheme(app.theme) };
        })(),
      });
    } catch (err) {
      console.error("branding read failed", err);
      res.status(500).json({ error: "branding_read_failed" });
    }
  }
);

app.patch(
  "/api/integrations/branding",
  authLimiter,
  requirePlatformAuth,
  requirePermission("config:write"),
  loadTenant,
  async (req, res) => {
    try {
      const t = req.tenant;
      if (!t) return res.status(404).json({ error: "tenant_not_found" });
      const body = req.body || {};
      const data = {};

      for (const key of BRANDING_COLUMNS) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        const raw = body[key];
        if (raw === "" || raw === null) {
          data[key] = null;
          continue;
        }
        const v = clipCssishToken(raw, key === "headerGlow" ? 1200 : 600);
        data[key] = v;
      }

      if (body.branding !== undefined && body.branding !== null && typeof body.branding === "object") {
        const cur = t.branding && typeof t.branding === "object" ? { ...t.branding } : {};
        for (const [k, v] of Object.entries(body.branding)) {
          if (typeof v === "string") cur[k] = clipCssishToken(v, 2000);
          else if (typeof v === "number" && Number.isFinite(v)) cur[k] = v;
          else if (typeof v === "boolean") cur[k] = v;
        }
        data.branding = cur;
      }

      if (body.appearance !== undefined && body.appearance !== null && typeof body.appearance === "object") {
        const curSettings = t.settings && typeof t.settings === "object" ? { ...t.settings } : {};
        const curApp =
          curSettings.appearance && typeof curSettings.appearance === "object"
            ? { ...curSettings.appearance }
            : {};
        const nextApp = { ...curApp };
        for (const [k, v] of Object.entries(body.appearance)) {
          if (k === "theme") {
            nextApp.theme = normalizeEmbedTheme(v);
          } else if (typeof v === "string") {
            nextApp[k] = clipCssishToken(v, 240);
          } else if (typeof v === "number" && Number.isFinite(v)) {
            nextApp[k] = v;
          } else if (typeof v === "boolean") {
            nextApp[k] = v;
          }
        }
        nextApp.theme = normalizeEmbedTheme(nextApp.theme);
        curSettings.appearance = nextApp;
        data.settings = curSettings;
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no_valid_fields" });
      }

      await prisma.tenant.update({ where: { id: t.id }, data });
      await writeAudit(prisma, req, {
        action: "branding.update",
        resource: "tenant_branding",
        outcome: "ok",
        details: { tenantId: t.id, fields: Object.keys(data) },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("branding update failed", err);
      res.status(500).json({ error: "branding_update_failed" });
    }
  }
);

// ---- Human handoff cockpit API ----
app.post('/api/handoff/sessions', requirePlatformAuth, requirePermission("handoff:write"), loadTenant, async (req, res) => {
  try {
    const { sessionId, reason, priority, transcript } = req.body || {};
    const row = await prisma.handoffSession.create({
      data: {
        tenantId: req.tenantId,
        sessionId: String(sessionId || req.cookies?.sid || randomUUID()),
        reason: reason ? String(reason) : null,
        priority: String(priority || "normal"),
        transcript: transcript ?? undefined,
      },
    });
    await writeAudit(prisma, req, {
      action: "handoff.create",
      resource: "handoff_session",
      resourceId: row.id,
      outcome: "ok",
    });
    res.status(201).json({ handoff: row });
  } catch (err) {
    console.error("handoff create failed", err.message);
    res.status(500).json({ error: "handoff_create_failed" });
  }
});

app.post('/api/handoff/:id/assign', requirePlatformAuth, requirePermission("handoff:write"), loadTenant, async (req, res) => {
  try {
    const row = await prisma.handoffSession.update({
      where: { id: req.params.id },
      data: {
        assignedTo: String(req.body?.assignedTo || req.platformUser?.email || "operator"),
        status: String(req.body?.status || "in_progress"),
      },
    });
    await writeAudit(prisma, req, {
      action: "handoff.assign",
      resource: "handoff_session",
      resourceId: row.id,
      outcome: "ok",
    });
    res.json({ handoff: row });
  } catch (err) {
    res.status(500).json({ error: "handoff_assign_failed" });
  }
});

// ---- Omnichannel orchestration (web-first + webhook adapters) ----
app.post('/api/channels/events', loadTenant, async (req, res) => {
  try {
    const { channel = "web", externalUserId = "", text = "", metadata = null } = req.body || {};
    if (!externalUserId) return res.status(400).json({ error: "external_user_id_required" });
    const identity = await prisma.channelIdentity.upsert({
      where: {
        tenantId_channel_externalUserId: {
          tenantId: req.tenantId,
          channel: String(channel),
          externalUserId: String(externalUserId),
        },
      },
      update: { metadata: metadata ?? undefined, lastSeenAt: new Date() },
      create: {
        tenantId: req.tenantId,
        channel: String(channel),
        externalUserId: String(externalUserId),
        sessionId: req.cookies?.sid || null,
        metadata: metadata ?? undefined,
      },
    });
    await prisma.channelMessage.create({
      data: {
        tenantId: req.tenantId,
        channel: String(channel),
        externalUserId: String(externalUserId),
        direction: "inbound",
        content: String(text || ""),
        metadata: metadata ?? undefined,
      },
    });
    res.json({ ok: true, identityId: identity.id });
  } catch (err) {
    console.error("channel event failed", err.message);
    res.status(500).json({ error: "channel_event_failed" });
  }
});

app.get('/api/channels/identities', requirePlatformAuth, requirePermission("funnel:read"), loadTenant, async (req, res) => {
  const rows = await prisma.channelIdentity.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { lastSeenAt: "desc" },
    take: Math.min(200, Number(req.query.limit || 50)),
  });
  res.json({ identities: rows });
});

// ---- Booking + quoting automation ----
app.post('/api/appointments', requirePlatformAuth, requirePermission("booking:write"), loadTenant, async (req, res) => {
  try {
    const body = req.body || {};
    const row = await prisma.appointment.create({
      data: {
        tenantId: req.tenantId,
        leadId: body.leadId ? String(body.leadId) : null,
        title: String(body.title || "Consultation"),
        startsAt: new Date(body.startsAt || Date.now()),
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        metadata: body.metadata ?? undefined,
      },
    });
    await prisma.revenueEvent.create({
      data: {
        tenantId: req.tenantId,
        leadId: row.leadId || null,
        stage: "appointment_booked",
        metadata: { appointmentId: row.id },
      },
    });
    res.status(201).json({ appointment: row });
  } catch (err) {
    res.status(500).json({ error: "appointment_create_failed" });
  }
});

app.post('/api/quotes', requirePlatformAuth, requirePermission("quote:write"), loadTenant, async (req, res) => {
  try {
    const body = req.body || {};
    const row = await prisma.quote.create({
      data: {
        tenantId: req.tenantId,
        leadId: body.leadId ? String(body.leadId) : null,
        amount: Number(body.amount || 0),
        currency: String(body.currency || "USD"),
        items: body.items ?? undefined,
        notes: body.notes ? String(body.notes) : null,
      },
    });
    await prisma.revenueEvent.create({
      data: {
        tenantId: req.tenantId,
        leadId: row.leadId || null,
        stage: "quote_sent",
        amount: row.amount,
        metadata: { quoteId: row.id },
      },
    });
    res.status(201).json({ quote: row });
  } catch (err) {
    res.status(500).json({ error: "quote_create_failed" });
  }
});

// ---- Compliance and trust APIs ----
app.post('/api/compliance/consent', loadTenant, async (req, res) => {
  try {
    const body = req.body || {};
    const row = await prisma.consentRecord.create({
      data: {
        tenantId: req.tenantId,
        subject: String(body.subject || req.cookies?.sid || "anonymous"),
        purpose: String(body.purpose || "messaging"),
        granted: Boolean(body.granted),
        source: String(body.source || "web"),
        metadata: body.metadata ?? undefined,
      },
    });
    res.status(201).json({ consent: row });
  } catch (err) {
    res.status(500).json({ error: "consent_write_failed" });
  }
});

app.get('/api/compliance/export', requirePlatformAuth, requirePermission("audit:read"), loadTenant, async (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [consents, audits] = await Promise.all([
    prisma.consentRecord.findMany({ where: { tenantId: req.tenantId, createdAt: { gte: since } } }),
    prisma.auditLog.findMany({ where: { tenantId: req.tenantId, createdAt: { gte: since } } }),
  ]);
  res.json({ tenantId: req.tenantId, since, consents, audits });
});

// ---- Revenue and conversion intelligence ----
app.get('/api/revenue/funnel', requirePlatformAuth, requirePermission("funnel:read"), loadTenant, async (req, res) => {
  const tenantId = req.tenantId;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [leads, booked, quoted, won] = await Promise.all([
    prisma.lead.count({ where: { tenantId, createdAt: { gte: since } } }),
    prisma.revenueEvent.count({ where: { tenantId, stage: "appointment_booked", createdAt: { gte: since } } }),
    prisma.revenueEvent.count({ where: { tenantId, stage: "quote_sent", createdAt: { gte: since } } }),
    prisma.revenueEvent.aggregate({
      where: { tenantId, stage: "deal_won", createdAt: { gte: since } },
      _count: true,
      _sum: { amount: true },
    }),
  ]);
  res.json({
    period: "30d",
    leads,
    appointments: booked,
    quotes: quoted,
    wins: won._count,
    wonRevenue: Number(won._sum.amount || 0),
  });
});

// ---- Optimization loop (prompt/model variants to revenue outcomes) ----
app.post('/api/optimize/record', requirePlatformAuth, requirePermission("optimize:write"), loadTenant, async (req, res) => {
  try {
    const { experimentKey, variant, impressions = 0, conversions = 0, revenue = 0 } = req.body || {};
    if (!experimentKey || !variant) return res.status(400).json({ error: "experiment_key_and_variant_required" });
    const row = await prisma.optimizationRun.upsert({
      where: {
        tenantId_experimentKey_variant: {
          tenantId: req.tenantId,
          experimentKey: String(experimentKey),
          variant: String(variant),
        },
      },
      update: {
        impressions: { increment: Number(impressions || 0) },
        conversions: { increment: Number(conversions || 0) },
        revenue: { increment: Number(revenue || 0) },
      },
      create: {
        tenantId: req.tenantId,
        experimentKey: String(experimentKey),
        variant: String(variant),
        impressions: Number(impressions || 0),
        conversions: Number(conversions || 0),
        revenue: Number(revenue || 0),
      },
    });
    res.json({ optimization: row });
  } catch (err) {
    res.status(500).json({ error: "optimization_record_failed" });
  }
});

app.get('/api/optimize/recommendation', requirePlatformAuth, requirePermission("optimize:read"), loadTenant, async (req, res) => {
  const experimentKey = String(req.query.experimentKey || "default");
  const runs = await prisma.optimizationRun.findMany({
    where: { tenantId: req.tenantId, experimentKey },
  });
  if (!runs.length) return res.json({ recommendation: null, reason: "no_data" });
  const scored = runs.map((r) => ({
    variant: r.variant,
    cv: r.impressions > 0 ? r.conversions / r.impressions : 0,
    rev: r.revenue,
  }));
  scored.sort((a, b) => (b.cv + b.rev / 1000) - (a.cv + a.rev / 1000));
  res.json({ recommendation: scored[0], candidates: scored });
});

// ---- Re-engagement campaigns ----
app.post('/api/reengagement/campaigns', requirePlatformAuth, requirePermission("campaign:write"), loadTenant, async (req, res) => {
  try {
    const body = req.body || {};
    const row = await prisma.reengagementCampaign.create({
      data: {
        tenantId: req.tenantId,
        name: String(body.name || "Untitled Campaign"),
        channel: String(body.channel || "webhook"),
        criteria: body.criteria ?? undefined,
        template: String(body.template || "Hi {{name}}, just checking in."),
        status: "scheduled",
        launchedAt: new Date(),
      },
    });

    const { dispatched } = await emitIntegrationEvent(prisma, req.tenantId, EventType.CAMPAIGN_LAUNCHED, {
      campaign: {
        id: row.id,
        name: row.name,
        template: row.template,
        channel: row.channel,
      },
    });

    res.status(201).json({ campaign: row, dispatchedWebhooks: dispatched });
  } catch (err) {
    res.status(500).json({ error: "campaign_create_failed" });
  }
});

// ---- Competitor-aware benchmarking ----
app.post('/api/benchmarks/run', requirePlatformAuth, requirePermission("benchmark:write"), loadTenant, async (req, res) => {
  try {
    const body = req.body || {};
    const baseline = body.baseline ?? {};
    const candidate = body.candidate ?? {};
    const score = Number(candidate.conversionRate || 0) - Number(baseline.conversionRate || 0);
    const row = await prisma.benchmarkRun.create({
      data: {
        tenantId: req.tenantId,
        name: String(body.name || "Benchmark"),
        baseline,
        candidate,
        score,
        winner: score >= 0 ? "candidate" : "baseline",
      },
    });
    res.status(201).json({ benchmark: row });
  } catch (err) {
    res.status(500).json({ error: "benchmark_run_failed" });
  }
});

app.get('/api/benchmarks', requirePlatformAuth, requirePermission("benchmark:read"), loadTenant, async (req, res) => {
  const rows = await prisma.benchmarkRun.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(req.query.limit || 20), 100),
  });
  res.json({ benchmarks: rows });
});

// ---- Self-serve onboarding wizard APIs ----
app.post('/api/onboarding/start', requirePlatformAuth, requirePermission("onboarding:write"), loadTenant, async (req, res) => {
  const checklist = {
    branding: false,
    prompts: false,
    channels: false,
    compliance: false,
    launch: false,
  };
  const row = await prisma.onboardingSession.create({
    data: {
      tenantId: req.tenantId,
      checklist,
      progress: 0,
      status: "started",
    },
  });
  res.status(201).json({ onboarding: row });
});

app.post('/api/onboarding/:id/step', requirePlatformAuth, requirePermission("onboarding:write"), loadTenant, async (req, res) => {
  const step = String(req.body?.step || "");
  const row = await prisma.onboardingSession.findUnique({ where: { id: req.params.id } });
  if (!row || row.tenantId !== req.tenantId) return res.status(404).json({ error: "onboarding_not_found" });
  const checklist = { ...(row.checklist || {}) };
  if (step && step in checklist) checklist[step] = true;
  const total = Object.keys(checklist).length || 1;
  const done = Object.values(checklist).filter(Boolean).length;
  const progress = Math.round((done / total) * 100);
  const updated = await prisma.onboardingSession.update({
    where: { id: row.id },
    data: {
      checklist,
      progress,
      status: progress >= 100 ? "completed" : "started",
      completedAt: progress >= 100 ? new Date() : null,
    },
  });
  res.json({ onboarding: updated });
});

// ---- Integration layer (canonical events + inbound adapters) ----
app.get("/api/integrations/v1/adapters", requireTenantApiKey, (req, res) => {
  const settings = req.tenant?.settings || {};
  const all = listAdapters();
  const allowed = settings?.integrations?.enabledProviders;
  const enabled =
    Array.isArray(allowed) && allowed.length ? all.filter((a) => allowed.includes(a)) : all;
  res.json({
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    eventTypes: listEventTypes(),
    adapters: all,
    enabledForTenant: enabled,
    webhookEventsHint:
      "LeadWebhook.events: omit or [] = all events; [\"*\"] = explicit wildcard; else list eventTypes to filter.",
  });
});

app.post("/api/integrations/v1/inbound/:provider", requireTenantApiKey, async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const settings = req.tenant?.settings || {};
  const out = normalizeInbound(provider, req.body || {}, settings);
  if (out.error === "unknown_provider") {
    return res.status(404).json({ error: out.error, adapters: out.known });
  }
  if (out.error === "provider_disabled") {
    return res.status(403).json({ error: out.error, provider: out.provider });
  }
  if (out.error) {
    return res.status(400).json({ error: out.error, message: out.message });
  }

  const record = {
    provider: out.provider,
    sessionId: req.body?.sessionId ?? null,
    type: out.type,
    payload: out.payload,
    receivedAt: new Date().toISOString(),
  };

  await prisma.event.create({
    data: {
      tenantId: req.tenantId,
      type: `integration.inbound.${out.type}`,
      content: JSON.stringify(record),
    },
  });

  res.status(202).json({
    ok: true,
    accepted: { type: out.type, provider: out.provider },
  });
});

// ---- Generic webhook adapter for external CRM/booking stacks ----
app.post('/api/integrations/webhook-test', requirePlatformAuth, requirePermission("config:write"), loadTenant, async (req, res) => {
  const { endpoint, payload = {}, secret = "" } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint_required" });
  try {
    const out = await sendGenericWebhook(String(endpoint), { tenantId: req.tenantId, ...payload }, String(secret || ""));
    res.json({ ok: out.ok, status: out.status });
  } catch (err) {
    res.status(502).json({ error: "webhook_failed", message: err.message });
  }
});

// ---- SSO Callback (Platform portal → Solomon) ----
app.get('/sso/callback', authLimiter, async (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).send('Missing SSO token');
  }

  try {
    const { verifyPlatformToken } = require('./middleware/platformSSO');
    const result = await verifyPlatformToken(token);

    if (!result.valid || !result.tenant) {
      return res.status(401).send('Invalid or expired SSO token');
    }

    // Set the platform token as a cookie so subsequent requests are authenticated
    res.cookie('platform_token', token, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: process.env.PLATFORM_COOKIE_SAMESITE || 'Strict',
      maxAge: 4 * 60 * 1000, // 4 minutes (token is 5 min, gives buffer)
      path: '/',
    });

    // Redirect to the main app with the tenant context
    const slug = result.tenant?.slug || '';
    await writeAudit(prisma, req, {
      actorType: "platform_user",
      actorId: String(result.user?.id || ""),
      action: "sso.callback",
      resource: "platform_token",
      outcome: "ok",
      details: { slug },
    });
    res.redirect(`/?tenant=${encodeURIComponent(slug)}`);
  } catch (err) {
    console.error('[SSO callback] Error:', err);
    res.status(500).send('SSO authentication failed');
  }
});

// ----------------- Static pages -----------------
app.get('/', async (_req, res, next) => {
  try {
    const html = await fsp.readFile(path.join(__dirname, "templates", "chat.html"), "utf8");
    res.setHeader("Content-Security-Policy", EMBED_PAGE_CSP);
    res.type("html").send(html);
  } catch (e) {
    next(e);
  }
});

app.get('/login', (req, res) => {
  res.redirect('/');
});

// ---------- /env.css (tenant-aware; neutral → earth defaults) ----------
const esc = {
  str: (v='') => String(v).replace(/["\\]/g, m => ({'"':'\\"','\\':'\\\\'}[m])),
  url: (v='') => String(v).replace(/[")\\]/g, m => ({')':'%29','"':'%22','\\':'%5C'}[m])),
};

const asLen = (v) => {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return `${v}px`;
  const s = String(v).trim();
  // allow px, %, vw, vh, rem, em; otherwise treat as px number
  return /^-?\d+(\.\d+)?(px|%|vw|vh|rem|em)$/.test(s)
    ? s
    : `${parseFloat(s) || 0}px`;
};

const asOpacity = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
};


function toCssVars(t = {}) {
  const defaults = {
    font: "'Segoe UI', system-ui, sans-serif",
    brand:      '#6B705C',
    brandHover: '#556052',
    glassBg:    'rgba(250,248,244,0.88)',
    glassTop:   'rgba(250,248,244,0.78)',
    blur:       '10px',
    botBg:      '#F4F1EA',
    botText:    '#2C2C2C',
    userBg:     '#8A7B68',
    userText:   '#FFFFFF',
    borderColor:'#D9D6CE',
    headerGlow: 'radial-gradient(50% 50% at 50% 50%, rgba(107,112,92,0.35) 0%, rgba(107,112,92,0) 70%)',

    // 🔽 sensible defaults for watermark
    watermarkUrl: 'none',
    watermarkOpacity: '0.18',
    watermarkW: '500px',
    watermarkH: '500px',
    watermarkSize: 'contain'
  };

  const fromTenant = {
    brand: t.brandColor || t.branding?.brand,
    brandHover: t.brandHover || t.branding?.brandHover,
    glassBg: t.glassBg,
    glassTop: t.glassTop,
    blur: t.blurPx,
    botBg: t.botBg,
    botText: t.botText,
    userBg: t.userBg,
    userText: t.userText,
    headerGlow: t.headerGlow,
    font: t.fontFamily,

    // 🔽 new: pick from branding JSON; fall back to defaults above
    watermarkUrl: t.watermarkUrl ? `url("${esc.url(t.watermarkUrl)}")` : undefined,
    watermarkOpacity: asOpacity(t.branding?.watermarkOpacity),
    watermarkW: asLen(t.branding?.watermarkW),
    watermarkH: asLen(t.branding?.watermarkH),
    watermarkSize: t.branding?.watermarkSize
  };

  return {
    ...defaults,
    ...Object.fromEntries(Object.entries(fromTenant).filter(([, v]) => v != null && v !== ''))
  };
}


app.get('/env.css', async (req, res) => {
  try {
    const hint = resolveTenantSlug(req);

    let tenant = await prisma.tenant.findFirst({
      where: { OR: [{ subdomain: hint }, { id: hint }] }
    });

    if (!tenant && hint !== DEFAULT_TENANT) {
      tenant = await prisma.tenant.findFirst({
        where: { OR: [{ subdomain: DEFAULT_TENANT }, { id: DEFAULT_TENANT }] }
      });
    }

    const vars = toCssVars(tenant || {});
    const css = `:root{` + Object.entries(vars).map(([k,v]) => `--${k}:${v};`).join(' ') + `}`;

    res.set('Content-Type', 'text/css; charset=utf-8');
    res.set('Cache-Control', 'no-store'); // always fresh branding
    return res.send(css);
  } catch (e) {
    console.error('env.css error', e);
    res.set('Content-Type', 'text/css; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    return res.send(`:root{--brand:#6B705C;--brandHover:#556052;--glassBg:rgba(250,248,244,0.88);--glassTop:rgba(250,248,244,0.78);--blur:10px;--botBg:#F4F1EA;--botText:#2C2C2C;--userBg:#8A7B68;--userText:#FFFFFF;--borderColor:#D9D6CE;--headerGlow:radial-gradient(50% 50% at 50% 50%, rgba(107,112,92,0.35) 0%, rgba(107,112,92,0) 70%);--watermarkUrl:none;--font:'Segoe UI', system-ui, sans-serif;}`);
  }
});

if (process.env.ENABLE_HEARTBEAT === '1') {
  const TENANT = process.env.DEFAULT_TENANT || 'default';
  setInterval(() => {
    logSuccess(TENANT).catch(() => {});
  }, 5 * 60 * 1000); // every 5 minutes
}


// ----------------- Server startup -----------------
const PORT = process.env.PORT || 8080;
if (require.main === module) {
  validateProductionBoot();
  const server = app.listen(PORT, () => {
    console.log(`✅ Solomon backend running on port ${PORT}`);
  });

  async function shutdown(signal) {
    console.log(`${signal}: shutting down…`);
    await new Promise((resolve) => server.close(() => resolve()));
    await closeAllQueues().catch(() => {});
    await quitRedisClients().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = { app };

