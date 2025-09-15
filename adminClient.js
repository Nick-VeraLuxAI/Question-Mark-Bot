// adminClient.js
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Where the Admin intake is listening (strip trailing /)
const rawAdminUrl = process.env.ADMIN_URL || "http://127.0.0.1:10010";
const ADMIN_URL = rawAdminUrl.replace(/\/+$/, "");
const ADMIN_KEY = process.env.ADMIN_CUSTOMER_KEY || process.env.ADMIN_KEY || "";

// Write mode:
//   'admin'  -> only the Admin intake writes to DB (recommended)
//   'bot'    -> only this service writes to DB
//   'both'   -> both write (NOT recommended; duplicates)
const WRITE_MODE = (process.env.LOG_WRITE_MODE || "admin").toLowerCase();
const shouldWriteLocal = () => WRITE_MODE !== "admin";

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
  await postLog({ type: "event", role, message }, tenantId);
  if (!shouldWriteLocal()) return;
  try {
    await prisma.event.create({
      data: { tenantId, type: String(role || "info"), content: String(message || "") }
    });
  } catch (err) { console.error("DB logEvent failed:", err.message); }
}

async function logError(user, message, tenantId) {
  await postLog({ type: "error", user, message }, tenantId);
  if (!shouldWriteLocal()) return;
  try {
    await prisma.event.create({
      data: { tenantId, type: `error:${user}`, content: String(message || "") }
    });
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

  // Send to Admin (single writer)
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

  // Local write only if WRITE_MODE != 'admin'
  if (!shouldWriteLocal()) return;

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
  if (!shouldWriteLocal()) return;
  try {
    await prisma.metric.create({
      data: { tenantId, name: String(type || "custom"), value: Number(value) || 0 }
    });
  } catch (err) { console.error("DB logMetric failed:", err.message); }
}

async function logLead({ name, email, phone, snippet = "", tags = [] }, tenantId) {
  await postLog({ type: "lead", name, email, phone, snippet, tags }, tenantId);
  if (!shouldWriteLocal()) return;
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
  // Mirror to Admin; Admin will write conversation + messages
  await postLog({ type: "conversation", sessionId, data }, tenantId);

  // To avoid any chance of duplication, skip local upsert in admin mode.
  if (!shouldWriteLocal()) return;

  try {
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
