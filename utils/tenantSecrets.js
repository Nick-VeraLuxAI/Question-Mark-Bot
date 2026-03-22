const { decrypt, isEncrypted } = require("./kms");

/** Decrypt sensitive tenant fields for runtime use (SMTP, OpenAI, Google tokens). */
function materializeTenantSecrets(t) {
  if (!t) return t;
  const out = { ...t };

  try {
    if (out.smtpPass && isEncrypted(out.smtpPass)) {
      out.smtpPass = decrypt(out.smtpPass);
    }
  } catch {}

  try {
    if (out.openaiKey && isEncrypted(out.openaiKey)) {
      out.openaiKey = decrypt(out.openaiKey);
    }
  } catch {}

  try {
    const tok = out.googleTokens;
    if (typeof tok === "string") {
      if (isEncrypted(tok)) {
        out.googleTokens = JSON.parse(decrypt(tok));
      } else {
        try {
          out.googleTokens = JSON.parse(tok);
        } catch {}
      }
    }
  } catch {}

  return out;
}

module.exports = { materializeTenantSecrets };
