const generic = require("./generic");
const hubspot = require("./hubspot");

const registry = {
  generic,
  hubspot,
};

function listAdapters() {
  return Object.keys(registry).sort();
}

/**
 * @param {string} provider
 * @param {object} body
 * @param {object} settings tenant.settings (object)
 * @returns {{ type: string, payload: object, provider: string } | { error: string, known?: string[] }}
 */
function normalizeInbound(provider, body, settings) {
  const p = String(provider || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  const mod = registry[p];
  if (!mod || typeof mod.normalize !== "function") {
    return { error: "unknown_provider", known: listAdapters() };
  }

  const allowed = settings?.integrations?.enabledProviders;
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(p)) {
    return { error: "provider_disabled", provider: p };
  }

  try {
    return mod.normalize(body, settings || {});
  } catch (e) {
    return { error: "adapter_normalize_failed", message: e.message };
  }
}

module.exports = {
  registry,
  listAdapters,
  normalizeInbound,
};
