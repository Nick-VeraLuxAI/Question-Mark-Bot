const { createHash } = require("crypto");

/**
 * Factory: authenticate with Bearer token or X-Api-Key against Tenant.apiKeyHash.
 * Tenant is resolved the same way as the rest of the API (X-Tenant, query, subdomain).
 */
function createRequireTenantApiKey({ prisma, materializeTenantSecrets, resolveTenantSlug }) {
  return async function requireTenantApiKey(req, res, next) {
    try {
      const auth = String(req.headers.authorization || "");
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const headerKey = String(req.headers["x-api-key"] || "").trim();
      const token = bearer || headerKey;
      if (!token) {
        return res.status(401).json({ error: "api_key_required", hint: "Authorization: Bearer <key> or X-Api-Key" });
      }

      const tenantSlug = resolveTenantSlug(req);
      const tenantRow = await prisma.tenant.findFirst({
        where: {
          OR: [
            { subdomain: tenantSlug },
            { id: tenantSlug },
            { name: { equals: tenantSlug, mode: "insensitive" } },
          ],
        },
      });

      if (!tenantRow) {
        return res.status(404).json({ error: "tenant_not_found" });
      }
      if (!tenantRow.apiKeyHash) {
        return res.status(401).json({ error: "api_key_not_configured", hint: "Rotate a key via /api/keys/rotate (platform auth)" });
      }

      const hash = createHash("sha256").update(token).digest("hex");
      if (hash !== tenantRow.apiKeyHash) {
        return res.status(401).json({ error: "invalid_api_key" });
      }

      req.tenant = materializeTenantSecrets(tenantRow);
      req.tenantId = tenantRow.id;
      next();
    } catch (e) {
      console.error("requireTenantApiKey:", e);
      res.status(500).json({ error: "auth_failed" });
    }
  };
}

module.exports = { createRequireTenantApiKey };
