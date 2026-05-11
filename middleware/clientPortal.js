const { hasClientTenantPermission } = require("./rbac");

function normalizeRole(role) {
  return String(role || "viewer").toLowerCase();
}

function platformOperatorCapable(role) {
  const r = normalizeRole(role);
  return r === "owner" || r === "admin" || r === "operator";
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {typeof import("../utils/tenantSecrets").materializeTenantSecrets} materializeTenantSecrets
 * @param {(req: import("express").Request) => string} resolveTenantSlug
 */
function createClientPortalMiddleware({ prisma, materializeTenantSecrets, resolveTenantSlug }) {
  const TENANT_SELECT = {
    id: true,
    name: true,
    subdomain: true,
    plan: true,
    settings: true,
    apiKeyHash: true,
    apiKeyLast4: true,
    apiKeyRotatedAt: true,
    openaiKey: true,
    smtpHost: true,
    smtpPort: true,
    smtpUser: true,
    smtpPass: true,
    emailFrom: true,
    emailTo: true,
    brandColor: true,
    brandHover: true,
    botBg: true,
    botText: true,
    userBg: true,
    userText: true,
    glassBg: true,
    glassTop: true,
    blurPx: true,
    headerGlow: true,
    watermarkUrl: true,
    fontFamily: true,
    googleClientId: true,
    googleClientSecret: true,
    googleRedirectUri: true,
    googleTokens: true,
    prompts: true,
    branding: true,
  };

  async function loadClientTenant(req, res, next) {
    try {
      const userId = req.platformUser?.id != null ? String(req.platformUser.id) : "";
      if (!userId) return res.status(401).json({ error: "unauthorized" });

      const platformRole = normalizeRole(req.platformUser?.role);
      const superBypass =
        process.env.ALLOW_PLATFORM_SUPER_ADMIN_ALL_TENANTS === "1" &&
        (platformRole === "owner" || platformRole === "admin");

      if (superBypass) {
        const slug = resolveTenantSlug(req);
        const tenantRow = await prisma.tenant.findFirst({
          where: {
            OR: [{ subdomain: slug }, { id: slug }, { name: { equals: slug, mode: "insensitive" } }],
          },
        });
        if (!tenantRow) return res.status(404).json({ error: "tenant_not_found" });
        req.tenant = materializeTenantSecrets(tenantRow);
        req.tenantId = req.tenant.id;
        req.effectiveTenantRole = platformRole;
        req.tenantMembership = null;
        req.clientPortalSuperBypass = true;
        return next();
      }

      const memberships = await prisma.tenantMembership.findMany({
        where: { userId, status: "active" },
        include: { tenant: { select: { id: true, name: true, subdomain: true } } },
      });

      if (!memberships.length) {
        return res.status(403).json({ error: "no_tenant_memberships", message: "No site access is assigned to this account." });
      }

      const rawAsk =
        String(req.query?.tenant || req.headers["x-tenant"] || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "") || null;

      const platformMapped =
        String(req.tenantSlugOverride || req.platformTenant?.slug || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "") || null;

      let chosen = null;
      if (rawAsk) {
        chosen =
          memberships.find(
            (m) =>
              (m.tenant.subdomain && m.tenant.subdomain.toLowerCase() === rawAsk) ||
              m.tenant.id.toLowerCase() === rawAsk
          ) || null;
        if (!chosen) {
          return res.status(403).json({ error: "tenant_not_allowed", message: "That site is not in your access list." });
        }
      } else if (memberships.length === 1) {
        chosen = memberships[0];
      } else if (platformMapped) {
        chosen =
          memberships.find(
            (m) =>
              (m.tenant.subdomain && m.tenant.subdomain.toLowerCase() === platformMapped) ||
              m.tenant.id.toLowerCase() === platformMapped
          ) || null;
        if (!chosen) {
          return res.status(403).json({
            error: "tenant_platform_mismatch",
            message: "Your portal session is tied to a site that is not in your access list.",
          });
        }
      } else {
        return res.status(400).json({
          error: "tenant_selection_required",
          allowedTenants: memberships.map((m) => ({
            slug: m.tenant.subdomain || m.tenant.id,
            displayName: m.tenant.name,
            role: m.role,
          })),
        });
      }

      const tenantRow = await prisma.tenant.findFirst({
        where: { id: chosen.tenantId },
        select: TENANT_SELECT,
      });
      if (!tenantRow) return res.status(404).json({ error: "tenant_not_found" });

      req.tenant = materializeTenantSecrets(tenantRow);
      req.tenantId = req.tenant.id;
      req.tenantMembership = chosen;
      req.effectiveTenantRole = normalizeRole(chosen.role);
      req.clientPortalSuperBypass = false;
      next();
    } catch (e) {
      console.error("loadClientTenant:", e);
      res.status(500).json({ error: "client_tenant_load_failed" });
    }
  }

  /**
   * Ensures tenant access is established (membership or super bypass).
   * Call after loadClientTenant.
   */
  function assertTenantAccess(req, res, next) {
    if (!req.platformUser || !req.tenantId) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (req.clientPortalSuperBypass) return next();
    if (!req.tenantMembership) {
      return res.status(403).json({ error: "tenant_access_denied" });
    }
    if (String(req.tenantMembership.status || "").toLowerCase() !== "active") {
      return res.status(403).json({ error: "membership_inactive" });
    }
    next();
  }

  function requireClientPermission(permission) {
    return (req, res, next) => {
      const role = normalizeRole(req.effectiveTenantRole);
      if (!hasClientTenantPermission(role, permission)) {
        return res.status(403).json({ error: "forbidden", permission });
      }
      next();
    };
  }

  /**
   * After loadTenant: operator/tenant API routes require active TenantMembership for
   * req.tenantId (userId + email fallback) and hasClientTenantPermission on the membership role.
   * Platform owner/admin may bypass only when ALLOW_PLATFORM_SUPER_ADMIN_ALL_TENANTS=1.
   * Does not use portalMode. Never grants tenants:provision via membership.
   */
  function assertOperatorTenantPermission(permission) {
    return async (req, res, next) => {
      try {
        if (!req.platformUser || !req.tenantId) {
          return res.status(401).json({ error: "unauthorized" });
        }

        const platformRole = normalizeRole(req.platformUser.role);
        const superBypass =
          process.env.ALLOW_PLATFORM_SUPER_ADMIN_ALL_TENANTS === "1" &&
          (platformRole === "owner" || platformRole === "admin");

        if (superBypass) {
          req.tenantMembership = null;
          req.effectiveTenantRole = platformRole;
          req.operatorTenantSuperBypass = true;
          return next();
        }

        const userId = String(req.platformUser.id || "");
        const platformEmail =
          req.platformUser.email != null ? String(req.platformUser.email).trim().toLowerCase() : "";

        const or = [{ userId }];
        if (platformEmail) {
          or.push({ email: { equals: platformEmail, mode: "insensitive" } });
        }

        const membership = await prisma.tenantMembership.findFirst({
          where: {
            tenantId: req.tenantId,
            status: "active",
            OR: or,
          },
        });

        if (!membership) {
          return res.status(403).json({
            error: "tenant_access_denied",
            message: "This action requires an active membership for this site.",
          });
        }

        const role = normalizeRole(membership.role);
        if (!hasClientTenantPermission(role, permission)) {
          return res.status(403).json({ error: "forbidden", permission });
        }

        req.tenantMembership = membership;
        req.effectiveTenantRole = role;
        req.operatorTenantSuperBypass = false;
        next();
      } catch (e) {
        console.error("assertOperatorTenantPermission:", e);
        res.status(500).json({ error: "tenant_access_check_failed" });
      }
    };
  }

  return {
    loadClientTenant,
    assertTenantAccess,
    requireClientPermission,
    platformOperatorCapable,
    normalizeRole,
    assertOperatorTenantPermission,
  };
}

module.exports = {
  createClientPortalMiddleware,
  platformOperatorCapable,
  normalizeRole,
};
