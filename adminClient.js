// adminClient.js
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Where the Admin intake is listening (strip trailing /)
const rawAdminUrl = process.env.ADMIN_URL || "http://127.0.0.1:10010";
const ADMIN_URL = rawAdminUrl.replace(/\/+$/, "");
const ADMIN_KEY = process.env.ADMIN_CUSTOMER_KEY || process.env.ADMIN_KEY || "";

// Write mode:
//   'admin' -> only the Admin intake writes to DB (recommended)
//   'bot'   -> only this service writes to DB
//   'both'  -> both write (NOT recommended; duplicates)
const WRITE_MODE = (process.env.LOG_WRITE_MODE || "admin").toLowerCase();
const wantAdmin = WRITE_MODE === "admin" || WRITE_MODE === "both";
const wantLocal = WRITE_MODE === "bot"   || WRITE_MODE === "both";

// Optional: if admin write fails in 'admin' mode, fall back to local (0/1)
const FALLBACK_LOCAL_ON_FAIL = process.env.LOG_FALLBACK_LOCAL_ON_FAIL === "1";

let warnedNoKey = false;

function hdrs(tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for headers");
  const h = { "Content-Type": "application/json", "X-Tenant": tenantId };
  if (ADMIN_KEY) {
    h["x-customer-key"] = ADMIN_KEY;
  } else if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn("⚠️ ADMIN_KEY/ADMIN_CUSTOMER_KEY not set; admin intake may 401.");
  }
  return h;
}

async function postLog(body, tenantId) {
  if (!wantAdmin) return false; // respect write mode
  const headers = hdrs(tenantId);
  try {
    await axios.post(`${ADMIN_URL}/api/portal/log`, body, { headers, timeout: 4000 });
    return true;
  } catch (err) {
    const retriable = err.code === "ECONNABORTED" || !err.response;
    if (retriable) {
      try {
        await axios.post(`${ADMIN_URL}/api/portal/log`, body, { headers, timeout: 4000 });
        return true;
      } catch (e2) {
        console.warn(`⚠️ Admin log failed (retry): ${e2.response?.status || ""} ${e2.message}`);
        return false;
      }
    }
    console.warn(`⚠️ Admin log failed: ${err.response?.status || ""} ${err.message}`);
    return false;
  }
}

// ---------------- Loggers ----------------
async function logEvent(role, message, tenantId) {
  const ok = await postLog({ type: "event", role, message }, tenantId);
  if (!wantLocal && (!ok && !FALLBACK_LOCAL_ON_FAIL)) return;
  try {
    if (wantLocal || (!ok && FALLBACK_LOCAL_ON_FAIL)) {
      await prisma.event.create({
        data: { tenantId, type: String(role || "info"), content: String(message || "") }
      });
    }
  } catch (err) { console.error("DB logEvent failed:", err.message); }
}

async function logError(user, message, tenantId) {
  const ok = await postLog({ type: "error", user, message }, tenantId);
  if (!wantLocal && (!ok && !FALLBACK_LOCAL_ON_FAIL)) return;
  try {
    if (wantLocal || (!ok && FALLBACK_LOCAL_ON_FAIL)) {
      await prisma.event.create({
        data: { tenantId, type: `error:${user}`, content: String(message || "") }
      });
    }
  } catch (err) { console.error("DB logError failed:", err.message); }
}

async function logUsage(data, tenantId) {
  // accept both shapes
  const modelRaw          = data.model || "";
  const model             = String(modelRaw).toLowerCase();

  const promptTokens      = data.promptTokens     ?? data.prompt_tokens     ?? 0;
  const completionTokens  = data.completionTokens ?? data.completion_tokens ?? 0;
  const cachedTokens      = data.cachedTokens     ?? data.cached_tokens     ?? 0;

  const cost              = (typeof data.costUSD === "number" ? data.costUSD : data.cost) ?? 0;
  const breakdown         = data.breakdown ?? null;

  const ok = await postLog({
    type: "usage",
    usage: {
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cached_tokens: cachedTokens,
      costUSD: cost,
      breakdown
    }
  }, tenantId);

  if (!wantLocal && (!ok && !FALLBACK_LOCAL_ON_FAIL)) return;

  try {
    if (wantLocal || (!ok && FALLBACK_LOCAL_ON_FAIL)) {
      await prisma.usage.create({
        data: {
          tenantId,
          model,
          promptTokens,
          completionTokens,
          cachedTokens,
          cost: Number(cost) || 0,
          breakdown: breakdown ?? undefined
        }
      });
    }
  } catch (err) {
    console.error("DB logUsage failed:", err.message);
  }
}

async function logMetric(type, value, tenantId) {
  const ok = await postLog({ type: "metric", metricType: type, value }, tenantId);
  if (!wantLocal && (!ok && !FALLBACK_LOCAL_ON_FAIL)) return;
  try {
    if (wantLocal || (!ok && FALLBACK_LOCAL_ON_FAIL)) {
      await prisma.metric.create({
        data: { tenantId, name: String(type || "custom"), value: Number(value) || 0 }
      });
    }
  } catch (err) { console.error("DB logMetric failed:", err.message); }
}

async function logLead({ name, email, phone, snippet = "", tags = [] }, tenantId) {
  const ok = await postLog({ type: "lead", name, email, phone, snippet, tags }, tenantId);
  if (!wantLocal && (!ok && !FALLBACK_LOCAL_ON_FAIL)) return;
  try {
    if (wantLocal || (!ok && FALLBACK_LOCAL_ON_FAIL)) {
      await prisma.lead.create({
        data: {
          tenantId,
          name: String(name || ""),
          email: String(email || ""),
          phone: String(phone || ""),
          snippet: String(snippet || ""),
          tags: Array.isArray(tags) ? tags.map(String) : []
        }
      });
    }
  } catch (err) { console.error("DB logLead failed:", err.message); }
}

async function logConversation(sessionId, data, tenantId) {
  const ok = await postLog({ type: "conversation", sessionId, data }, tenantId);
  if (!wantLocal && (!ok && !FALLBACK_LOCAL_ON_FAIL)) return;

  // If you keep local message writes elsewhere (middleware), you may prefer to only upsert convo here.
  try {
    if (wantLocal || (!ok && FALLBACK_LOCAL_ON_FAIL)) {
      await prisma.conversation.upsert({
        where: { tenantId_sessionId: { tenantId, sessionId } },
        update: {},
        create: { tenantId, sessionId }
      });
    }
  } catch (err) {
    console.error("DB logConversation failed:", err.message);
  }
}

// Convenience wrappers
const logLatency = (ms, tenantId) => logMetric("latency", ms, tenantId);
const logSuccess = (tenantId) => logMetric("success", 1, tenantId);

module.exports = {
  logEvent,
  logError,
  logUsage,
  logMetric,
  logConversation,
  logLead,
  logLatency,
  logSuccess,
};
