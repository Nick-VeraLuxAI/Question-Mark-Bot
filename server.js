// server.js
const express = require('express');
const fsp = require("fs").promises;
const path = require('path');
const nodemailer = require('nodemailer');
const OpenAI = require('openai');
const { google } = require('googleapis');
const cookieParser = require('cookie-parser');

const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { encrypt, decrypt, isEncrypted, hasKey } = require('./utils/kms');
const { platformSSOMiddleware } = require('./middleware/platformSSO');
const PROMPTS_DIR = process.env.PROMPTS_DIR || "prompts/tenants";
const DEFAULT_TENANT = (process.env.DEFAULT_TENANT || "default").toLowerCase();
const HOT = process.env.HOT_RELOAD_PROMPTS === "1";
const cache = new Map(); // key=abs path -> contents

// NEW: normalize/decrypt sensitive tenant fields for runtime use
function materializeTenantSecrets(t) {
  if (!t) return t;
  const out = { ...t };

  // Only decrypt if the value was stored encrypted
  try {
    if (out.smtpPass && isEncrypted(out.smtpPass)) {
      out.smtpPass = decrypt(out.smtpPass);
    }
  } catch {}

  try {
    if (out.openaiKey && isEncrypted(out.openaiKey)) {
      out.openaiKey = decrypt(out.openaiKey);
    }
  } catch {}

  // googleTokens may be: encrypted string, plain JSON string, or already an object
  try {
    const tok = out.googleTokens;
    if (typeof tok === 'string') {
      if (isEncrypted(tok)) {
        out.googleTokens = JSON.parse(decrypt(tok));
      } else {
        try { out.googleTokens = JSON.parse(tok); } catch {}
      }
    }
  } catch {}

  return out;
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
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant'],
  maxAge: 600,
}));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Session persistence (tenant_id + session_id) ---
app.use(cookieParser());

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Platform SSO — verify platform JWTs and map to local tenant
app.use(platformSSOMiddleware(prisma));

function getClientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter({ windowMs, max, keyPrefix }) {
  const store = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now >= entry.resetAt) store.delete(key);
    }
  }, Math.min(windowMs, 60_000)).unref();

  return (req, res, next) => {
    const ip = getClientIp(req);
    const tenant = resolveTenantSlug(req);
    const key = `${keyPrefix}:${ip}:${tenant}`;
    const now = Date.now();
    const current = store.get(key);

    if (!current || now >= current.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'rate_limit_exceeded' });
    }

    current.count += 1;
    return next();
  };
}

const messageLimiter = createRateLimiter({
  windowMs: Number(process.env.MESSAGE_RATE_WINDOW_MS || 60_000),
  max: Number(process.env.MESSAGE_RATE_MAX || 30),
  keyPrefix: 'message',
});

const authLimiter = createRateLimiter({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 60_000),
  max: Number(process.env.AUTH_RATE_MAX || 20),
  keyPrefix: 'auth',
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


const { randomUUID, randomBytes } = require('crypto');
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
    const userText = (req.body?.message || req.body?.content || req.body?.text || req.body?.prompt || "").toString().trim();

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
  const text = (message ?? '').toString();   // <— guard
  const { tenant, tenantId, sessionId } = req; // ✅ provided by middleware

  console.log("📨 Received message:", text);
  if (source) console.log("📍 Source:", source);

  // ✅ Logging now uses tenantId
  await logEvent("user", text, tenantId);


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
    console.log('leadTags', tags);

    // Log to admin + DB
    try {
      await logLead({ name, email, phone, snippet: text, tags }, tenantId);
    } catch (e) {
      console.error("Failed to log lead to admin:", e.message);
    }


// 📧 Per-tenant SMTP (Titan / generic)
const port = Number(tenant?.smtpPort ?? 587);   // Titan: 587 STARTTLS
const secure = port === 465;                    // 465 = SSL

const transporter = nodemailer.createTransport({
  host: tenant?.smtpHost || "smtp.titan.email",
  port,
  secure,                          // true for 465, false for 587
  requireTLS: !secure,             // force STARTTLS when using 587
  auth: {
    user: tenant?.smtpUser,        // 'nick@veralux.ai'
    pass: tenant?.smtpPass,        // Titan mailbox password (can include symbols)
  },
  tls: secure ? undefined : { minVersion: "TLSv1.2" },
});

// (optional) log once so you can confirm no more gmail host in logs
console.log("SMTP cfg =>", {
  host: tenant?.smtpHost || "smtp.titan.email",
  port,
  secure,
  user: tenant?.smtpUser,
  passLen: (tenant?.smtpPass || "").length
});


// One mailOptions definition only
const mailOptions = {
  from: tenant?.emailFrom || tenant?.smtpUser,   // should be the Gmail acct or verified alias
  to:   tenant?.emailTo   || tenant?.smtpUser,
  subject: `📥 New Consultation Request (${tenant?.name || tenantId})`,
  text:
    "New Lead Captured:\n\n" +
    `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n` +
    `Tags: ${tags.join(', ')}\n\n` +
    `Original Message: ${text}`,
};

    transporter.sendMail(mailOptions)
      .then(info => {
        console.log("✅ Contact info sent via email:", info.response);
        return Promise.all([
          logSuccess(tenantId), // ← mark a successful request for the status widget
          logEvent("server", `Captured new lead: ${name}, ${email}, ${phone}`, tenantId),
          logEvent("ai", "AI replied with: consultation confirmation", tenantId),
        ]);
      })
      .catch(error => {
        console.error("❌ Email failed to send:", error);
        return logError("Email", `Email failed: ${error.message}`, tenantId);
      });

    return res.json({
      reply: "Thanks, I've submitted your information to our team! We'll reach out shortly to schedule your consultation."
    });
  }

  // -------- Normal AI response flow --------
  try {
    console.log("🧠 Sending to OpenAI:", message);

    // Always load prompts (tenant OR default)
    const { system, policy, voice } = await loadPromptsDBFirst(req);
    const systemPrompt = system || "You are Solomon, the professional AI assistant.";

    const messages = [
      { role: "system", content: systemPrompt },
      ...(policy ? [{ role: "system", content: `Tenant Policy (${tenant?.name || tenantId}):\n${policy}` }] : []),
      ...(voice  ? [{ role: "system", content: `Voice & Style Guide (${tenant?.name || tenantId}):\n${voice}` }] : []),
      { role: "user", content: text }
    ];

    const openai = new OpenAI({ apiKey: tenant?.openaiKey || process.env.OPENAI_API_KEY });

    const start = Date.now();
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages
    });
    const latency = Date.now() - start;
    await logMetric("latency", latency, tenantId);
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
      userMessage: message,
      aiReply: reply,
      tokens: { promptTokens, completionTokens, cachedTokens },
      cost: costs.total
    }, tenantId);

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
app.get('/auth', authLimiter, requirePlatformAuth, loadTenant, async (req, res) => {
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
    res.redirect(authUrl);
  } catch (err) {
    console.error("❌ OAuth Auth Error:", err.message);
    res.status(500).send("OAuth initialization failed");
  }
});

app.get('/api/oauth2callback', authLimiter, requirePlatformAuth, loadTenant, async (req, res) => {
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
    res.send("✅ Authorization successful! You may close this window.");
  } catch (err) {
    console.error("❌ Error retrieving access token:", err.message);
    res.status(500).send("Failed to authorize. Please try again.");
  }
});



// ---- Platform Integration API ----

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

// GET /api/config — tenant config for portal (requires platform SSO)
app.get('/api/config', loadTenant, (req, res) => {
  if (!req.platformUser) {
    return res.status(401).json({ error: 'Platform authentication required' });
  }

  const t = req.tenant;
  if (!t) return res.status(404).json({ error: 'Tenant not found' });

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
app.get('/api/stats', loadTenant, async (req, res) => {
  if (!req.platformUser) {
    return res.status(401).json({ error: 'Platform authentication required' });
  }

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
      sameSite: 'Lax',
      maxAge: 4 * 60 * 1000, // 4 minutes (token is 5 min, gives buffer)
      path: '/',
    });

    // Redirect to the main app with the tenant context
    const slug = result.tenant?.slug || '';
    res.redirect(`/?tenant=${encodeURIComponent(slug)}`);
  } catch (err) {
    console.error('[SSO callback] Error:', err);
    res.status(500).send('SSO authentication failed');
  }
});

// ----------------- Static pages -----------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
app.listen(PORT, () => {
  console.log(`✅ Solomon backend running on port ${PORT}`);
});

