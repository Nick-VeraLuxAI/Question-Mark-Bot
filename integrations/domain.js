/**
 * Canonical integration vocabulary — outbound envelopes and event names.
 * Dashboards, webhooks, and adapters should align with these strings.
 */

const SCHEMA_VERSION = "1.0";

const EventType = {
  LEAD_CREATED: "lead.created",
  CAMPAIGN_LAUNCHED: "campaign.launched",
  CONTEXT_PATCH: "context.patch",
  PROFILE_UPDATED: "profile.updated",
};

function buildEnvelope(event, tenantId, data, legacyRootShim = null) {
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    event,
    occurredAt: new Date().toISOString(),
    tenantId,
    data: data && typeof data === "object" ? data : {},
  };
  if (legacyRootShim && typeof legacyRootShim === "object") {
    Object.assign(envelope, legacyRootShim);
  }
  return envelope;
}

/** All emitted canonical event type strings (for docs / discovery APIs). */
function listEventTypes() {
  return Object.values(EventType);
}

/**
 * Whether a LeadWebhook row should receive this event.
 * Empty `events` → all events (backward compatible). "*" → all. Otherwise must list `eventType`.
 */
function webhookSubscribesToEvent(webhookEvents, eventType) {
  const list = webhookEvents;
  if (!list || !Array.isArray(list) || list.length === 0) return true;
  if (list.includes("*")) return true;
  return list.includes(eventType);
}

module.exports = {
  SCHEMA_VERSION,
  EventType,
  buildEnvelope,
  listEventTypes,
  webhookSubscribesToEvent,
};
