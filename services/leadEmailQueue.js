const { enqueue } = require("../utils/jobQueue");
const { materializeTenantSecrets } = require("../utils/tenantSecrets");
const { sendLeadNotificationMail } = require("./leadEmailDelivery");
const {
  leadAlreadyNotifiedByEmail,
  markLeadNotificationEmailSent,
} = require("./leadEmailIdempotency");

const TENANT_EMAIL_SELECT = {
  id: true,
  name: true,
  smtpHost: true,
  smtpPort: true,
  smtpUser: true,
  smtpPass: true,
  emailFrom: true,
  emailTo: true,
};

/**
 * Queue a lead notification email (BullMQ), or send synchronously if Redis is down.
 * Skips when SMTP is not configured for the tenant.
 */
async function enqueueLeadNotificationEmail(prisma, { tenantId, leadId, payload }) {
  const tenantRow = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: TENANT_EMAIL_SELECT,
  });

  if (!tenantRow?.smtpHost || !tenantRow?.smtpUser) {
    return { skipped: true, reason: "smtp_not_configured" };
  }

  if (leadId && (await leadAlreadyNotifiedByEmail(prisma, leadId))) {
    return { skipped: true, reason: "already_sent" };
  }

  const jobPayload = {
    tenantId,
    leadId: leadId || null,
    name: payload.name,
    email: payload.email,
    phone: payload.phone,
    tags: payload.tags,
    text: payload.text,
    score: payload.score,
    status: payload.status,
  };

  const jobId = leadId ? `lead-email:${leadId}` : undefined;
  const queued = await enqueue("events", "lead-notification-email", jobPayload, {
    attempts: Number(process.env.LEAD_EMAIL_JOB_ATTEMPTS || 6),
    backoff: { type: "exponential", delay: Number(process.env.LEAD_EMAIL_BACKOFF_MS || 3000) },
    jobId,
  });

  if (!queued) {
    const dec = materializeTenantSecrets(tenantRow);
    const sync = await sendLeadNotificationMail(dec, {
      ...payload,
      tenantName: tenantRow.name,
    });
    if (sync.ok) {
      await markLeadNotificationEmailSent(prisma, leadId);
    }
    return { queued: false, sync };
  }

  return { queued: true };
}

module.exports = { enqueueLeadNotificationEmail, TENANT_EMAIL_SELECT };
