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

/** Reject obvious CSP injection; keep frame-ancestors tokens conservative. */
function sanitizeFrameAncestorsDirective(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "*";
  if (/[\r\n\x00<>]/.test(s) || s.length > 4000) return "*";
  return s;
}

/**
 * Chat embed CSP. Set CSP_EMBED_FRAME_ANCESTORS e.g. `https://app.customer.com https://*.customer.com`
 * for tighter CC6.x posture than `*`.
 */
function buildEmbedPageCsp() {
  const fa = sanitizeFrameAncestorsDirective(process.env.CSP_EMBED_FRAME_ANCESTORS);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    `frame-ancestors ${fa}`,
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** @deprecated use buildEmbedPageCsp() for env-aware frame-ancestors */
const EMBED_PAGE_CSP = buildEmbedPageCsp();

module.exports = { buildAdminPageCsp, buildEmbedPageCsp, EMBED_PAGE_CSP };
