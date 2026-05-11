function normalizeRole(role) {
  return String(role || "viewer").toLowerCase();
}

/**
 * Tenant membership roles use the same capability matrix as platform roles for
 * config/stats/funnel, but never receive cross-tenant provisioning rights.
 */
function hasClientTenantPermission(role, permission) {
  if (permission === "tenants:provision") return false;
  return hasPermission(role, permission);
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

/** After tenant-scoped membership middleware, prefer effective tenant role for admin UX. */
function resolveTenantScopedRole(req) {
  if (req.effectiveTenantRole != null && String(req.effectiveTenantRole).trim() !== "") {
    return normalizeRole(req.effectiveTenantRole);
  }
  return resolveRole(req);
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

module.exports = {
  requirePermission,
  hasPermission,
  hasClientTenantPermission,
  resolveRole,
  resolveTenantScopedRole,
};
