// adminClient.js
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const rawAdminUrl = process.env.ADMIN_URL || "http://127.0.0.1:4000";
const ADMIN_URL = rawAdminUrl.replace(/\/+$/, ""); // strip trailing slashes
const ADMIN_KEY = process.env.ADMIN_CUSTOMER_KEY || process.env.ADMIN_KEY || "";

let warnedNoKey = false;

function hdrs(tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for headers");
  const h = { "Content-Type": "application/json", "X-Tenant": tenantId };
  if (ADMIN_KEY) {
    h["x-customer-key"] = ADMIN_KEY; // matches admin intake gate
  } else if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn("⚠️ ADMIN_KEY/ADMIN_CUSTOMER_KEY not set; admin intake may 401.");
  }
  return h;
}

async function postLog(body, tenantId) {
  const headers = hdrs(tenantId);
  try {
    await axios.post(`${ADMIN_URL}/api/portal/log`, body, { headers, timeout: 4000 });
    return true;
  } catch (err) {
    // light retry on network-ish errors/timeouts
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
  await postLog({ type: "event", role, message }, tenantId);
  try {
    await prisma.event.create({ data: { tenantId, type: String(role || "info"), content: String(message || "") } });
  } catch (err) { console.error("DB logEvent failed:", err.message); }
}

async function logError(user, message, tenantId) {
  await postLog({ type: "error", user, message }, tenantId);
  try {
    await prisma.event.create({ data: { tenantId, type: `error:${user}`, content: String(message || "") } });
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

  // fire-and-forget to admin portal (with light retry inside postLog)
  await postLog({
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

  // persist locally
  try {
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
  } catch (err) {
    console.error("DB logUsage failed:", err.message);
  }
}

async function logMetric(type, value, tenantId) {
  await postLog({ type: "metric", metricType: type, value }, tenantId);
  try {
    await prisma.metric.create({ data: { tenantId, name: String(type || "custom"), value: Number(value) || 0 } });
  } catch (err) { console.error("DB logMetric failed:", err.message); }
}

async function logLead({ name, email, phone, snippet = "", tags = [] }, tenantId) {
  await postLog({ type: "lead", name, email, phone, snippet, tags }, tenantId);
  try {
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
  } catch (err) { console.error("DB logLead failed:", err.message); }
}

async function logConversation(sessionId, data, tenantId) {
  // still mirror to the Admin portal
  await postLog({ type: "conversation", sessionId, data }, tenantId);

  try {
    // ensure the conversation row exists (no message writes here)
    await prisma.conversation.upsert({
      where: { tenantId_sessionId: { tenantId, sessionId } },
      update: {},
      create: { tenantId, sessionId }
    });
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

