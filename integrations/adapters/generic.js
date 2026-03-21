const { EventType } = require("../domain");

/**
 * Pass-through adapter: body should already be close to canonical, or use { type, data }.
 */
function normalize(body, _settings) {
  const b = body && typeof body === "object" ? body : {};
  const type = typeof b.type === "string" && b.type ? b.type : EventType.CONTEXT_PATCH;
  const payload = b.data !== undefined ? b.data : b.payload !== undefined ? b.payload : b;
  return { type, payload, provider: "generic" };
}

module.exports = { normalize };
