// adminClient.js
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const ADMIN_URL = process.env.ADMIN_URL || "http://127.0.0.1:4000";
const ADMIN_KEY = process.env.ADMIN_CUSTOMER_KEY || process.env.ADMIN_KEY || "";

function hdrs(tenantId) {
  const h = { "Content-Type": "application/json", "X-Tenant": tenantId };
  if (ADMIN_KEY) h["x-customer-key"] = ADMIN_KEY; // matches admin gate
  return h;
}

async function postLog(body, tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for postLog");
  try {
    await axios.post(`${ADMIN_URL}/api/portal/log`, body, { headers: hdrs(tenantId) });
    return true;
  } catch (err) {
    console.warn(`⚠️ Admin log failed: ${err.response?.status || ""} ${err.message}`);
    return false;
  }
}

// ---------------- Loggers ----------------
async function logEvent(role, message, tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for logEvent");

  await postLog({ type: "event", role, message }, tenantId);
  try {
    await prisma.event.create({ data: { tenantId, type: role, content: message } });
  } catch (err) { console.error("DB logEvent failed:", err.message); }
}

async function logError(user, message, tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for logError");

  await postLog({ type: "error", user, message }, tenantId);
  try {
    await prisma.event.create({ data: { tenantId, type: `error:${user}`, content: message } });
  } catch (err) { console.error("DB logError failed:", err.message); }
}

async function logUsage({ model, prompt_tokens, completion_tokens, cached_tokens, user, cost, breakdown }, tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for logUsage");

  await postLog({
    type: "usage",
    usage: {
      model,
      prompt_tokens,
      completion_tokens,
      cached_tokens,
      user,
      costUSD: cost,
      breakdown
    }
  }, tenantId);

  try {
    await prisma.usage.create({
      data: {
        tenantId,
        model,
        promptTokens: prompt_tokens || 0,
        completionTokens: completion_tokens || 0,
        cachedTokens: cached_tokens || 0,
        cost: cost || 0
      }
    });
  } catch (err) { console.error("DB logUsage failed:", err.message); }
}

async function logMetric(type, value, tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for logMetric");

  await postLog({ type: "metric", metricType: type, value }, tenantId);
  try {
    await prisma.metric.create({ data: { tenantId, name: type, value } });
  } catch (err) { console.error("DB logMetric failed:", err.message); }
}

async function logLead({ name, email, phone, snippet = "", tags = [] }, tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for logLead");

  await postLog({ type: "metric", metricType: "lead", value: { name, email, phone, snippet, tags } }, tenantId);
  try {
    await prisma.lead.create({ data: { tenantId, name, email, phone, snippet, tags } });
  } catch (err) { console.error("DB logLead failed:", err.message); }
}

async function logConversation(sessionId, data, tenantId) {
  if (!tenantId) throw new Error("Tenant ID required for logConversation");

  await postLog({ type: "conversation", sessionId, data }, tenantId);

  try {
    const convo = await prisma.conversation.upsert({
      where: { tenantId_sessionId: { tenantId, sessionId } },
      update: {},
      create: { tenantId, sessionId }
    });

    if (data.userMessage) {
      await prisma.message.create({ data: { conversationId: convo.id, role: "user",      content: data.userMessage } });
    }
    if (data.aiReply) {
      await prisma.message.create({ data: { conversationId: convo.id, role: "assistant", content: data.aiReply } });
    }
  } catch (err) { console.error("DB logConversation failed:", err.message); }
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
