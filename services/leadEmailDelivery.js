const nodemailer = require("nodemailer");
const { materializeTenantSecrets } = require("../utils/tenantSecrets");

/**
 * Send the standard lead notification email for one tenant.
 * @returns {{ ok: true, response?: string } | { skipped: true, reason: string } | { ok: false, error: string }}
 */
async function sendLeadNotificationMail(tenantRow, payload) {
  const tenant = materializeTenantSecrets(tenantRow);
  const { name, email, phone, tags, text } = payload;
  const tenantLabel = payload.tenantName || tenant?.name || tenant?.id || "";

  if (!tenant?.smtpHost || !tenant?.smtpUser) {
    return { skipped: true, reason: "smtp_not_configured" };
  }

  const port = Number(tenant.smtpPort ?? 587);
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host: tenant.smtpHost,
    port,
    secure,
    requireTLS: !secure,
    auth: {
      user: tenant.smtpUser,
      pass: tenant.smtpPass,
    },
    tls: secure ? undefined : { minVersion: "TLSv1.2" },
  });

  const tagList = Array.isArray(tags) ? tags : [];
  const mailOptions = {
    from: tenant.emailFrom || tenant.smtpUser,
    to: tenant.emailTo || tenant.smtpUser,
    subject: `New consultation request (${tenantLabel})`,
    text:
      "New lead captured:\n\n" +
      `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n` +
      `Tags: ${tagList.join(", ")}\n\n` +
      `Original message: ${text}`,
    html: `<p><strong>New lead</strong> (${escapeHtml(tenantLabel)})</p>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
<tr><td style="padding:4px 12px 4px 0"><strong>Name</strong></td><td>${escapeHtml(String(name))}</td></tr>
<tr><td style="padding:4px 12px 4px 0"><strong>Email</strong></td><td>${escapeHtml(String(email))}</td></tr>
<tr><td style="padding:4px 12px 4px 0"><strong>Phone</strong></td><td>${escapeHtml(String(phone))}</td></tr>
<tr><td style="padding:4px 12px 4px 0"><strong>Tags</strong></td><td>${escapeHtml(tagList.join(", "))}</td></tr>
</table>
<p style="margin-top:12px"><strong>Message</strong></p>
<pre style="white-space:pre-wrap;font-size:13px;background:#f4f4f4;padding:12px;border-radius:8px">${escapeHtml(String(text).slice(0, 8000))}</pre>`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return { ok: true, response: info.response };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { sendLeadNotificationMail };
