const { buildEnvelope, webhookSubscribesToEvent } = require("../integrations/domain");
const { enqueue } = require("../utils/jobQueue");
const { sendGenericWebhook } = require("../utils/webhook");

/**
 * Dispatch a versioned canonical event to enabled LeadWebhook endpoints for the tenant
 * that subscribe to this event (see LeadWebhook.events).
 * Uses async queue when Redis is available; otherwise attempts synchronous delivery.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} tenantId
 * @param {string} eventType
 * @param {object} data canonical payload under envelope.data
 * @param {object|null} legacyRootShim optional flat fields merged at envelope root (backward compatibility)
 */
async function emitIntegrationEvent(prisma, tenantId, eventType, data, legacyRootShim = null) {
  const envelope = buildEnvelope(eventType, tenantId, data, legacyRootShim);
  const hooks = await prisma.leadWebhook.findMany({
    where: { tenantId, enabled: true },
  });

  let dispatched = 0;
  for (const hook of hooks) {
    if (!webhookSubscribesToEvent(hook.events, eventType)) continue;

    dispatched += 1;
    const jobPayload = {
      endpoint: hook.endpoint,
      secret: hook.secret || "",
      body: envelope,
    };
    const queued = await enqueue("events", "integration-webhook", jobPayload);
    if (!queued) {
      try {
        await sendGenericWebhook(hook.endpoint, envelope, hook.secret || "");
      } catch (e) {
        console.error("emitIntegrationEvent direct webhook failed:", e.message);
      }
    }
  }

  return { dispatched, event: eventType, schemaVersion: envelope.schemaVersion };
}

module.exports = { emitIntegrationEvent };
