/**
 * Strip operator-only and technical fields from pilot readiness for the client portal.
 */

function stripItemForClient(item) {
  if (!item || typeof item !== "object") return null;
  if (item.operatorOnly) return null;
  if (item.customerVisible === false) return null;
  const label = item.label != null ? String(item.label) : "";
  const message = item.message != null ? String(item.message) : "";
  const status = item.status != null ? String(item.status) : "warn";
  const group = item.group != null ? String(item.group) : undefined;
  const out = { label, message, status };
  if (group) out.group = group;
  return out;
}

/**
 * @param {ReturnType<typeof import("./pilotReadiness").computePilotReadiness>} full
 */
function toClientLaunchStatus(full) {
  const rawItems = full?.readiness?.items || [];
  const items = rawItems.map(stripItemForClient).filter(Boolean);
  const st = String(full?.readiness?.status || "needs_attention");
  const headline =
    st === "ready"
      ? "Ready to launch"
      : st === "operator_required"
        ? "Contact your operator"
        : "Needs setup";
  const summary =
    st === "ready"
      ? "Your assistant is in good shape to go live on your website."
      : st === "operator_required"
        ? "A few items need someone from your support team with full access."
        : "Complete the highlighted items before inviting customers.";

  return {
    headline,
    summary,
    status: st,
    score: full?.readiness?.score ?? 0,
    items,
  };
}

module.exports = { toClientLaunchStatus, stripItemForClient };
