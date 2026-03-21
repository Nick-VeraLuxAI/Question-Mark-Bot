/**
 * Content-Security-Policy strings for HTML shells (SOC 2 / XSS hardening).
 * Admin uses a per-request nonce on the single application script.
 */

function buildAdminPageCsp(nonce) {
  const esc = String(nonce).replace(/['";\s]/g, "");
  return [
    "default-src 'self'",
    `script-src 'nonce-${esc}'`,
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** Chat embed: external JS/CSS only; allow iframe embedding on customer sites. */
const EMBED_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors *",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

module.exports = { buildAdminPageCsp, EMBED_PAGE_CSP };
