/**
 * DB-backed idempotency for lead notification email (queue retries, duplicate jobs).
 */

async function leadAlreadyNotifiedByEmail(prisma, leadId) {
  if (!leadId) return false;
  const row = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { notificationEmailSentAt: true },
  });
  return Boolean(row?.notificationEmailSentAt);
}

/**
 * @returns {{ ok: true, skip?: boolean } | { ok: false, error: string }}
 */
async function assertLeadEligibleForNotificationEmail(prisma, leadId, tenantId) {
  if (!leadId) return { ok: true };
  const row = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { notificationEmailSentAt: true, tenantId: true },
  });
  if (!row) return { ok: true };
  if (row.tenantId !== tenantId) return { ok: false, error: "lead_tenant_mismatch" };
  if (row.notificationEmailSentAt) return { ok: true, skip: true };
  return { ok: true };
}

async function markLeadNotificationEmailSent(prisma, leadId) {
  if (!leadId) return;
  try {
    await prisma.lead.update({
      where: { id: leadId },
      data: { notificationEmailSentAt: new Date() },
    });
  } catch (err) {
    console.warn("markLeadNotificationEmailSent failed:", err.message);
  }
}

module.exports = {
  leadAlreadyNotifiedByEmail,
  assertLeadEligibleForNotificationEmail,
  markLeadNotificationEmailSent,
};
