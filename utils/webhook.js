const axios = require("axios");
const crypto = require("crypto");

function signPayload(secret, payload) {
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function sendGenericWebhook(endpoint, body, secret = "") {
  const raw = body || {};
  const payload = JSON.stringify(raw);
  const signature = signPayload(secret, payload);
  const headers = {
    "Content-Type": "application/json",
    "x-qmb-signature": signature,
  };
  if (raw && typeof raw === "object") {
    if (raw.schemaVersion) headers["x-qmb-schema-version"] = String(raw.schemaVersion);
    if (raw.event) headers["x-qmb-event"] = String(raw.event);
  }
  const res = await axios.post(endpoint, raw, { headers, timeout: 6000 });
  return { status: res.status, ok: res.status >= 200 && res.status < 300 };
}

module.exports = { sendGenericWebhook };
