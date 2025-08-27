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

function getTenant(req) {
  const fromHeader = sanitize(req.headers["x-tenant"]);
  if (fromHeader) { console.log(`🏷️ Tenant: ${fromHeader} (HEADER)`); return fromHeader; }

  const fromQuery = sanitize(req.query.tenant);
  if (fromQuery)  { console.log(`🏷️ Tenant: ${fromQuery} (QUERY)`);  return fromQuery; }

  const fromEnv = sanitize(process.env.TENANT);
  if (fromEnv)    { console.log(`🏷️ Tenant: ${fromEnv} (ENV)`);     return fromEnv; }

  const host = String(req.hostname||"").toLowerCase();
  const sub = host.split(".")[0];
  if (sub && !["www","localhost","127.0.0.1","::1"].includes(sub)) {
    console.log(`🏷️ Tenant: ${sub} (SUBDOMAIN)`);
    return sanitize(sub);
  }

  console.log(`🏷️ Tenant: ${DEFAULT_TENANT} (DEFAULT)`);
  return DEFAULT_TENANT;
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

// Middleware to log user message before /message handler and assistant reply after
app.use(async (req, res, next) => {
  if (req.method !== 'POST' || req.path !== '/message') return next();

  try {
    const tenantId = (req.headers['x-tenant-id'] || req.headers['x-tenant'] || process.env.TENANT || 'default').toString();
    const sessionId = ensureSid(req, res);
    const userText = (req.body?.message || req.body?.content || req.body?.text || req.body?.prompt || '').toString().trim();
    if (!userText) return next();
    
    

    // make sure tenant exists (self-healing)
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: {
        id: tenantId,
        name: tenantId,
        apiKey: `key_${tenantId}`,   // stub key, can replace later
        plan: 'basic'
      }
    });

    // now safe to upsert conversation
    const convo = await prisma.conversation.upsert({
      where: { tenantId_sessionId: { tenantId, sessionId } },
      update: {},
      create: { tenantId, sessionId }
    });


    // save user turn
    await prisma.message.create({ data: { conversationId: convo.id, role: 'user', content: userText } });

    // hook res.json to save assistant reply after your handler responds
    const origJson = res.json.bind(res);
    res.json = async (body) => {
      try {
        const replyText = (body && (body.reply || body.message || body.content || body.text))?.toString();
        if (replyText) {
          await prisma.message.create({ data: { conversationId: convo.id, role: 'assistant', content: replyText } });
        }
      } catch (e) {
        console.error('post-reply save failed', e);
      }
      return origJson(body);
    };

    next();
  } catch (e) {
    console.error('pre-route persistence failed', e);
    next(); // don't block your bot
  }
});


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const transporter = nodemailer.createTransport({
  host: 'smtp.titan.email',
  port: 465,
  secure: true,
  auth: {
    user: process.env.LEAD_EMAIL_USER,
    pass: process.env.LEAD_EMAIL_PASS,
  }
});
 // ✅ Verify SMTP connection at startup
transporter.verify(err => {
  if (err) console.error('SMTP verify failed:', err);
  else console.log('SMTP ready');
});

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

const TAG_DICT = {
  flooring:    ["flooring","epoxy","polyaspartic","flake","flakes","chips","coat","coating","resin","mvr"],
  cabinets:    ["cabinet","cabinets","storage","slatwall","slat wall","shelves","shelving","overhead","rack","racks"],
  lighting:    ["lighting","light","lights","led","fixture","fixtures"],
  electrical:  ["electrical","outlet","outlets","120v","240v","220v","subpanel","breaker","ev charger","charger"],
  insulation:  ["insulation","insulate","spray foam","foam","r-value"],
  doors:       ["garage door","overhead door","roll up","opener","openers","belt drive"],
  budget:      ["budget","price","pricing","cost","estimate","quote","range","ballpark"],
  consultation:["consultation","schedule","appointment","meeting","site visit","quote request","come out"]
};

function extractTags(message) {
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

  // small heuristic
  if (tags.has("budget") && (tags.has("flooring") || /floor/.test(text))) {
    tags.add("flooring");
  }
  return Array.from(tags);
}


// ----------------- Main chat endpoint -----------------
app.post('/message', async (req, res) => {
  const { message, source } = req.body;

  console.log("📨 Received message:", message);
  if (source) console.log("📍 Source:", source);
  await logEvent("user", message);

// Simple lead capture detection
const emailMatch = message.match(/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/);
const phoneMatch = message.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);

// Improved regex: allows multi-word names ("Nick De Santis", "Mary Ann Smith")
const nameRegex = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/;
const nameLikely = nameRegex.test(message);

console.log('leadCheck', { source, nameLikely, email: !!emailMatch, phone: !!phoneMatch });

if ((source === "contact" || (emailMatch && phoneMatch && nameLikely))) {
  const nameMatch = message.match(nameRegex);
  const name = nameMatch ? nameMatch[0] : "N/A";
  const email = emailMatch[0];
  const phone = phoneMatch[0];

  const tags = extractTags(message);
  console.log('leadTags', tags);

  // 🔸 Log to admin first so Premium shows it even if email fails
  try {
    await logLead({ name, email, phone, snippet: message, tags });
  } catch (e) {
    console.error("Failed to log lead to admin:", e.message);
    // keep going; don't block the user response
  }

  const mailOptions = {
    from: process.env.LEAD_EMAIL_USER,
    to: process.env.LEAD_EMAIL_TO,
    subject: '📥 New Consultation Request',
    text:
      "New Lead Captured:\n\n" +
      `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n` +
      `Tags: ${tags.join(', ')}\n\n` +
      `Original Message: ${message}`
  };

  transporter.sendMail(mailOptions, async (error, info) => {
    if (error) {
      console.error("❌ Email failed to send:", error);
      await logError("Email", `Email failed: ${error.message}`);
    } else {
      console.log("✅ Contact info sent via email:", info.response);
      await logEvent("server", `Captured new lead: ${name}, ${email}, ${phone}`);
      await logEvent("ai", "AI replied with: consultation confirmation");
      // no extra metric call; logLead already posted metric + conversation
    }
  });

  return res.json({
    reply: "Thanks, I've submitted your information to our team! We'll reach out shortly to schedule your consultation."
  });
}


// ------------- Normal AI response flow -------------
try {
  console.log("🧠 Sending to OpenAI:", message);

  // Resolve tenant (HEADER → QUERY → ENV → SUBDOMAIN → DEFAULT)
  const tenant = getTenant(req);

  // Load prompts
  const { system, policy, voice } = await loadPrompts(tenant);

  // 🔍 Debug: show source filepaths + sizes
  const sysPathTenant = path.join(PROMPTS_DIR, tenant, "systemprompt.md");
  const polPathTenant = path.join(PROMPTS_DIR, tenant, "policy.md");
  const voiPathTenant = path.join(PROMPTS_DIR, tenant, "voice.md");
  const sysPathDefault = path.join(PROMPTS_DIR, DEFAULT_TENANT, "systemprompt.md");
  const polPathDefault = path.join(PROMPTS_DIR, DEFAULT_TENANT, "policy.md");
  const voiPathDefault = path.join(PROMPTS_DIR, DEFAULT_TENANT, "voice.md");

  console.log("🧩 Prompts loaded:", {
    tenant,
    system: system
      ? { source: path.resolve(sysPathTenant), length: system.length }
      : { source: path.resolve(sysPathDefault), note: "FALLBACK", length: (system || "").length },
    policy: policy
      ? { source: path.resolve(polPathTenant), length: policy.length }
      : { source: path.resolve(polPathDefault), note: "FALLBACK", length: (policy || "").length },
    voice: voice
      ? { source: path.resolve(voiPathTenant), length: voice.length }
      : { source: path.resolve(voiPathDefault), note: "FALLBACK", length: (voice || "").length },
  });

  // Fallback system rules if file missing/empty
  const basePolicy =
    (system && system.trim()) ||
    "You are Solomon, the professional AI assistant for Elevated Garage.\n\n" +
    "✅ Answer garage-related questions about materials like flooring, cabinetry, lighting, and more.\n" +
    "✅ Only provide **average material costs** when discussing pricing.\n" +
    "✅ Clearly state: \"This is for material cost only.\"\n" +
    "✅ Include this disclaimer: \"This is not a quote — material prices may vary depending on brand, availability, and local suppliers.\"\n\n" +
    "🚫 Never include labor, install, or total pricing.\n" +
    "🚫 Never apply markup.\n\n" +
    "✅ If a user shows interest in starting a project, ask:\n" +
    "\"Would you like to schedule a consultation to explore your options further?\"\n\n" +
    "Only collect contact info if the user replies with name, email, and phone in one message.";

  // Assemble messages: system → policy → voice → user
  const messages = [
    { role: "system", content: basePolicy },
    ...(policy ? [{ role: "system", content: `Tenant Policy (${tenant}):\n${policy}` }] : []),
    ...(voice  ? [{ role: "system", content: `Voice & Style Guide (${tenant}):\n${voice}` }] : []),
    { role: "user", content: message }
  ];

  const start = Date.now();
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages
  });
  const latency = Date.now() - start;
  await logMetric("latency", latency, tenant || "unknown");

  let costs = null;
  if (aiResponse.usage) {
    const { prompt_tokens, completion_tokens, cached_tokens = 0 } = aiResponse.usage;
    costs = calculateCost(aiResponse.model || "gpt-4o-mini", prompt_tokens, completion_tokens, cached_tokens);
    await logUsage({
      model: aiResponse.model || "gpt-4o-mini",
      prompt_tokens,
      completion_tokens,
      cached_tokens,
      user: tenant || "unknown",
      cost: costs.total,
      breakdown: costs
    });
  }

  const reply =
    aiResponse.choices?.[0]?.message?.content ||
    "✅ Solomon received your message but didn’t return a clear reply. Please try rephrasing.";

  await logEvent("ai", reply);
  await logConversation(Date.now().toString(), {
    tenant,
    userMessage: message,
    aiReply: reply,
    tokens: aiResponse.usage || {},
    cost: costs?.total || 0
  });

  res.json({ reply });

} catch (err) {
  console.error("❌ OpenAI Error:", err.message);
  const category = err.message.includes("ENOTFOUND") ? "Network"
                  : err.message.includes("OpenAI")    ? "OpenAI"
                  : err.message.includes("SMTP")      ? "Email" : "Server";
  await logError(category, err.message);
  res.status(500).json({ reply: "⚠️ Sorry, Solomon had trouble processing your request. Please try again shortly." });
}

});

// ----------------- Google Drive OAuth -----------------
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    redirect_uri: process.env.GOOGLE_REDIRECT_URI
  });
  res.redirect(authUrl);
});

app.get('/api/oauth2callback', async (req, res) => {
  const code = req.query.code;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync('token.json', JSON.stringify(tokens, null, 2));
    res.send("✅ Authorization successful! You may close this window.");
  } catch (err) {
    console.error('❌ Error retrieving access token:', err.message);
    res.status(500).send('Failed to authorize. Please try again.');
  }
});

// ----------------- Static pages -----------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.redirect('/');
});

// add near your other routes
app.get("/env.css", (req, res) => {
  res.set("Content-Type", "text/css; charset=utf-8");
  res.set("Cache-Control", "no-store"); // <-- important
  res.send(`
    :root{
      --brand:#${(process.env.BRAND_COLOR || "B91B21").replace(/^#/, "")};
      --brandHover:#${(process.env.BRAND_HOVER || "99171b").replace(/^#/, "")};
      --botBg:${process.env.BOT_BG || "#fce7e7"};
      --botText:${process.env.BOT_TEXT || "var(--brand)"};
      --userBg:${process.env.USER_BG || "#eee"};
      --userText:${process.env.USER_TEXT || "#333"};
      --glassBg:${process.env.GLASS_BG || "rgba(255,255,255,0.25)"};
      --glassTop:${process.env.GLASS_TOP || "rgba(255,255,255,0.1)"};
      --blur:${process.env.BLUR_PX || "14px"};
      --headerGlow:${process.env.HEADER_GLOW || "radial-gradient(circle, rgba(185,27,33,0.5) 0%, rgba(185,27,33,0) 75%)"};
      --watermarkUrl:url('${process.env.WATERMARK_URL || "https://assets.zyrosite.com/YNqPvxrOE7FXXPyr/elevated-garage-icon33-Yan1jRDn0afzqlwp.png"}');
      --borderColor:${process.env.BORDER_COLOR || "rgba(255,255,255,0.2)"};
      --font:${JSON.stringify(process.env.FONT_FAMILY || "'Segoe UI', sans-serif")};
    }
  `);
});


// ----------------- Server startup -----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Solomon backend running on port ${PORT}`);
});

