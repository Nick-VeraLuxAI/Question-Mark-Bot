/**
 * Minimal bootstrap: ensures DEFAULT_TENANT (default: "default") exists.
 * Safe to run repeatedly (idempotent upsert on primary key).
 *
 * Client portal access: set SEED_TENANT_MEMBER_USER_ID to the platform SSO user id
 * that should manage the default tenant (optional SEED_TENANT_MEMBER_EMAIL).
 * Without a row in TenantMembership, that user will see "no access" on /admin/client
 * until your provisioning flow assigns memberships.
 */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const slug = String(process.env.DEFAULT_TENANT || "default").toLowerCase();

  await prisma.tenant.upsert({
    where: { id: slug },
    create: {
      id: slug,
      name: "Default",
      subdomain: slug,
      plan: "basic",
    },
    update: {
      name: "Default",
      subdomain: slug,
    },
  });

  const seedUserId = String(process.env.SEED_TENANT_MEMBER_USER_ID || "local-dev-user").trim();
  await prisma.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: slug, userId: seedUserId } },
    create: {
      tenantId: slug,
      userId: seedUserId,
      email: process.env.SEED_TENANT_MEMBER_EMAIL || null,
      role: "owner",
      status: "active",
    },
    update: {
      role: "owner",
      status: "active",
    },
  });

  console.log(`[seed] Upserted tenant id=${slug} subdomain=${slug}`);
  console.log(`[seed] Upserted TenantMembership userId=${seedUserId} tenantId=${slug}`);
}

main()
  .catch((e) => {
    console.error("[seed] Failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
