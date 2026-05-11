// server.js
const express = require('express');
const fsp = require("fs").promises;
const path = require('path');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('crypto');
const OpenAI = require('openai');
const { google } = require('googleapis');
const cookieParser = require('cookie-parser');

const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { encrypt, hasKey } = require('./utils/kms');
const { materializeTenantSecrets } = require("./utils/tenantSecrets");
const { platformSSOMiddleware } = require('./middleware/platformSSO');
const { requirePermission, resolveRole, resolveTenantScopedRole, hasPermission } = require("./middleware/rbac");
const { createClientPortalMiddleware } = require("./middleware/clientPortal");
const { attachClientPortalRoutes } = require("./routes/clientPortalApi");
const { applyGuardrails } = require("./utils/guardrails");
const { writeAudit } = require("./utils/audit");
const { createDistributedRateLimiter } = require("./utils/rateLimit");
const { loadConversationMemory, updateConversationSummary } = require("./services/memory");
const { retrieveContext } = require("./services/rag");
const { evaluateMetricAlerts } = require("./services/alerts");
const { chooseModel, enforceMonthlyCap } = require("./utils/modelPolicy");
const { loadPromptBundle } = require("./utils/promptManager");
const {
  getBehaviorForGet,
  mergeBehaviorIncoming,
  validateAndNormalizeBehaviorPatch,
  buildBehaviorInstruction,
} = require("./utils/botBehavior");
const {
  getBusinessProfileForGet,
  mergeBusinessProfileIncoming,
  validateAndNormalizeBusinessProfilePatch,
  buildBusinessProfileInstruction,
} = require("./utils/businessProfile");
const { computePilotReadiness } = require("./utils/pilotReadiness");
const { scoreLead } = require("./utils/leadScoring");
const { enqueue, closeAllQueues } = require("./utils/jobQueue");
const { quitRedisClients, pingRedisForReadiness } = require("./utils/redis");
const {
  validateProductionBoot,
  logProductionBootWarnings,
  logRuntimeModeHint,
} = require("./utils/bootValidate");
const { buildPublicEmbedCopy } = require("./utils/embedCopy");
const { sendGenericWebhook } = require("./utils/webhook");
const {
  EventType,
  SCHEMA_VERSION: INTEGRATION_SCHEMA_VERSION,
  listEventTypes,
  buildEnvelope,
  webhookSubscribesToEvent,
} = require("./integrations/domain");
const { emitIntegrationEvent } = require("./services/outboundEvents");
const { enqueueLeadNotificationEmail } = require("./services/leadEmailQueue");
const {
  provisionTenant,
  listTenantsForAdmin,
  verifyTenantForAdmin,
  bootstrapPromptsForTenant,
  rotateTenantIntegrationKey,
} = require("./services/tenantProvisioning");
const { createRequireTenantApiKey } = require("./middleware/tenantApiKey");
const { normalizeInbound, listAdapters } = require("./integrations/adapters");
const PROMPTS_DIR = process.env.PROMPTS_DIR || "prompts/tenants";
const DEFAULT_TENANT = (process.env.DEFAULT_TENANT || "default").toLowerCase();
const HOT = process.env.HOT_RELOAD_PROMPTS === "1";
const cache = new Map(); // key=abs path -> contents

/** Production: unknown slug must not map to default tenant unless explicitly allowed. Dev/test: defaults on. */
function allowPublicDefaultTenantFallback() {
  if (process.env.NODE_ENV !== "production") return true;
  return String(process.env.ALLOW_PUBLIC_DEFAULT_TENANT_FALLBACK || "").trim() === "1";
}

/** Compare header value to env secret without leaking length via timingSafeEqual on SHA-256 digests. */
function secretHeaderMatches(headerVal, envSecret) {
  const h = String(headerVal || "").trim();
  const s = String(envSecret || "").trim();
  if (!s) return false;
  const hh = createHash("sha256").update(h, "utf8").digest();
  const sh = createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(hh, sh);
}

/**
 * Shared-secret gate for server-to-server style public routes.
 * - Production without configured secret → 503 (fail closed).
 * - Secret configured → require matching header (401 on miss).
 * - Non-production without secret → allow (local dev); optional ALLOW_UNAUTH_*=1 is redundant but documented.
 */
function requireEnvSecretOrFailClosed({ req, res, envName, headerName, notConfiguredError, invalidError }) {
  const isProd = process.env.NODE_ENV === "production";
  const secret = String(process.env[envName] || "").trim();
  if (isProd && !secret) {
    res.status(503).json({ error: notConfiguredError });
    return false;
  }
  if (secret) {
    const hdr = req.headers[headerName] ?? req.headers[String(headerName).toLowerCase()];
    if (!secretHeaderMatches(hdr, secret)) {
      res.status(401).json({ error: invalidError });
      return false;
    }
  }
  return true;
}

/** Non-secret deployment hints for admin APIs and readiness (operator UX). */
function getAdminServerHints() {
  return {
    globalOpenaiConfigured: Boolean(String(process.env.OPENAI_API_KEY || "").trim()),
    openaiBootOptional: process.env.OPENAI_BOOT_OPTIONAL === "1",
    nodeEnv: process.env.NODE_ENV || "",
  };
}

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
const { buildAdminPageCsp, buildEmbedPageCsp } = require("./utils/csp");
const { requestCorrelationMiddleware } = require("./middleware/requestCorrelation");

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
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Tenant",
    "X-CSRF-Token",
    "X-Request-Id",
    "X-Channel-Events-Secret",
    "X-Consent-Write-Secret",
  ],
  maxAge: 600,
}));
/** Default JSON cap; knowledge mutators need a larger body (see selector below). */
const jsonBodyDefault = express.json({ limit: "16kb" });
const jsonBodyAdminKnowledge = express.json({ limit: "1mb" });
function jsonBodySelector(req, res, next) {
  const p = req.path || "";
  if (
    (req.method === "POST" &&
      (p === "/api/admin/knowledge" ||
        p === "/api/admin/knowledge/" ||
        p === "/api/client/knowledge" ||
        p === "/api/client/knowledge/")) ||
    (req.method === "PATCH" && /^\/api\/(admin|client)\/knowledge\/[^/]+$/.test(p))
  ) {
    return jsonBodyAdminKnowledge(req, res, next);
  }
  return jsonBodyDefault(req, res, next);
}
app.use(jsonBodySelector);
app.use(cookieParser());
app.use(requestCorrelationMiddleware);

function createServeAdminPage(portalMode) {
  return async function serveAdminPage(_req, res, next) {
    try {
      const nonce = randomBytes(16).toString("base64url");
      let tpl = await fsp.readFile(path.join(__dirname, "templates", "admin.html"), "utf8");
      const hideDev =
        process.env.NODE_ENV === "production" && process.env.ALLOW_ADMIN_BEARER_DEV_TOOLS !== "1";
      const devAttrs = hideDev ? 'hidden style="display:none !important" aria-hidden="true"' : "";
      tpl = tpl.replace(/__DEV_SECTION_ATTRS__/g, devAttrs);
      const portalClass =
        portalMode === "client" ? "admin-simple admin-portal-client" : "admin-simple admin-portal-operator";
      tpl = tpl.replace(/__PORTAL_BODY_CLASS__/g, portalClass);
      tpl = tpl.replace(/__PORTAL_DATA__/g, portalMode);
      res.setHeader("Content-Security-Policy", buildAdminPageCsp(nonce));
      res.type("html").send(tpl.replace(/__CSP_NONCE__/g, nonce));
    } catch (e) {
      next(e);
    }
  };
}
// Operator (internal) vs client dashboards — same SPA, different portal mode and API prefixes.
app.get("/admin", createServeAdminPage("operator"));
app.get("/admin/", createServeAdminPage("operator"));
app.get("/admin/operator", createServeAdminPage("operator"));
app.get("/admin/operator/", createServeAdminPage("operator"));
app.get("/admin/client", createServeAdminPage("client"));
app.get("/admin/client/", createServeAdminPage("client"));

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

    if (!tenantRow && allowPublicDefaultTenantFallback() && tenantSlug !== DEFAULT_TENANT) {
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

const {
  loadClientTenant,
  assertTenantAccess,
  requireClientPermission,
  platformOperatorCapable,
  normalizeRole: normalizeMembershipRole,
  assertOperatorTenantPermission,
} = createClientPortalMiddleware({ prisma, materializeTenantSecrets, resolveTenantSlug });

function requirePlatformAuth(req, res, next) {
  if (!req.platformUser) {
    return res.status(401).json({ error: 'Platform authentication required' });
  }
  next();
}

/** Tenant provisioning / global control-plane: platform owner or admin only. */
function requireTenantProvisioningPlatformRole(req, res, next) {
  const r = normalizeMembershipRole(req.platformUser?.role);
  if (r !== "owner" && r !== "admin") {
    return res.status(403).json({
      error: "forbidden",
      code: "tenant_provisioning_requires_platform_owner_admin",
      message: "Tenant provisioning is restricted to platform owner or admin accounts.",
    });
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

    const businessProfileInstruction = buildBusinessProfileInstruction(req.tenant);
    const behaviorInstruction = buildBehaviorInstruction(req.tenant);
    const messages = [
      { role: "system", content: systemPrompt },
      ...(policy ? [{ role: "system", content: `Tenant Policy (${tenant?.name || tenantId}):\n${policy}` }] : []),
      ...(voice  ? [{ role: "system", content: `Voice & Style Guide (${tenant?.name || tenantId}):\n${voice}` }] : []),
      ...(businessProfileInstruction ? [{ role: "system", content: businessProfileInstruction }] : []),
      ...(behaviorInstruction ? [{ role: "system", content: behaviorInstruction }] : []),
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
app.get(
  "/auth",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
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
    res.cookie("oauth_tenant", String(req.tenantId || ""), {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "Lax",
      maxAge: 10 * 60 * 1000,
      path: "/",
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

app.get(
  "/api/oauth2callback",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
  try {
    const code = req.query.code;
    const state = String(req.query.state || '');
    const stateCookie = String(req.cookies?.oauth_state || '');
    const tenantCookie = String(req.cookies?.oauth_tenant || "");
    if (!state || !stateCookie || state !== stateCookie) {
      return res.status(401).send("OAuth state verification failed");
    }
    if (!tenantCookie || tenantCookie !== String(req.tenantId || "")) {
      return res.status(403).send("OAuth tenant binding mismatch");
    }
    res.clearCookie('oauth_state', {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'Lax',
      path: '/',
    });
    res.clearCookie("oauth_tenant", {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "Lax",
      path: "/",
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

/** Safe session snapshot for operator admin UI (no tokens or secrets). */
app.get("/api/admin/me", requirePlatformAuth, async (req, res) => {
  try {
    const u = req.platformUser || {};
    const t = req.platformTenant || {};
    const userId = u.id != null ? String(u.id) : "";
    const platformRole = normalizeMembershipRole(u.role);
    const canUseOperatorPortal =
      Boolean(platformOperatorCapable(platformRole)) || hasPermission(platformRole, "tenants:provision");

    const memberships = await prisma.tenantMembership.findMany({
      where: { userId, status: "active" },
      include: { tenant: { select: { id: true, name: true, subdomain: true } } },
      orderBy: { createdAt: "asc" },
    });

    const allowedTenants = memberships.map((m) => ({
      slug: m.tenant.subdomain || m.tenant.id,
      displayName: m.tenant.name,
      role: m.role,
      status: m.status,
    }));

    let currentTenant = null;
    let membership = null;
    if (memberships.length === 1) {
      const m = memberships[0];
      currentTenant = {
        slug: m.tenant.subdomain || m.tenant.id,
        displayName: m.tenant.name,
        status: m.status,
      };
      membership = { role: m.role, status: m.status };
    }

    res.json({
      signedIn: true,
      id: userId || null,
      email: u.email != null ? String(u.email) : null,
      role: platformRole,
      platformTenantSlug: t.slug != null ? String(t.slug) : null,
      platformTenantName: t.name != null ? String(t.name) : null,
      user: {
        id: userId || null,
        email: u.email != null ? String(u.email) : null,
        platformRole,
      },
      portalMode: "operator",
      currentTenant,
      membership,
      allowedTenants,
      canUseOperatorPortal,
    });
  } catch (e) {
    console.error("admin me", e);
    res.status(500).json({ error: "admin_me_failed" });
  }
});

// Health check (used by platform to verify Solomon is reachable)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', product: 'solomon', version: '1.0.0' });
});

app.get('/api/ready', async (_req, res) => {
  const strict = process.env.NODE_ENV === 'production';
  const checks = { database: 'unknown', redis: 'unknown', defaultTenant: 'unknown', strictTenantBinding: 'unknown' };

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db_timeout')), 2_000)),
    ]);
    checks.database = 'ok';
  } catch (err) {
    console.error('readiness check failed (database):', err.message);
    checks.database = 'fail';
    return res.status(503).json({ status: 'not_ready', reason: 'database_unreachable', checks });
  }

  if (strict) {
    const redisCheck = await pingRedisForReadiness(2000);
    if (!redisCheck.ok) {
      checks.redis = 'fail';
      console.error('readiness check failed (redis):', redisCheck.reason);
      return res.status(503).json({
        status: 'not_ready',
        reason: redisCheck.reason || 'redis_unreachable',
        checks,
      });
    }
    checks.redis = 'ok';

    const platformUrlConfigured = Boolean(String(process.env.PLATFORM_URL || "").trim());
    if (platformUrlConfigured && process.env.STRICT_TENANT_BINDING !== "1") {
      checks.strictTenantBinding = "missing";
      return res.status(503).json({
        status: "not_ready",
        reason: "strict_tenant_binding_required",
        checks,
        hints: [
          {
            code: "strict_tenant_binding",
            severity: "error",
            message:
              "PLATFORM_URL is set but STRICT_TENANT_BINDING is not 1. Set STRICT_TENANT_BINDING=1 for shared-admin or multi-client deployments.",
          },
        ],
      });
    }
    checks.strictTenantBinding = platformUrlConfigured ? "ok" : "skipped_no_platform_url";

    const slug = (process.env.DEFAULT_TENANT || 'default').toLowerCase();
    const tenantRow = await prisma.tenant.findFirst({
      where: { OR: [{ id: slug }, { subdomain: slug }] },
      select: { id: true },
    });
    if (!tenantRow) {
      checks.defaultTenant = 'missing';
      return res.status(503).json({
        status: 'not_ready',
        reason: 'bootstrap_tenant_missing',
        checks,
      });
    }
    checks.defaultTenant = 'ok';
  } else {
    checks.redis = 'skipped_non_production';
    checks.defaultTenant = 'skipped_non_production';
    const platformUrlConfigured = Boolean(String(process.env.PLATFORM_URL || "").trim());
    checks.strictTenantBinding =
      platformUrlConfigured && process.env.STRICT_TENANT_BINDING !== "1" ? "recommended" : "skipped_non_production";
  }

  /** Operator hints: app can be "ready" while some tenants lack chat keys. */
  const hints = [];
  try {
    const globalOpenai = Boolean(String(process.env.OPENAI_API_KEY || "").trim());
    const optional = process.env.OPENAI_BOOT_OPTIONAL === "1";
    if (!globalOpenai && !optional) {
      const n = await prisma.tenant.count({
        where: {
          OR: [{ openaiKey: null }, { openaiKey: "" }],
        },
      });
      if (n > 0) {
        hints.push({
          code: "tenants_without_openai_fallback",
          severity: "warn",
          message: `${n} tenant(s) have no per-tenant OpenAI key while the server has no OPENAI_API_KEY. Chat fails for those tenants until you set OPENAI_API_KEY, add per-tenant keys, or use OPENAI_BOOT_OPTIONAL=1 with every tenant keyed.`,
        });
      }
    }
  } catch (e) {
    console.warn("readiness hints query skipped:", e.message);
  }

  if (!strict && checks.strictTenantBinding === "recommended") {
    hints.push({
      code: "strict_tenant_binding",
      severity: "warn",
      message:
        "PLATFORM_URL is set but STRICT_TENANT_BINDING is not 1. Use STRICT_TENANT_BINDING=1 in production for shared-admin or multi-client deployments.",
    });
  }

  res.json({
    status: 'ready',
    product: 'solomon',
    version: '1.0.0',
    checks,
    hints,
  });
});

// Public embed hints (theme); rate-limited. No secrets.
app.get("/api/public/embed-config", publicEmbedLimiter, async (req, res) => {
  try {
    const slug = resolveTenantSlug(req);
    let tenant = await prisma.tenant.findFirst({
      where: { OR: [{ subdomain: slug }, { id: slug }] },
      select: { id: true, name: true, subdomain: true, settings: true },
    });
    if (!tenant && allowPublicDefaultTenantFallback() && slug !== DEFAULT_TENANT) {
      tenant = await prisma.tenant.findFirst({
        where: { OR: [{ subdomain: DEFAULT_TENANT }, { id: DEFAULT_TENANT }] },
        select: { id: true, name: true, subdomain: true, settings: true },
      });
    }
    if (!tenant) {
      return res.status(404).json({ error: "tenant_not_found", tenant: slug });
    }
    const settings =
      tenant?.settings && typeof tenant.settings === "object" ? tenant.settings : {};
    const appearance = settings.appearance && typeof settings.appearance === "object" ? settings.appearance : {};
    const theme = normalizeEmbedTheme(appearance.theme);
    const copy = buildPublicEmbedCopy({
      uiProfileEnv: process.env.UI_PROFILE,
      publicProductLabelEnv: process.env.PUBLIC_PRODUCT_LABEL,
      tenant,
    });
    res.set("Cache-Control", "public, max-age=60");
    const tenantSlugPublic = tenant.subdomain || tenant.id || "";
    res.json({
      tenantSlug: tenantSlugPublic,
      theme,
      ...copy,
    });
  } catch (e) {
    console.error("embed-config", e);
    res.status(500).json({ error: "embed_config_failed" });
  }
});

// GET /api/config — tenant config for portal (requires platform SSO)
app.get('/api/config', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("config:read"), async (req, res) => {
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
app.get('/api/stats', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("stats:read"), async (req, res) => {
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

/** Admin list pagination: limit 1–100, offset ≥ 0 */
function parseAdminListPagination(req) {
  const lim = parseInt(String(req.query.limit ?? "25"), 10);
  const off = parseInt(String(req.query.offset ?? "0"), 10);
  const limit = Number.isFinite(lim) ? Math.min(100, Math.max(1, lim)) : 25;
  const offset = Number.isFinite(off) && off >= 0 ? off : 0;
  return { limit, offset };
}

function parseOptionalIsoDate(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function adminSearchText(req) {
  const q = String(req.query.q ?? "").trim();
  return q.slice(0, 200);
}

/** Keyword RAG chunks: size cap keeps rows reasonable without an embedding pipeline. */
const KNOWLEDGE_CHUNK_MAX = 2500;
const ADMIN_KNOWLEDGE_MAX_TITLE = 500;
const ADMIN_KNOWLEDGE_MAX_SOURCE = 2000;
const ADMIN_KNOWLEDGE_MAX_CONTENT = 100000;

function splitKnowledgeContent(raw) {
  const text = String(raw || "");
  if (!text.length) return [""];
  const parts = [];
  for (let i = 0; i < text.length; i += KNOWLEDGE_CHUNK_MAX) {
    parts.push(text.slice(i, i + KNOWLEDGE_CHUNK_MAX));
  }
  return parts;
}

/**
 * Tenant-scoped knowledge list for admin UI.
 * Read: config:read — same family as /api/config and branding reads (operational visibility).
 */
app.get(
  "/api/admin/knowledge",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:read"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const { limit, offset } = parseAdminListPagination(req);
    const q = adminSearchText(req);

    const where = {
      tenantId,
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { content: { contains: q, mode: "insensitive" } },
              { sourceUrl: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    try {
      const [total, rows] = await Promise.all([
        prisma.knowledgeDocument.count({ where }),
        prisma.knowledgeDocument.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            title: true,
            sourceUrl: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { chunks: true } },
            chunks: {
              orderBy: { idx: "asc" },
              take: 1,
              select: { content: true },
            },
          },
        }),
      ]);

      const items = rows.map((row) => {
        const first = row.chunks[0]?.content || "";
        const preview = first.slice(0, 220);
        return {
          id: row.id,
          title: row.title,
          source: row.sourceUrl || "",
          status: row.status,
          chunkCount: row._count.chunks,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          preview: preview + (first.length > 220 ? "…" : ""),
        };
      });

      await writeAudit(prisma, req, {
        action: "admin.knowledge.list",
        resource: "knowledge_document",
        outcome: "ok",
        details: { tenantId, limit, offset, qLen: q.length },
      });

      res.json({ items, total, limit, offset });
    } catch (err) {
      console.error("admin knowledge list", err);
      res.status(500).json({ error: "knowledge_list_failed" });
    }
  }
);

/**
 * Single knowledge document with chunks (read-only for operators).
 * config:read — see list route.
 */
app.get(
  "/api/admin/knowledge/:id",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:read"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    try {
      const doc = await prisma.knowledgeDocument.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          title: true,
          sourceUrl: true,
          status: true,
          content: true,
          createdAt: true,
          updatedAt: true,
          chunks: {
            orderBy: { idx: "asc" },
            select: { id: true, content: true, createdAt: true },
          },
        },
      });
      if (!doc) return res.status(404).json({ error: "not_found" });

      await writeAudit(prisma, req, {
        action: "admin.knowledge.read",
        resource: "knowledge_document",
        resourceId: id,
        outcome: "ok",
        details: { tenantId, chunkCount: doc.chunks.length },
      });

      res.json({
        id: doc.id,
        title: doc.title,
        source: doc.sourceUrl || "",
        status: doc.status,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        content: doc.content,
        chunks: doc.chunks,
      });
    } catch (err) {
      console.error("admin knowledge read", err);
      res.status(500).json({ error: "knowledge_read_failed" });
    }
  }
);

/**
 * Run keyword overlap retrieval (same helper as chat RAG) without calling OpenAI.
 * config:read — low-risk diagnostic for operators.
 */
app.get(
  "/api/admin/knowledge-retrieval",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:read"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const q = String(req.query.q ?? "").trim().slice(0, 500);
    if (!q) return res.status(400).json({ error: "q_required" });
    try {
      const matches = await retrieveContext(prisma, tenantId, q, 8);
      res.json({
        query: q,
        matches: matches.map((m) => ({
          documentTitle: m.documentTitle,
          source: m.sourceUrl || "",
          excerpt: (m.content || "").slice(0, 900),
        })),
      });
    } catch (err) {
      console.error("admin knowledge retrieval", err);
      res.status(500).json({ error: "knowledge_retrieval_failed" });
    }
  }
);

/**
 * Create a KnowledgeDocument and keyword-RAG chunks (no embeddings).
 * Write: config:write — same as branding and integration keys (tenant configuration).
 */
app.post(
  "/api/admin/knowledge",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const body = req.body || {};
    const title = String(body.title ?? "").trim();
    const content = String(body.content ?? "");
    const source = body.source != null ? String(body.source).trim() : "";

    if (!title) return res.status(400).json({ error: "title_required" });
    if (!content.trim()) return res.status(400).json({ error: "content_required" });
    if (title.length > ADMIN_KNOWLEDGE_MAX_TITLE) {
      return res.status(400).json({ error: "title_too_long", max: ADMIN_KNOWLEDGE_MAX_TITLE });
    }
    if (source.length > ADMIN_KNOWLEDGE_MAX_SOURCE) {
      return res.status(400).json({ error: "source_too_long", max: ADMIN_KNOWLEDGE_MAX_SOURCE });
    }
    if (content.length > ADMIN_KNOWLEDGE_MAX_CONTENT) {
      return res.status(400).json({ error: "content_too_long", max: ADMIN_KNOWLEDGE_MAX_CONTENT });
    }

    const parts = splitKnowledgeContent(content);

    try {
      const created = await prisma.$transaction(async (tx) => {
        const doc = await tx.knowledgeDocument.create({
          data: {
            tenantId,
            title,
            sourceUrl: source || null,
            content,
            status: "active",
          },
        });
        await tx.knowledgeChunk.createMany({
          data: parts.map((c, idx) => ({
            tenantId,
            documentId: doc.id,
            idx,
            content: c,
          })),
        });
        return doc;
      });

      await writeAudit(prisma, req, {
        action: "admin.knowledge.create",
        resource: "knowledge_document",
        resourceId: created.id,
        outcome: "ok",
        details: { tenantId, titleLen: title.length, chunkCount: parts.length },
      });

      res.status(201).json({
        id: created.id,
        title: created.title,
        source: created.sourceUrl || "",
        status: created.status,
        chunkCount: parts.length,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        preview: (parts[0] || "").slice(0, 220) + ((parts[0] || "").length > 220 ? "…" : ""),
      });
    } catch (err) {
      console.error("admin knowledge create", err);
      res.status(500).json({ error: "knowledge_create_failed" });
    }
  }
);

/**
 * Soft-archive or reactivate a document (affects RAG via document.status).
 * config:write — state change on tenant-managed knowledge.
 */
app.patch(
  "/api/admin/knowledge/:id",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const id = String(req.params.id || "").trim();
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const nextStatus = String(body.status ?? "").trim().toLowerCase();
    if (!id) return res.status(400).json({ error: "id_required" });
    if (!["active", "archived"].includes(nextStatus)) {
      return res.status(400).json({ error: "invalid_status", allowed: ["active", "archived"] });
    }

    try {
      const existing = await prisma.knowledgeDocument.findFirst({
        where: { id, tenantId },
        select: { id: true, status: true },
      });
      if (!existing) return res.status(404).json({ error: "not_found" });

      const upd = await prisma.knowledgeDocument.updateMany({
        where: { id, tenantId },
        data: { status: nextStatus },
      });
      if (upd.count === 0) return res.status(404).json({ error: "not_found" });

      const updated = await prisma.knowledgeDocument.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          title: true,
          sourceUrl: true,
          status: true,
          updatedAt: true,
          _count: { select: { chunks: true } },
        },
      });
      if (!updated) return res.status(404).json({ error: "not_found" });

      await writeAudit(prisma, req, {
        action: "admin.knowledge.patch",
        resource: "knowledge_document",
        resourceId: id,
        outcome: "ok",
        details: { tenantId, status: nextStatus },
      });

      res.json({
        id: updated.id,
        title: updated.title,
        source: updated.sourceUrl || "",
        status: updated.status,
        chunkCount: updated._count.chunks,
        updatedAt: updated.updatedAt,
      });
    } catch (err) {
      console.error("admin knowledge patch", err);
      res.status(500).json({ error: "knowledge_patch_failed" });
    }
  }
);

/**
 * Hard-delete a document and cascaded chunks (tenant-scoped).
 * config:write — destructive; client should confirm.
 */
app.delete(
  "/api/admin/knowledge/:id",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    try {
      /** Explicit chunk removal first (defense in depth; schema also has onDelete: Cascade). */
      const deleted = await prisma.$transaction(async (tx) => {
        const chunkDel = await tx.knowledgeChunk.deleteMany({
          where: { documentId: id, tenantId },
        });
        const docDel = await tx.knowledgeDocument.deleteMany({
          where: { id, tenantId },
        });
        return { docDel: docDel.count, chunkDel: chunkDel.count };
      });
      if (deleted.docDel === 0) return res.status(404).json({ error: "not_found" });

      await writeAudit(prisma, req, {
        action: "admin.knowledge.delete",
        resource: "knowledge_document",
        resourceId: id,
        outcome: "ok",
        details: { tenantId, chunksRemoved: deleted.chunkDel },
      });

      res.status(204).send();
    } catch (err) {
      console.error("admin knowledge delete", err);
      res.status(500).json({ error: "knowledge_delete_failed" });
    }
  }
);

/**
 * Guided bot behavior (Tenant.settings.behavior). Read: config:read.
 */
app.get(
  "/api/admin/bot-behavior",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:read"),
  async (req, res) => {
    try {
      const settings = req.tenant?.settings;
      const payload = getBehaviorForGet(settings);
      await writeAudit(prisma, req, {
        action: "admin.bot_behavior.read",
        resource: "tenant_settings",
        outcome: "ok",
        details: { tenantId: req.tenantId },
      });
      res.json(payload);
    } catch (err) {
      console.error("admin bot_behavior read", err);
      res.status(500).json({ error: "bot_behavior_read_failed" });
    }
  }
);

/**
 * Update guided bot behavior (merges into Tenant.settings; does not wipe other keys).
 * Write: config:write.
 */
app.patch(
  "/api/admin/bot-behavior",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const behaviorIn = req.body && req.body.behavior;
    const merged = mergeBehaviorIncoming(req.tenant?.settings, behaviorIn);
    const v = validateAndNormalizeBehaviorPatch(merged);
    if (!v.ok) {
      return res.status(v.status).json({ error: "validation_failed", details: v.errors });
    }

    try {
      const prevSettings = req.tenant?.settings;
      const base =
        prevSettings && typeof prevSettings === "object" && !Array.isArray(prevSettings)
          ? JSON.parse(JSON.stringify(prevSettings))
          : {};
      base.behavior = v.normalized;
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { settings: base },
      });
      await writeAudit(prisma, req, {
        action: "admin.bot_behavior.update",
        resource: "tenant_settings",
        outcome: "ok",
        details: { tenantId },
      });
      res.json(getBehaviorForGet(base));
    } catch (err) {
      console.error("admin bot_behavior update", err);
      res.status(500).json({ error: "bot_behavior_update_failed" });
    }
  }
);

/**
 * Business profile (Tenant.settings.businessProfile). Read: config:read.
 */
app.get(
  "/api/admin/business-profile",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:read"),
  async (req, res) => {
    try {
      const settings = req.tenant?.settings;
      const payload = getBusinessProfileForGet(settings);
      await writeAudit(prisma, req, {
        action: "admin.business_profile.read",
        resource: "tenant_settings",
        outcome: "ok",
        details: { tenantId: req.tenantId },
      });
      res.json(payload);
    } catch (err) {
      console.error("admin business_profile read", err);
      res.status(500).json({ error: "business_profile_read_failed" });
    }
  }
);

/**
 * Update business profile (merges into Tenant.settings; does not wipe other keys).
 * Write: config:write.
 */
app.patch(
  "/api/admin/business-profile",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const profileIn = req.body && req.body.businessProfile;
    const merged = mergeBusinessProfileIncoming(req.tenant?.settings, profileIn);
    const v = validateAndNormalizeBusinessProfilePatch(merged);
    if (!v.ok) {
      return res.status(v.status).json({ error: "validation_failed", details: v.errors });
    }

    try {
      const prevSettings = req.tenant?.settings;
      const base =
        prevSettings && typeof prevSettings === "object" && !Array.isArray(prevSettings)
          ? JSON.parse(JSON.stringify(prevSettings))
          : {};
      base.businessProfile = v.normalized;
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { settings: base },
      });
      await writeAudit(prisma, req, {
        action: "admin.business_profile.update",
        resource: "tenant_settings",
        outcome: "ok",
        details: { tenantId },
      });
      res.json(getBusinessProfileForGet(base));
    } catch (err) {
      console.error("admin business_profile update", err);
      res.status(500).json({ error: "business_profile_update_failed" });
    }
  }
);

/**
 * Pilot / launch readiness (heuristic, no secrets).
 * Auth: config:read + tenant context.
 */
app.get(
  "/api/admin/pilot-readiness",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:read"),
  async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const slug = resolveTenantSlug(req);
      const sh = getAdminServerHints();
      const verify = await verifyTenantForAdmin(prisma, slug, undefined, {
        globalOpenaiConfigured: sh.globalOpenaiConfigured,
        openaiBootOptional: sh.openaiBootOptional,
      });
      const readyForChat = verify.ok ? Boolean(verify.readyForChat) : false;

      const [activeKnowledgeCount, conversationCount, leadCount, webhookEnabledCount] = await Promise.all([
        prisma.knowledgeDocument.count({ where: { tenantId, status: "active" } }),
        prisma.conversation.count({ where: { tenantId } }),
        prisma.lead.count({ where: { tenantId } }),
        prisma.leadWebhook.count({ where: { tenantId, enabled: true } }),
      ]);

      const integrationKeyConfigured = Boolean(req.tenant?.apiKeyHash);
      const hideDev =
        process.env.NODE_ENV === "production" && process.env.ALLOW_ADMIN_BEARER_DEV_TOOLS !== "1";

      const out = computePilotReadiness({
        tenant: req.tenant,
        readyForChat,
        verify,
        activeKnowledgeCount,
        conversationCount,
        leadCount,
        webhookEnabledCount,
        integrationKeyConfigured,
        role: resolveTenantScopedRole(req),
        devToolsHiddenInProd: hideDev,
      });

      await writeAudit(prisma, req, {
        action: "admin.pilot_readiness.read",
        resource: "tenant_readiness",
        outcome: "ok",
        details: { tenantId, status: out.readiness.status, score: out.readiness.score },
      });

      res.json(out);
    } catch (err) {
      console.error("admin pilot_readiness", err);
      res.status(500).json({ error: "pilot_readiness_failed" });
    }
  }
);

/**
 * Tenant-scoped conversation list for admin UI.
 * Auth: platform SSO + funnel:read (same family as /api/revenue/funnel and channel identities).
 */
app.get(
  "/api/admin/conversations",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("funnel:read"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const { limit, offset } = parseAdminListPagination(req);
    const q = adminSearchText(req);
    const from = parseOptionalIsoDate(req.query.from);
    const to = parseOptionalIsoDate(req.query.to);

    const where = {
      tenantId,
      ...(from || to
        ? {
            startedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { summary: { contains: q, mode: "insensitive" } },
              { sessionId: { contains: q, mode: "insensitive" } },
              { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : {}),
    };

    try {
      const [total, rows] = await Promise.all([
        prisma.conversation.count({ where }),
        prisma.conversation.findMany({
          where,
          orderBy: { startedAt: "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            sessionId: true,
            startedAt: true,
            endedAt: true,
            summary: true,
            summaryUpdatedAt: true,
            _count: { select: { messages: true } },
            messages: {
              orderBy: { createdAt: "desc" },
              take: 80,
              select: { role: true, content: true, createdAt: true },
            },
          },
        }),
      ]);

      const items = rows.map((row) => {
        let lastUser = "";
        let lastAssistant = "";
        let lastAt = row.startedAt;
        for (const m of row.messages) {
          if (new Date(m.createdAt) > new Date(lastAt)) lastAt = m.createdAt;
          const role = String(m.role || "").toLowerCase();
          if (!lastUser && role === "user") lastUser = m.content || "";
          if (!lastAssistant && role === "assistant") lastAssistant = m.content || "";
          if (lastUser && lastAssistant) break;
        }
        const updatedAt = row.summaryUpdatedAt || lastAt;
        return {
          id: row.id,
          createdAt: row.startedAt,
          updatedAt,
          messageCount: row._count.messages,
          lastMessageAt: lastAt,
          lastUserMessage: lastUser.slice(0, 500),
          lastAssistantMessage: lastAssistant.slice(0, 500),
          leadCount: 0,
          channel: null,
          source: null,
        };
      });

      await writeAudit(prisma, req, {
        action: "admin.conversations.list",
        resource: "conversation",
        outcome: "ok",
        details: { tenantId, limit, offset, qLen: q.length },
      });

      res.json({ items, total, limit, offset });
    } catch (err) {
      console.error("admin conversations list", err);
      res.status(500).json({ error: "conversations_list_failed" });
    }
  }
);

/**
 * Single conversation transcript for admin UI (tenant-scoped).
 * funnel:read — see list route.
 */
app.get(
  "/api/admin/conversations/:id",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("funnel:read"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    try {
      const convo = await prisma.conversation.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          sessionId: true,
          startedAt: true,
          endedAt: true,
          summary: true,
          summaryUpdatedAt: true,
        },
      });
      if (!convo) return res.status(404).json({ error: "not_found" });

      const messages = await prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "asc" },
        take: 500,
        select: { id: true, role: true, content: true, createdAt: true },
      });

      const lastMsg = messages.length ? messages[messages.length - 1].createdAt : convo.startedAt;
      const updatedAt = convo.summaryUpdatedAt || lastMsg;

      await writeAudit(prisma, req, {
        action: "admin.conversations.read",
        resource: "conversation",
        resourceId: id,
        outcome: "ok",
        details: { tenantId, messageCount: messages.length },
      });

      res.json({
        id: convo.id,
        createdAt: convo.startedAt,
        updatedAt,
        sessionId: convo.sessionId,
        messages,
        leads: [],
      });
    } catch (err) {
      console.error("admin conversation detail", err);
      res.status(500).json({ error: "conversation_read_failed" });
    }
  }
);

/**
 * Tenant-scoped leads list for admin UI.
 * funnel:read — operational CRM-style read aligned with funnel metrics.
 */
app.get(
  "/api/admin/leads",
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("funnel:read"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const { limit, offset } = parseAdminListPagination(req);
    const q = adminSearchText(req);
    const from = parseOptionalIsoDate(req.query.from);
    const to = parseOptionalIsoDate(req.query.to);

    const where = {
      tenantId,
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
              { snippet: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    try {
      const [total, rows] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            source: true,
            status: true,
            createdAt: true,
            score: true,
          },
        }),
      ]);

      const items = rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        source: r.source,
        status: r.status,
        createdAt: r.createdAt,
        conversationId: null,
      }));

      await writeAudit(prisma, req, {
        action: "admin.leads.list",
        resource: "lead",
        outcome: "ok",
        details: { tenantId, limit, offset, qLen: q.length },
      });

      res.json({ items, total, limit, offset });
    } catch (err) {
      console.error("admin leads list", err);
      res.status(500).json({ error: "leads_list_failed" });
    }
  }
);

app.post(
  "/api/keys/rotate",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
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
        details: { tenantId, membershipRole: req.effectiveTenantRole || null, superBypass: Boolean(req.operatorTenantSuperBypass) },
      });
      res.json({ apiKey: clearKey, rotatedAt: new Date().toISOString() });
    } catch (err) {
      console.error("API key rotate failed");
      await writeAudit(prisma, req, {
        action: "apikey.rotate",
        resource: "tenant_apikey",
        outcome: "error",
        details: { tenantId, errorCode: "rotate_exception" },
      });
      res.status(500).json({ error: "api_key_rotate_failed" });
    }
  }
);

// ---- Admin tenant provisioning (platform SSO + tenants:provision) ----
app.get(
  "/api/admin/tenants",
  requirePlatformAuth,
  requirePermission("tenants:provision"),
  requireTenantProvisioningPlatformRole,
  async (_req, res) => {
    try {
      const tenants = await listTenantsForAdmin(prisma);
      res.json({ tenants, serverHints: getAdminServerHints() });
    } catch (e) {
      console.error("admin tenants list", e);
      res.status(500).json({ error: "list_failed" });
    }
  }
);

app.post(
  "/api/admin/tenants",
  authLimiter,
  requirePlatformAuth,
  requirePermission("tenants:provision"),
  requireTenantProvisioningPlatformRole,
  async (req, res) => {
    try {
      const body = req.body || {};
      const result = await provisionTenant(prisma, {
        slug: body.slug,
        name: body.name,
        plan: body.plan,
        useGlobalOpenai: Boolean(body.useGlobalOpenai),
        openaiKey: body.openaiKey,
        skipIntegrationKey: Boolean(body.skipIntegrationKey),
        force: Boolean(body.force),
        rotateIntegrationKey: Boolean(body.rotateIntegrationKey),
      });

      if (!result.ok) {
        const status =
          result.code === "validation"
            ? 400
            : result.code === "conflict"
              ? 409
              : result.code === "kms"
                ? 400
                : 500;
        return res.status(status).json({ error: result.error, code: result.code });
      }

      let bootstrap = null;
      if (body.bootstrapPrompts) {
        bootstrap = await bootstrapPromptsForTenant(prisma, result.tenantId);
      }

      await writeAudit(prisma, req, {
        tenantId: result.tenantId,
        action: "tenant.provision",
        resource: "tenant",
        resourceId: result.tenantId,
        outcome: "ok",
        details: { created: result.created, updated: result.updated },
      });

      const sh = getAdminServerHints();
      /** @type {{ code: string; severity: string; message: string }[]} */
      const hints = [];
      const useGlobalOpenai = Boolean(body.useGlobalOpenai);
      const perTenantOpenai = useGlobalOpenai
        ? ""
        : String(body.openaiKey || "").trim();
      if (useGlobalOpenai && !sh.globalOpenaiConfigured && !sh.openaiBootOptional) {
        hints.push({
          code: "global_openai_not_configured",
          severity: "warn",
          message:
            "This tenant is set to use the global OpenAI key, but OPENAI_API_KEY is not set on the server. Chat will fail until you set it or add a per-tenant OpenAI key.",
        });
      }
      if (
        !useGlobalOpenai &&
        !perTenantOpenai &&
        result.created &&
        !sh.globalOpenaiConfigured &&
        !sh.openaiBootOptional
      ) {
        hints.push({
          code: "no_openai_for_new_tenant",
          severity: "warn",
          message:
            "New tenant was created without a per-tenant OpenAI key and the server has no OPENAI_API_KEY. Chat will not work until you configure one or the other.",
        });
      }
      if (Boolean(body.skipIntegrationKey)) {
        hints.push({
          code: "integration_key_skipped",
          severity: "info",
          message:
            "Inbound integration routes (/api/integrations/v1/…) need an integration API key. Use Rotate integration key in /admin or re-provision without skip when ready.",
        });
      }

      res.json({
        ok: true,
        tenantId: result.tenantId,
        created: result.created,
        updated: result.updated,
        integrationKey: result.integrationKeyPlain || null,
        bootstrap,
        hints,
        serverHints: sh,
      });
    } catch (e) {
      console.error("admin tenants create", e);
      res.status(500).json({ error: "provision_failed", message: e.message });
    }
  }
);

app.get(
  "/api/admin/tenants/:slug/verify",
  requirePlatformAuth,
  requirePermission("tenants:provision"),
  requireTenantProvisioningPlatformRole,
  async (req, res) => {
    try {
      const sh = getAdminServerHints();
      const v = await verifyTenantForAdmin(prisma, req.params.slug, undefined, {
        globalOpenaiConfigured: sh.globalOpenaiConfigured,
        openaiBootOptional: sh.openaiBootOptional,
      });
      if (!v.ok) {
        return res.status(404).json(v);
      }
      res.json(v);
    } catch (e) {
      console.error("admin tenant verify", e);
      res.status(500).json({ error: "verify_failed" });
    }
  }
);

app.post(
  "/api/admin/tenants/:slug/bootstrap-prompts",
  authLimiter,
  requirePlatformAuth,
  requirePermission("tenants:provision"),
  requireTenantProvisioningPlatformRole,
  async (req, res) => {
    try {
      const out = await bootstrapPromptsForTenant(prisma, req.params.slug);
      if (!out.ok) {
        return res.status(404).json(out);
      }
      await writeAudit(prisma, req, {
        tenantId: out.tenantId,
        action: "tenant.bootstrap_prompts",
        resource: "tenant",
        resourceId: out.tenantId,
        outcome: "ok",
        details: { files: out.files },
      });
      res.json(out);
    } catch (e) {
      console.error("admin bootstrap prompts", e);
      res.status(500).json({ error: "bootstrap_failed" });
    }
  }
);

app.post(
  "/api/admin/tenants/:slug/rotate-integration-key",
  authLimiter,
  requirePlatformAuth,
  requirePermission("tenants:provision"),
  requireTenantProvisioningPlatformRole,
  async (req, res) => {
    try {
      const r = await rotateTenantIntegrationKey(prisma, req.params.slug);
      if (!r.ok) {
        return res.status(404).json(r);
      }
      await writeAudit(prisma, req, {
        tenantId: r.tenantId,
        action: "tenant.integration_key.rotate",
        resource: "tenant_apikey",
        resourceId: r.tenantId,
        outcome: "ok",
      });
      res.json({
        apiKey: r.apiKey,
        tenantId: r.tenantId,
        rotatedAt: new Date().toISOString(),
        message:
          "The previous integration key stops working immediately. Update X-Api-Key or Bearer in every integration client before closing this screen; the new value is shown only in this response.",
      });
    } catch (e) {
      console.error("admin rotate integration key", e);
      res.status(500).json({ error: "rotate_failed" });
    }
  }
);

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

app.get("/api/integrations/webhooks", requirePlatformAuth, loadTenant, assertOperatorTenantPermission("config:read"), async (req, res) => {
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

app.post("/api/integrations/webhooks", authLimiter, requirePlatformAuth, loadTenant, assertOperatorTenantPermission("config:write"), async (req, res) => {
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

app.patch("/api/integrations/webhooks/:id", authLimiter, requirePlatformAuth, loadTenant, assertOperatorTenantPermission("config:write"), async (req, res) => {
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

    const upd = await prisma.leadWebhook.updateMany({
      where: { id, tenantId: req.tenantId },
      data,
    });
    if (upd.count === 0) return res.status(404).json({ error: "not_found" });

    const row = await prisma.leadWebhook.findFirst({
      where: { id, tenantId: req.tenantId },
      select: { id: true, endpoint: true, enabled: true, events: true, createdAt: true },
    });
    if (!row) return res.status(404).json({ error: "not_found" });

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

app.delete("/api/integrations/webhooks/:id", authLimiter, requirePlatformAuth, loadTenant, assertOperatorTenantPermission("config:write"), async (req, res) => {
  try {
    const { id } = req.params;
    const del = await prisma.leadWebhook.deleteMany({ where: { id, tenantId: req.tenantId } });
    if (del.count === 0) return res.status(404).json({ error: "not_found" });
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
  loadTenant,
  assertOperatorTenantPermission("config:read"),
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
  loadTenant,
  assertOperatorTenantPermission("config:write"),
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
app.post('/api/handoff/sessions', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("handoff:write"), async (req, res) => {
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

app.post('/api/handoff/:id/assign', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("handoff:write"), async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });

    const existing = await prisma.handoffSession.findFirst({
      where: { id, tenantId: req.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "not_found" });

    const upd = await prisma.handoffSession.updateMany({
      where: { id, tenantId: req.tenantId },
      data: {
        assignedTo: String(req.body?.assignedTo || req.platformUser?.email || "operator"),
        status: String(req.body?.status || "in_progress"),
      },
    });
    if (upd.count === 0) return res.status(404).json({ error: "not_found" });

    const row = await prisma.handoffSession.findFirst({
      where: { id, tenantId: req.tenantId },
    });
    if (!row) return res.status(404).json({ error: "not_found" });

    await writeAudit(prisma, req, {
      action: "handoff.assign",
      resource: "handoff_session",
      resourceId: row.id,
      outcome: "ok",
      details: { tenantId: req.tenantId },
    });
    res.json({ handoff: row });
  } catch (err) {
    res.status(500).json({ error: "handoff_assign_failed" });
  }
});

// ---- Omnichannel orchestration (web-first + webhook adapters) ----
app.post(
  "/api/channels/events",
  authLimiter,
  (req, res, next) => {
    if (
      !requireEnvSecretOrFailClosed({
        req,
        res,
        envName: "CHANNEL_EVENTS_SECRET",
        headerName: "x-channel-events-secret",
        notConfiguredError: "channel_events_secret_not_configured",
        invalidError: "channel_events_secret_invalid",
      })
    ) {
      return;
    }
    next();
  },
  loadTenant,
  async (req, res) => {
  try {
    const { channel = "web", externalUserId = "", text = "", metadata = null } = req.body || {};
    if (!externalUserId) return res.status(400).json({ error: "external_user_id_required" });
    const textSafe = String(text || "").slice(0, 8000);
    let metadataSafe = undefined;
    if (metadata != null) {
      if (typeof metadata !== "object" || Array.isArray(metadata)) {
        return res.status(400).json({ error: "metadata_must_be_object" });
      }
      const raw = JSON.stringify(metadata);
      if (raw.length > 8192) return res.status(400).json({ error: "metadata_too_large" });
      metadataSafe = metadata;
    }
    const identity = await prisma.channelIdentity.upsert({
      where: {
        tenantId_channel_externalUserId: {
          tenantId: req.tenantId,
          channel: String(channel),
          externalUserId: String(externalUserId),
        },
      },
      update: { metadata: metadataSafe ?? undefined, lastSeenAt: new Date() },
      create: {
        tenantId: req.tenantId,
        channel: String(channel),
        externalUserId: String(externalUserId),
        sessionId: req.cookies?.sid || null,
        metadata: metadataSafe ?? undefined,
      },
    });
    await prisma.channelMessage.create({
      data: {
        tenantId: req.tenantId,
        channel: String(channel),
        externalUserId: String(externalUserId),
        direction: "inbound",
        content: textSafe,
        metadata: metadataSafe ?? undefined,
      },
    });
    await writeAudit(prisma, req, {
      actorType: "channel",
      actorId: String(externalUserId).slice(0, 200),
      action: "channel.event.inbound",
      resource: "channel_identity",
      resourceId: identity.id,
      outcome: "ok",
      details: { channel: String(channel) },
    });
    res.json({ ok: true, identityId: identity.id });
  } catch (err) {
    console.error("channel event failed", err.message);
    res.status(500).json({ error: "channel_event_failed" });
  }
  }
);

app.get('/api/channels/identities', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("funnel:read"), async (req, res) => {
  const rows = await prisma.channelIdentity.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { lastSeenAt: "desc" },
    take: Math.min(200, Number(req.query.limit || 50)),
  });
  res.json({ identities: rows });
});

// ---- Booking + quoting automation ----
app.post('/api/appointments', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("booking:write"), async (req, res) => {
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
    await writeAudit(prisma, req, {
      action: "appointment.create",
      resource: "appointment",
      resourceId: row.id,
      outcome: "ok",
      details: { leadId: row.leadId },
    });
    res.status(201).json({ appointment: row });
  } catch (err) {
    res.status(500).json({ error: "appointment_create_failed" });
  }
});

app.post('/api/quotes', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("quote:write"), async (req, res) => {
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
    await writeAudit(prisma, req, {
      action: "quote.create",
      resource: "quote",
      resourceId: row.id,
      outcome: "ok",
      details: { leadId: row.leadId, amount: row.amount, currency: row.currency },
    });
    res.status(201).json({ quote: row });
  } catch (err) {
    res.status(500).json({ error: "quote_create_failed" });
  }
});

// ---- Compliance and trust APIs ----
app.post(
  "/api/compliance/consent",
  authLimiter,
  (req, res, next) => {
    if (
      !requireEnvSecretOrFailClosed({
        req,
        res,
        envName: "CONSENT_WRITE_SECRET",
        headerName: "x-consent-write-secret",
        notConfiguredError: "consent_write_secret_not_configured",
        invalidError: "consent_write_secret_invalid",
      })
    ) {
      return;
    }
    next();
  },
  loadTenant,
  async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const subject = String(body.subject != null && body.subject !== "" ? body.subject : req.cookies?.sid || "anonymous")
        .trim()
        .slice(0, 500);
      const purpose = String(body.purpose != null ? body.purpose : "messaging")
        .trim()
        .slice(0, 200);
      const source = String(body.source != null ? body.source : "web")
        .trim()
        .slice(0, 100);
      let metadata = undefined;
      if (body.metadata != null) {
        if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
          return res.status(400).json({ error: "metadata_must_be_object" });
        }
        const raw = JSON.stringify(body.metadata);
        if (raw.length > 4096) return res.status(400).json({ error: "metadata_too_large" });
        metadata = body.metadata;
      }

      const row = await prisma.consentRecord.create({
        data: {
          tenantId: req.tenantId,
          subject: subject || "anonymous",
          purpose: purpose || "messaging",
          granted: Boolean(body.granted),
          source: source || "web",
          metadata,
        },
      });
      await writeAudit(prisma, req, {
        actorType: "end_user",
        action: "consent.record",
        resource: "consent_record",
        resourceId: row.id,
        outcome: "ok",
        details: { purpose: row.purpose, granted: row.granted, source: row.source },
      });
      res.status(201).json({
        consent: {
          id: row.id,
          purpose: row.purpose,
          granted: row.granted,
          source: row.source,
          createdAt: row.createdAt,
        },
      });
    } catch (err) {
      res.status(500).json({ error: "consent_write_failed" });
    }
  }
);

app.get('/api/compliance/export', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("audit:read"), async (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [consents, audits] = await Promise.all([
    prisma.consentRecord.findMany({ where: { tenantId: req.tenantId, createdAt: { gte: since } } }),
    prisma.auditLog.findMany({ where: { tenantId: req.tenantId, createdAt: { gte: since } } }),
  ]);
  await writeAudit(prisma, req, {
    action: "compliance.export",
    resource: "tenant_compliance_bundle",
    outcome: "ok",
    details: {
      since: since.toISOString(),
      consentCount: consents.length,
      auditCount: audits.length,
    },
  });
  res.json({ tenantId: req.tenantId, since, consents, audits });
});

// ---- Revenue and conversion intelligence ----
app.get('/api/revenue/funnel', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("funnel:read"), async (req, res) => {
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
app.post('/api/optimize/record', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("optimize:write"), async (req, res) => {
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
    await writeAudit(prisma, req, {
      action: "optimize.record",
      resource: "optimization_run",
      resourceId: row.id,
      outcome: "ok",
      details: { experimentKey: row.experimentKey, variant: row.variant },
    });
    res.json({ optimization: row });
  } catch (err) {
    res.status(500).json({ error: "optimization_record_failed" });
  }
});

app.get('/api/optimize/recommendation', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("optimize:read"), async (req, res) => {
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
app.post('/api/reengagement/campaigns', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("campaign:write"), async (req, res) => {
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

    await writeAudit(prisma, req, {
      action: "campaign.create",
      resource: "reengagement_campaign",
      resourceId: row.id,
      outcome: "ok",
      details: { name: row.name, channel: row.channel, dispatchedWebhooks: dispatched },
    });
    res.status(201).json({ campaign: row, dispatchedWebhooks: dispatched });
  } catch (err) {
    res.status(500).json({ error: "campaign_create_failed" });
  }
});

// ---- Competitor-aware benchmarking ----
app.post('/api/benchmarks/run', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("benchmark:write"), async (req, res) => {
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
    await writeAudit(prisma, req, {
      action: "benchmark.run",
      resource: "benchmark_run",
      resourceId: row.id,
      outcome: "ok",
      details: { name: row.name, winner: row.winner },
    });
    res.status(201).json({ benchmark: row });
  } catch (err) {
    res.status(500).json({ error: "benchmark_run_failed" });
  }
});

app.get('/api/benchmarks', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("benchmark:read"), async (req, res) => {
  const rows = await prisma.benchmarkRun.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(req.query.limit || 20), 100),
  });
  res.json({ benchmarks: rows });
});

// ---- Self-serve onboarding wizard APIs ----
app.post('/api/onboarding/start', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("onboarding:write"), async (req, res) => {
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
  await writeAudit(prisma, req, {
    action: "onboarding.start",
    resource: "onboarding_session",
    resourceId: row.id,
    outcome: "ok",
  });
  res.status(201).json({ onboarding: row });
});

app.post('/api/onboarding/:id/step', requirePlatformAuth, loadTenant, assertOperatorTenantPermission("onboarding:write"), async (req, res) => {
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
  await writeAudit(prisma, req, {
    action: "onboarding.step",
    resource: "onboarding_session",
    resourceId: updated.id,
    outcome: "ok",
    details: { step, progress: updated.progress, status: updated.status },
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

  await writeAudit(prisma, req, {
    actorType: "api_client",
    actorId: "integration_inbound",
    action: "integration.inbound",
    resource: "integration_event",
    outcome: "ok",
    details: { provider: out.provider, type: out.type },
  });

  res.status(202).json({
    ok: true,
    accepted: { type: out.type, provider: out.provider },
  });
});

// ---- Generic webhook adapter for external CRM/booking stacks ----
/**
 * Capability probe: same auth chain as POST webhook-test, without sending HTTP to customer URLs.
 */
app.get(
  "/api/integrations/webhook-test",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  (_req, res) => {
    res.json({ ok: true, available: true });
  }
);

/**
 * Webhook connectivity test (tenant-scoped).
 * Registered LeadWebhook rows only — arbitrary URLs are disabled to reduce SSRF risk.
 * POST body: { webhookId?, eventType? } — omit webhookId to test all enabled hooks for this tenant.
 */
app.post(
  "/api/integrations/webhook-test",
  authLimiter,
  requirePlatformAuth,
  loadTenant,
  assertOperatorTenantPermission("config:write"),
  async (req, res) => {
    const tenantId = req.tenantId;
    const body = req.body || {};
    const endpointRaw = body.endpoint != null ? String(body.endpoint).trim() : "";
    if (endpointRaw) {
      return res.status(400).json({
        error: "arbitrary_endpoint_disabled",
        message:
          "Arbitrary URL webhook tests are disabled. Use a registered webhook (webhookId) or omit it to test all enabled outbound webhooks for this tenant.",
      });
    }

    /** @type {{ webhookId: string|null, endpoint: string, ok: boolean, status: number, durationMs: number, error: string|null }[]} */
    const results = [];

    const allowedTypes = new Set(listEventTypes());
    let eventType = body.eventType != null ? String(body.eventType).trim() : EventType.ADMIN_WEBHOOK_TEST;
    if (!eventType) eventType = EventType.ADMIN_WEBHOOK_TEST;
    if (!allowedTypes.has(eventType)) {
      return res.status(400).json({ error: "invalid_event_type", allowed: [...allowedTypes] });
    }

    const webhookId = body.webhookId != null ? String(body.webhookId).trim() : "";
    const hooks = await prisma.leadWebhook.findMany({
      where: {
        tenantId,
        enabled: true,
        ...(webhookId ? { id: webhookId } : {}),
      },
    });

    if (webhookId && hooks.length === 0) {
      return res.status(404).json({ error: "webhook_not_found" });
    }

    const targets = hooks.filter((h) => webhookSubscribesToEvent(h.events, eventType));
    if (!targets.length) {
      await writeAudit(prisma, req, {
        action: "webhook.test",
        resource: "outbound_webhook_test",
        outcome: "ok",
        details: { mode: "registered", tested: 0, eventType, reason: "no_subscribers" },
      });
      return res.json({
        ok: true,
        tested: 0,
        results: [],
        note:
          hooks.length === 0
            ? "no_webhooks"
            : "no_hooks_subscribed_to_event",
      });
    }

    const testData =
      eventType === EventType.ADMIN_WEBHOOK_TEST
        ? {
            test: true,
            message:
              "Solomon operator connectivity test. Not a real lead, conversation, or production integration event.",
          }
        : {
            test: true,
            simulated: true,
            message:
              "Synthetic test delivery from Solomon admin. Not a real production record — receivers should treat as non-prod.",
          };

    const envelope = buildEnvelope(eventType, tenantId, testData);

    for (const hook of targets) {
      const t0 = Date.now();
      try {
        const out = await sendGenericWebhook(hook.endpoint, envelope, hook.secret || "");
        const durationMs = Date.now() - t0;
        results.push({
          webhookId: hook.id,
          endpoint: String(hook.endpoint || "").slice(0, 200),
          ok: out.ok,
          status: out.status,
          durationMs,
          error: out.ok ? null : "http_non_success",
        });
      } catch (err) {
        const durationMs = Date.now() - t0;
        results.push({
          webhookId: hook.id,
          endpoint: String(hook.endpoint || "").slice(0, 200),
          ok: false,
          status: err.response?.status ?? 0,
          durationMs,
          error: String(err?.message || err).slice(0, 500),
        });
      }
    }

    const allOk = results.length > 0 && results.every((r) => r.ok);
    await writeAudit(prisma, req, {
      action: "webhook.test",
      resource: "outbound_webhook_test",
      outcome: allOk ? "ok" : "fail",
      details: {
        mode: "registered",
        tested: results.length,
        eventType,
        webhookId: webhookId || null,
      },
    });

    res.json({
      ok: allOk,
      tested: results.length,
      results,
    });
  }
);

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
    const slug = result.tenant?.slug || "";
    let auditTenantId = null;
    if (slug) {
      const tr = await prisma.tenant.findFirst({
        where: { OR: [{ subdomain: slug }, { id: slug }] },
        select: { id: true },
      });
      auditTenantId = tr?.id || null;
    }
    if (auditTenantId) {
      await writeAudit(prisma, req, {
        tenantId: auditTenantId,
        actorType: "platform_user",
        actorId: String(result.user?.id || ""),
        action: "sso.callback",
        resource: "platform_token",
        outcome: "ok",
        details: { slug },
      });
    }
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
    res.setHeader("Content-Security-Policy", buildEmbedPageCsp());
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

attachClientPortalRoutes(app, {
  prisma,
  requirePlatformAuth,
  platformOperatorCapable,
  loadClientTenant,
  assertTenantAccess,
  requireClientPermission,
  authLimiter,
  writeAudit,
  retrieveContext,
  getBehaviorForGet,
  mergeBehaviorIncoming,
  validateAndNormalizeBehaviorPatch,
  getBusinessProfileForGet,
  mergeBusinessProfileIncoming,
  validateAndNormalizeBusinessProfilePatch,
  computePilotReadiness,
  verifyTenantForAdmin,
  getAdminServerHints,
  normalizeEmbedTheme,
  clipCssishToken,
  BRANDING_COLUMNS,
  listEventTypes,
  INTEGRATION_SCHEMA_VERSION,
  sendGenericWebhook,
  parseAdminListPagination,
  adminSearchText,
  parseOptionalIsoDate,
  normalizeRole: normalizeMembershipRole,
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
  if (process.env.NODE_ENV !== "production") {
    logRuntimeModeHint();
  }
  validateProductionBoot();
  logProductionBootWarnings();
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

