function normalizeRole(role) {
  return String(role || "viewer").toLowerCase();
}

function hasPermission(role, permission) {
  const r = normalizeRole(role);
  if (r === "owner" || r === "admin") return true;
  if (r === "analyst") {
    return [
      "stats:read",
      "config:read",
      "audit:read",
      "funnel:read",
      "optimize:read",
      "benchmark:read",
    ].includes(permission);
  }
  if (r === "viewer") {
    return ["stats:read", "config:read", "funnel:read"].includes(permission);
  }
  if (r === "operator") {
    return [
      "tenants:provision",
      "stats:read",
      "config:read",
      "config:write",
      "audit:read",
      "handoff:write",
      "channel:write",
      "campaign:write",
      "booking:write",
      "quote:write",
      "consent:write",
      "benchmark:write",
      "onboarding:write",
      "optimize:write",
      "funnel:read",
      "benchmark:read",
      "optimize:read",
    ].includes(permission);
  }
  return false;
}

function resolveRole(req) {
  const platformRole = req.platformUser?.role;
  return normalizeRole(platformRole || "viewer");
}

function requirePermission(permission) {
  return (req, res, next) => {
    const role = resolveRole(req);
    if (!hasPermission(role, permission)) {
      return res.status(403).json({ error: "forbidden", permission });
    }
    req.platformRole = role;
    next();
  };
}

module.exports = { requirePermission, hasPermission, resolveRole };
