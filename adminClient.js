// adminClient.js
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const ADMIN_URL = process.env.ADMIN_URL || "http://127.0.0.1:4000";
const ADMIN_KEY = process.env.ADMIN_CUSTOMER_KEY || process.env.ADMIN_KEY || "";
const TENANT    = (process.env.TENANT || "default").toLowerCase();

function hdrs(tenant = TENANT) {
  const h = { "Content-Type": "application/json", "X-Tenant": tenant };
  if (ADMIN_KEY) h["x-customer-key"] = ADMIN_KEY; // matches admin gate
  return h;
}

async function postLog(body, tenant = TENANT) {
  try {
    await axios.post(`${ADMIN_URL}/api/portal/log`, body, { headers: hdrs(tenant) });
    return true;
  } catch (err) {
    console.warn(`⚠️ Admin log failed: ${err.response?.status || ""} ${err.message}`);
    return false;
  }
}

// ---------------- Loggers ----------------
async function logEvent(role, message, tenant = TENANT) {
  await postLog({ type: "event", role, message }, tenant);
  try {
    await prisma.event.create({ data: { tenantId: tenant, type: role, content: message } });
  } catch (err) { console.error("DB logEvent failed:", err.message); }
}

async function logError(user, message, tenant = TENANT) {
  await postLog({ type: "error", user, message }, tenant);
  try {
    await prisma.event.create({ data: { tenantId: tenant, type: `error:${user}`, content: message } });
  } catch (err) { console.error("DB logError failed:", err.message); }
}

async function logUsage({ model, prompt_tokens, completion_tokens, cached_tokens, user, cost, breakdown }, tenant = TENANT) {
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
  }, tenant);

  try {
    await prisma.usage.create({
      data: {
        tenantId: tenant,
        model,
        promptTokens: prompt_tokens || 0,
        completionTokens: completion_tokens || 0,
        cachedTokens: cached_tokens || 0,
        cost: cost || 0
      }
    });
  } catch (err) { console.error("DB logUsage failed:", err.message); }
}

async function logMetric(type, value, tenant = TENANT) {
  await postLog({ type: "metric", metricType: type, value }, tenant);
  try {
    await prisma.metric.create({ data: { tenantId: tenant, name: type, value } });
  } catch (err) { console.error("DB logMetric failed:", err.message); }
}

// Premium “lead” = metric with type 'lead' and value payload
async function logLead({ name, email, phone, snippet = "", tags = [] }, tenant = TENANT) {
  await postLog({ type: "metric", metricType: "lead", value: { name, email, phone, snippet, tags } }, tenant);
  try {
    await prisma.lead.create({ data: { tenantId: tenant, name, email, phone, snippet, tags } });
  } catch (err) { console.error("DB logLead failed:", err.message); }
}

async function logConversation(sessionId, data, tenant = TENANT) {
  await postLog({ type: "conversation", sessionId, data }, tenant);

  // persist in bot DB too
  try {
    const convo = await prisma.conversation.upsert({
      where: { tenantId_sessionId: { tenantId: tenant, sessionId } },
      update: {},
      create: { tenantId: tenant, sessionId }
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
const logLatency = (ms, tenant = TENANT) => logMetric("latency", ms, tenant);
const logSuccess = (tenant = TENANT) => logMetric("success", 1, tenant);

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
