const { getClientIp } = require("./rateLimit");

async function writeAudit(prisma, req, data) {
  try {
    const tenantId = data.tenantId || req.tenantId || req.tenant?.id;
    if (!tenantId) return;
    await prisma.auditLog.create({
      data: {
        tenantId,
        actorType: data.actorType || (req.platformUser ? "platform_user" : "system"),
        actorId: String(data.actorId || req.platformUser?.id || ""),
        action: String(data.action || "unknown"),
        resource: String(data.resource || "unknown"),
        resourceId: data.resourceId ? String(data.resourceId) : undefined,
        outcome: String(data.outcome || "ok"),
        ip: getClientIp(req),
        userAgent: String(req.headers["user-agent"] || ""),
        details: data.details ?? undefined,
      },
    });
  } catch (err) {
    console.warn("audit write failed:", err.message);
  }
}

module.exports = { writeAudit };
