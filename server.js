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



// ---------- Tenant resolver (header → query → subdomain → DEFAULT_TENANT) ----------
function resolveTenantSlug(req) {
  const sanitize = s => String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");

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
  logLead
} = require('./adminClient');

const { calculateCost } = require('./pricing');

const app = express();
app.disable("x-powered-by"); // hide Express header
app.set("trust proxy", 1);   // needed on Render/Railway/Heroku for correct IP/proto

app.use(cors());
app.use(express.json()); // same behavior for JSON bodies
app.use(express.static(path.join(__dirname, 'public')));

// --- Session persistence (tenant_id + session_id) ---
app.use(cookieParser());

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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


const { randomUUID } = require('crypto');
function ensureSid(req, res) {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = randomUUID();
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'Lax', maxAge: 1000*60*60*24*30 });
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

  const text = normalize(message);
  const tokens = text.split(" ");
  const contains = (needle) => text.includes(normalize(needle));
  const tokenFuzzyHas = (kw) => {
    const k = normalize(kw);
    if (k.includes(" ")) return contains(k);
    for (const t of tokens) {
      if (t === k) return true;
      if (t.length >= 4 && similar(t, k) >= 0.84) return true;
    }
    return false;
  };

  const tags = new Set();
  for (const [tag, kws] of Object.entries(TAG_DICT)) {
    if (kws.some(tokenFuzzyHas)) tags.add(tag);
  }

  if (tags.has("budget") && (tags.has("flooring") || /floor/.test(text))) {
    tags.add("flooring");
  }

  return Array.from(tags);
}

// ----------------- Main chat endpoint -----------------
app.post('/message', async (req, res) => {
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

  if ((source === "contact" || (emailMatch && phoneMatch && nameLikely))) {
    const nameMatch = text.match(nameRegex);
    const name = nameMatch ? nameMatch[0] : "N/A";
    const email = emailMatch[0];
    const phone = phoneMatch[0];

    const tags = await extractTags(text, tenantId);
    console.log('leadTags', tags);

    // Log to admin + DB
    try {
      await logLead({ name, email, phone, snippet: text, tags }, tenantId);
    } catch (e) {
      console.error("Failed to log lead to admin:", e.message);
    }

    // 📧 Per-tenant SMTP
    const transporter = nodemailer.createTransport({
      host: tenant?.smtpHost || "smtp.titan.email",
      port: tenant?.smtpPort || 465,
      secure: true,
      auth: {
        user: tenant?.smtpUser,
        pass: tenant?.smtpPass,
      }
    });

    const mailOptions = {
      from: tenant?.emailFrom || tenant?.smtpUser,
      to: tenant?.emailTo || "default@yourdomain.com",
      subject: `📥 New Consultation Request (${tenant?.name || "Unknown Tenant"})`,
      text:
        "New Lead Captured:\n\n" +
        `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n` +
        `Tags: ${tags.join(', ')}\n\n` +
        `Original Message: ${text}`
    };

    transporter.sendMail(mailOptions, async (error, info) => {
      if (error) {
        console.error("❌ Email failed to send:", error);
        await logError("Email", `Email failed: ${error.message}`, tenantId);
      } else {
        console.log("✅ Contact info sent via email:", info.response);
        await logEvent("server", `Captured new lead: ${name}, ${email}, ${phone}`, tenantId);
        await logEvent("ai", "AI replied with: consultation confirmation", tenantId);
      }
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


    // Always have at least a minimal system prompt
    const systemPrompt = system || "You are Solomon, the professional AI assistant.";

    // Build chat messages
    const messages = [
      { role: "system", content: systemPrompt },
      ...(policy ? [{ role: "system", content: `Tenant Policy (${tenant?.name || tenantId}):\n${policy}` }] : []),
      ...(voice  ? [{ role: "system", content: `Voice & Style Guide (${tenant?.name || tenantId}):\n${voice}` }] : []),
      { role: "user", content: text }
    ];

    // ✅ Use per-tenant OpenAI key
    const openai = new OpenAI({
      apiKey: tenant?.openaiKey || process.env.OPENAI_API_KEY,
    });

    const start = Date.now();
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages
    });
    const latency = Date.now() - start;
    await logMetric("latency", latency, tenantId);

    let costs = null;
    if (aiResponse.usage) {
      const { prompt_tokens, completion_tokens, cached_tokens = 0 } = aiResponse.usage;
      costs = calculateCost(aiResponse.model || "gpt-4o-mini", prompt_tokens, completion_tokens, cached_tokens);

      await logUsage({
        model: aiResponse.model || "gpt-4o-mini",
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        user: tenantId,
        costUSD: costs.total,
        breakdown: costs
      }, tenantId);
    }

    const reply =
      aiResponse.choices?.[0]?.message?.content ||
      "✅ Solomon received your message but didn’t return a clear reply. Please try rephrasing.";

    await logEvent("ai", reply, tenantId);
    await logConversation(sessionId, {
      userMessage: message,
      aiReply: reply,
      tokens: aiResponse.usage || {},
      cost: costs?.total || 0
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
app.get('/auth', loadTenant, async (req, res) => {
  try {
    const { tenant } = req; // now defined
    const oauth2Client = getOAuthClient(tenant);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive.file'],
      redirect_uri: tenant.googleRedirectUri
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error("❌ OAuth Auth Error:", err.message);
    res.status(500).send("OAuth initialization failed");
  }
});

app.get('/api/oauth2callback', loadTenant, async (req, res) => {
  try {
    const code = req.query.code;
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

function toCssVars(t = {}) {
  const defaults = {
    font: "'Segoe UI', system-ui, sans-serif",
    // Neutral → Earth palette
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
    watermarkUrl: 'none'
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
    watermarkUrl: t.watermarkUrl ? `url("${esc.url(t.watermarkUrl)}")` : undefined
  };
  return { ...defaults, ...Object.fromEntries(Object.entries(fromTenant).filter(([,v]) => v != null && v !== '')) };
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


// ----------------- Server startup -----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Solomon backend running on port ${PORT}`);
});



