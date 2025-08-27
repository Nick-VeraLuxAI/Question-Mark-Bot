// adminClient.js
const axios = require("axios");
const { calculateCost } = require("./pricing");

const ADMIN_URL = process.env.ADMIN_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const TENANT = process.env.TENANT || "default";

/**
 * Log a normal event (user message, assistant reply, system note, etc.)
 */
async function logEvent(role, message) {
  try {
    await axios.post(
      `${ADMIN_URL}/api/portal/log-event?tenant=${TENANT}&role=${role}&key=${ADMIN_KEY}`,
      { message }
    );
    console.log("📝 Event sent:", role, message);
    return true;
  } catch (err) {
    console.error("❌ Failed to log event to admin panel:", err.message);
    return false;
  }
}

/**
 * Log an error (bad response, crash, etc.)
 */
async function logError(user, message) {
  try {
    await axios.post(
      `${ADMIN_URL}/api/portal/log-error?tenant=${TENANT}&user=${user}&key=${ADMIN_KEY}`,
      { message }
    );
    console.log("❌ Error logged:", message);
    return true;
  } catch (err) {
    console.error("❌ Failed to log error to admin panel:", err.message);
    return false;
  }
}

/**
 * Log model token usage + cost
 */
async function logUsage({ model, prompt_tokens, completion_tokens, cached_tokens, user, cost, breakdown }) {
  try {
    await axios.post(
      `${ADMIN_URL}/api/portal/log-usage?tenant=${TENANT}&user=${user}&key=${ADMIN_KEY}`,
      {
        model,
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        user,
        costUSD: cost,
        breakdown 
      }
    );
    console.log("📊 Usage sent:", { model, prompt_tokens, completion_tokens, cost });
    return true;
  } catch (err) {
    console.error("❌ Failed to log usage to admin panel:", err.message);
    return false;
  }
}

/**
 * Log metrics (latency, conversions, etc.)
 */
async function logMetric(type, value) {
  try {
    await axios.post(
      `${ADMIN_URL}/api/portal/log-metric?tenant=${TENANT}&type=${type}&key=${ADMIN_KEY}`,
      { value }
    );
    console.log(`📈 Metric sent: ${type}=${value}`);
    return true;
  } catch (err) {
    console.error("❌ Failed to log metric to admin panel:", err.message);
    return false;
  }
}

/**
 * Log full conversation snapshots
 */
async function logConversation(sessionId, data) {
  try {
    await axios.post(
      `${ADMIN_URL}/api/portal/log-conversation?tenant=${TENANT}&sessionId=${sessionId}&key=${ADMIN_KEY}`,
      data
    );
    console.log("💬 Conversation logged for session:", sessionId);
    return true;
  } catch (err) {
    console.error("❌ Failed to log conversation to admin panel:", err.message);
    return false;
  }
}

/** Log a lead (drives Premium Lead Funnel + optional viewer) */
async function logLead({ name, email, phone, snippet = '', tags = [] }) {
  // 1) Metric: type=lead with an object payload
  await logMetric('lead', { name, email, phone, snippet, tags });

  // 2) (Optional) Also snapshot to conversation list
  //    Use a stable session id if you have one; otherwise Date.now().
  const sessionId = String(Date.now());
  await logConversation(sessionId, {
    at: new Date().toISOString(),
    name, email, phone, snippet, tags
  });
}

/** Convenience wrappers (optional but handy) */
const logLatency = (ms) => logMetric('latency', ms);
const logSuccess = () => logMetric('success', 1);

module.exports = {
  logEvent,
  logError,
  logUsage,
  logMetric,
  logConversation,
  logLead,        // <- new
  logLatency,     // <- optional
  logSuccess      // <- optional
};
