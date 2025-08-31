// server.js
const express = require('express');
const fs = require('fs');
const fsp = require("fs").promises;
const path = require('path');
const nodemailer = require('nodemailer');
const OpenAI = require('openai');
const { google } = require('googleapis');
const cookieParser = require('cookie-parser');

const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '.env') });
console.log("ENV.TENANT =", process.env.TENANT);


const PROMPTS_DIR = process.env.PROMPTS_DIR || "prompts/tenants";
const DEFAULT_TENANT = (process.env.DEFAULT_TENANT || "default").toLowerCase();
const HOT = process.env.HOT_RELOAD_PROMPTS === "1";
const cache = new Map(); // key=abs path -> contents

const sanitize = s => String(s||"").toLowerCase().replace(/[^a-z0-9_-]/g,"");


// ✅ New subdomain-aware resolver (place it here, before readFileCached)
function resolveTenantSlug(req) {
  const sanitize = s => String(s||"").toLowerCase().replace(/[^a-z0-9_-]/g,"");

  const fromHeader = sanitize(req.headers["x-tenant"]);
  if (fromHeader) return fromHeader;

  const fromQuery = sanitize(req.query.tenant);
  if (fromQuery) return fromQuery;

  const fromEnv = sanitize(process.env.TENANT);
  if (fromEnv) return fromEnv;

  const host = String(req.hostname||"").toLowerCase();
  const sub = host.split(".")[0];
  if (sub && !["www","localhost","127.0.0.1","::1","admin"].includes(sub)) {
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

// Fail-fast / warn for required env
const REQUIRED_ENV = ["LEAD_EMAIL_USER", "LEAD_EMAIL_PASS", "LEAD_EMAIL_TO"];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.warn(`⚠️ Missing ${k} in .env`);
  }
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

const { randomUUID } = require('crypto');
function ensureSid(req, res) {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = randomUUID();
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'Lax', maxAge: 1000*60*60*24*30 });
  }
  return sid;
}

// Middleware to resolve tenant + persist conversation/messages
app.use(async (req, res, next) => {
  if (req.method !== 'POST' || req.path !== '/message') return next();

  try {
    // 🔎 Resolve tenant slug (subdomain/header/query/env)
    const tenantSlug = resolveTenantSlug(req);

    // 🔑 Look up tenant row with all config we care about
    const tenantRow = await prisma.tenant.findFirst({
      where: {
        OR: [
          { subdomain: tenantSlug },
          { id: tenantSlug },
          { name: { equals: tenantSlug, mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        openaiKey: true,
        smtpHost: true,
        smtpPort: true,
        smtpUser: true,
        smtpPass: true,
        emailFrom: true,
        emailTo: true,
        brandColor: true,
        brandHover: true,
        botBg: true,
        botText: true,
        userBg: true,
        userText: true,
        glassBg: true,
        glassTop: true,
        blurPx: true,
        headerGlow: true,
        watermarkUrl: true,
        fontFamily: true,
        googleClientId: true,
        googleClientSecret: true,
        googleRedirectUri: true,
        googleTokens: true
      }
    });

    if (!tenantRow) {
      console.warn("tenant_not_found", { tenantSlug });
      // Optional: return res.status(404).json({ error: "tenant_not_found", tenant: tenantSlug });
    }

    // 🏷️ Attach for use in downstream handlers
    req.tenant = tenantRow;               // whole object
    req.tenantId = tenantRow?.id || tenantSlug;
    req.sessionId = ensureSid(req, res);

    // ⌨️ Capture user text
    const userText = (req.body?.message || req.body?.content || req.body?.text || req.body?.prompt || "").toString().trim();
    if (!userText) return next();

    // 💾 Upsert conversation
    const convo = await prisma.conversation.upsert({
      where: { tenantId_sessionId: { tenantId: req.tenantId, sessionId: req.sessionId } },
      update: {},
      create: { tenantId: req.tenantId, sessionId: req.sessionId }
    });

    // 💬 Save user turn
    await prisma.message.create({ data: { conversationId: convo.id, role: "user", content: userText } });

    // 📩 Hook res.json to capture AI replies automatically
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
    next(); // don’t block your bot
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
    req.tenant = tenantRow;
    req.tenantId = tenantRow.id;
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
  const { tenant, tenantId, sessionId } = req; // ✅ provided by middleware

  console.log("📨 Received message:", message);
  if (source) console.log("📍 Source:", source);

  // ✅ Logging now uses tenantId
  await logEvent("user", message, tenantId);

  // -------- Lead capture detection --------
  const emailMatch = message.match(/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/);
  const phoneMatch = message.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const nameRegex = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/;
  const nameLikely = nameRegex.test(message);

  console.log('leadCheck', { source, nameLikely, email: !!emailMatch, phone: !!phoneMatch });

  if ((source === "contact" || (emailMatch && phoneMatch && nameLikely))) {
    const nameMatch = message.match(nameRegex);
    const name = nameMatch ? nameMatch[0] : "N/A";
    const email = emailMatch[0];
    const phone = phoneMatch[0];

    const tags = await extractTags(message, tenantId);
    console.log('leadTags', tags);

    // Log to admin + DB
    try {
      await logLead({ name, email, phone, snippet: message, tags }, tenantId);
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
        `Original Message: ${message}`
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
    const { system, policy, voice } = await loadPrompts(req.tenant?.subdomain || "default");

    // Always have at least a minimal system prompt
    const systemPrompt = system || "You are Solomon, the professional AI assistant.";

    // Build chat messages
    const messages = [
      { role: "system", content: systemPrompt },
      ...(policy ? [{ role: "system", content: `Tenant Policy (${tenant?.name || tenantId}):\n${policy}` }] : []),
      ...(voice  ? [{ role: "system", content: `Voice & Style Guide (${tenant?.name || tenantId}):\n${voice}` }] : []),
      { role: "user", content: message }
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
        cost: costs.total,
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
      data: { googleTokens: tokens }
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

app.get("/env.css", async (req, res) => {
  const tenantSlug = resolveTenantSlug(req);
  const tenant = await prisma.tenant.findFirst({ where: { subdomain: tenantSlug } });

  res.set("Content-Type", "text/css; charset=utf-8");
  res.set("Cache-Control", "no-store");

  res.send(`
    :root {
      --brand: ${tenant?.brandColor || "#B91B21"};
      --brandHover: ${tenant?.brandHover || "#99171b"};
      --botBg: ${tenant?.botBg || "#fce7e7"};
      --botText: ${tenant?.botText || "#333333"};
      --userBg: ${tenant?.userBg || "#eeeeee"};
      --userText: ${tenant?.userText || "#333333"};
      --glassBg: ${tenant?.glassBg || "rgba(255,255,255,0.25)"};
      --glassTop: ${tenant?.glassTop || "rgba(255,255,255,0.1)"};
      --blur: ${tenant?.blurPx || "14px"};
      --headerGlow: ${tenant?.headerGlow || "radial-gradient(circle, rgba(185,27,33,0.5) 0%, rgba(185,27,33,0) 75%)"};
      --watermarkUrl: url('${tenant?.watermarkUrl || "https://default.logo.png"}');
      --font: ${JSON.stringify(tenant?.fontFamily || "'Segoe UI', sans-serif")};
    }
  `);
});



// ----------------- Server startup -----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Solomon backend running on port ${PORT}`);
});


