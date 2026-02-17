/**
 * Platform SSO Middleware for Solomon (Question-Mark-Bot)
 *
 * Allows users authenticated via the VeraLux Platform portal to interact
 * with Solomon without a separate login. When a valid platform JWT is
 * present in the Authorization header, it verifies the token against the
 * platform and maps the platform tenant to the local QMBot tenant.
 */
const axios = require("axios");

const PLATFORM_URL = (process.env.PLATFORM_URL || "http://localhost:4000").replace(/\/+$/, "");
const VERIFY_TIMEOUT = 5000;

// Cache verified tokens for 5 minutes to reduce platform API calls
const tokenCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (now - entry.cachedAt > CACHE_TTL) tokenCache.delete(key);
  }
}
setInterval(cleanCache, 60 * 1000).unref();

/**
 * Verify a platform token against the /auth/verify endpoint.
 * Returns { valid, user, tenant } or { valid: false }.
 */
async function verifyPlatformToken(token) {
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached.result;
  }

  try {
    const res = await axios.get(`${PLATFORM_URL}/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: VERIFY_TIMEOUT,
    });

    const result = res.data;
    tokenCache.set(token, { result, cachedAt: Date.now() });
    return result;
  } catch {
    return { valid: false };
  }
}

/**
 * Express middleware that checks for a platform Bearer token.
 * If valid, sets req.platformUser and req.platformTenant.
 * Does NOT replace the existing tenant middleware — it augments it.
 */
function platformSSOMiddleware(prisma) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next();
    }

    const token = authHeader.slice(7);
    if (!token) return next();

    const result = await verifyPlatformToken(token);
    if (!result.valid || !result.tenant) {
      return next();
    }

    // Attach platform user context
    req.platformUser = result.user;
    req.platformTenant = result.tenant;

    // Try to map the platform tenant slug to a local QMBot tenant
    const slug = result.tenant.slug;
    if (slug) {
      const localTenant = await prisma.tenant.findFirst({
        where: {
          OR: [
            { subdomain: slug },
            { id: slug },
            { name: { equals: result.tenant.name, mode: "insensitive" } },
          ],
        },
      });

      if (localTenant) {
        req.tenantSlugOverride = localTenant.subdomain || localTenant.id;
      }
    }

    next();
  };
}

module.exports = { platformSSOMiddleware, verifyPlatformToken };
