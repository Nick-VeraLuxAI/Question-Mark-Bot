const Tokens = require("csrf");

const tokens = new Tokens();

/**
 * SOC 2 / OWASP: state-changing /api/* requests that use the httpOnly platform_token
 * cookie must include a matching X-CSRF-Token from GET /api/security/csrf-token.
 *
 * Skipped when: no platform_token cookie, or Authorization: Bearer is sent (header auth).
 * Skipped for: health, inbound integration API key routes, csrf-token endpoint.
 */
function csrfProtectionForMutations(req, res, next) {
  if (process.env.DISABLE_CSRF === "1") return next();

  const m = req.method;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(m)) return next();
  if (!req.path.startsWith("/api/")) return next();

  const exemptPrefixes = [
    "/api/health",
    "/api/ready",
    "/api/security/csrf-token",
    "/api/integrations/v1/inbound",
  ];
  if (exemptPrefixes.some((p) => req.path.startsWith(p))) return next();

  if (!req.cookies?.platform_token) return next();

  const authz = req.headers.authorization || "";
  if (authz.startsWith("Bearer ")) return next();

  const secret = req.cookies.csrf_secret;
  const hdr = req.get("x-csrf-token");
  if (!secret || !hdr || !tokens.verify(secret, String(hdr))) {
    return res.status(403).json({
      error: "csrf_required",
      message:
        "Browser cookie sessions must send X-CSRF-Token from GET /api/security/csrf-token (or use Authorization: Bearer for API clients).",
    });
  }
  next();
}

function issueCsrfToken(req, res) {
  let secret = req.cookies?.csrf_secret;
  if (!secret || typeof secret !== "string" || secret.length < 10) {
    secret = tokens.secretSync();
  }
  const csrfToken = tokens.create(secret);
  const secure = process.env.NODE_ENV === "production";
  res.cookie("csrf_secret", secret, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: 15 * 60 * 1000,
  });
  res.json({ csrfToken });
}

module.exports = {
  tokens,
  csrfProtectionForMutations,
  issueCsrfToken,
};
