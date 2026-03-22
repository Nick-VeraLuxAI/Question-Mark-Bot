const { randomUUID } = require("crypto");

const MAX_LEN = 128;

/**
 * SOC 2 / ops: stable request correlation for logs and AuditLog.details.requestId.
 * Honors incoming X-Request-Id / X-Correlation-Id when present and sane.
 */
function requestCorrelationMiddleware(req, res, next) {
  const incoming = req.get("x-request-id") || req.get("x-correlation-id");
  let id;
  if (incoming) {
    id = String(incoming).trim().slice(0, MAX_LEN).replace(/[^\w\-:.]/g, "");
  }
  if (!id) id = randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

module.exports = { requestCorrelationMiddleware };
