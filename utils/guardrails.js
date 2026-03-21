function redactPII(input) {
  const text = String(input || "");
  return text
    .replace(/\b[\w.-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[REDACTED_PHONE]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_CARD]");
}

function detectInjectionSignals(input) {
  const text = String(input || "").toLowerCase();
  const rules = [
    /ignore\s+previous\s+instructions/,
    /system\s+prompt/,
    /developer\s+message/,
    /reveal\s+.*(secret|token|key)/,
    /bypass\s+.*(safety|policy|guardrail)/,
  ];
  return rules.some((rx) => rx.test(text));
}

function applyGuardrails(rawMessage, opts = {}) {
  const maxLen = Number(opts.maxLen || process.env.MAX_MESSAGE_CHARS || 4000);
  const trimmed = String(rawMessage || "").slice(0, maxLen);
  const injectionDetected = detectInjectionSignals(trimmed);
  const redactForLogs = opts.redactForLogs !== false;
  return {
    safeMessage: trimmed,
    messageForLogs: redactForLogs ? redactPII(trimmed) : trimmed,
    injectionDetected,
  };
}

module.exports = { redactPII, detectInjectionSignals, applyGuardrails };
