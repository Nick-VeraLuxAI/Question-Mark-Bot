const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertLeadEligibleForNotificationEmail,
  leadAlreadyNotifiedByEmail,
} = require("../../services/leadEmailIdempotency");

test("assertLeadEligible rejects tenant mismatch", async () => {
  const prisma = {
    lead: {
      findUnique: async () => ({
        tenantId: "t-a",
        notificationEmailSentAt: null,
      }),
    },
  };
  const r = await assertLeadEligibleForNotificationEmail(prisma, "lead1", "t-b");
  assert.equal(r.ok, false);
  assert.equal(r.error, "lead_tenant_mismatch");
});

test("assertLeadEligible skip when already sent", async () => {
  const prisma = {
    lead: {
      findUnique: async () => ({
        tenantId: "t-a",
        notificationEmailSentAt: new Date(),
      }),
    },
  };
  const r = await assertLeadEligibleForNotificationEmail(prisma, "lead1", "t-a");
  assert.equal(r.ok, true);
  assert.equal(r.skip, true);
});

test("leadAlreadyNotifiedByEmail false when no leadId", async () => {
  const r = await leadAlreadyNotifiedByEmail({}, null);
  assert.equal(r, false);
});
