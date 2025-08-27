// adminClient.js
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const ADMIN_URL = process.env.ADMIN_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const TENANT = process.env.TENANT || "default";

// ---------------- Helpers ----------------
async function safePost(path, query, body) {
  try {
    await axios.post(
      `${ADMIN_URL}${path}?tenant=${TENANT}&key=${ADMIN_KEY}${query || ""}`,
      body
    );
    return true;
  } catch (err) {
    console.warn(`⚠️ Admin panel offline for ${path}:`, err.message);
    return false;
  }
}

// ---------------- Loggers ----------------
async function logEvent(role, message) {
  await safePost("/api/portal/log-event", `&role=${role}`, { message });
  try {
    await prisma.event.create({
      data: { tenantId: TENANT, type: role, content: message },
    });
  } catch (err) {
    console.error("DB logEvent failed:", err.message);
  }
}

async function logError(user, message) {
  await safePost("/api/portal/log-error", `&user=${user}`, { message });
  try {
    await prisma.event.create({
      data: { tenantId: TENANT, type: `error:${user}`, content: message },
    });
  } catch (err) {
    console.error("DB logError failed:", err.message);
  }
}

async function logUsage({ model, prompt_tokens, completion_tokens, cached_tokens, user, cost, breakdown }) {
  await safePost("/api/portal/log-usage", `&user=${user}`, {
    model,
    prompt_tokens,
    completion_tokens,
    cached_tokens,
    user,
    costUSD: cost,
    breakdown,
  });
  try {
    await prisma.usage.create({
      data: {
        tenantId: TENANT,
        model,
        promptTokens: prompt_tokens,
        completionTokens: completion_tokens,
        cachedTokens: cached_tokens,
        cost,
      },
    });
  } catch (err) {
    console.error("DB logUsage failed:", err.message);
  }
}

async function logMetric(type, value) {
  await safePost("/api/portal/log-metric", `&type=${type}`, { value });
  try {
    await prisma.metric.create({
      data: { tenantId: TENANT, name: type, value },
    });
  } catch (err) {
    console.error("DB logMetric failed:", err.message);
  }
}

async function logConversation(sessionId, data) {
  await safePost("/api/portal/log-conversation", `&sessionId=${sessionId}`, data);

  // Instead of stuffing into Metric, save to Conversation + Message tables
  try {
    const convo = await prisma.conversation.upsert({
      where: { tenantId_sessionId: { tenantId: TENANT, sessionId } },
      update: {},
      create: { tenantId: TENANT, sessionId },
    });

    if (data.userMessage) {
      await prisma.message.create({
        data: { conversationId: convo.id, role: "user", content: data.userMessage },
      });
    }
    if (data.aiReply) {
      await prisma.message.create({
        data: { conversationId: convo.id, role: "assistant", content: data.aiReply },
      });
    }
  } catch (err) {
    console.error("DB logConversation failed:", err.message);
  }
}

async function logLead({ name, email, phone, snippet = "", tags = [] }) {
  await safePost("/api/portal/log-lead", "", { name, email, phone, snippet, tags });

  try {
    await prisma.lead.create({
      data: { tenantId: TENANT, name, email, phone, snippet, tags },
    });
  } catch (err) {
    console.error("DB logLead failed:", err.message);
  }
}

// Convenience wrappers
const logLatency = (ms) => logMetric("latency", ms);
const logSuccess = () => logMetric("success", 1);

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
