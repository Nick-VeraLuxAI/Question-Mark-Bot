/**
 * Minimal bootstrap: ensures DEFAULT_TENANT (default: "default") exists.
 * Safe to run repeatedly (idempotent upsert on primary key).
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

  console.log(`[seed] Upserted tenant id=${slug} subdomain=${slug}`);
}

main()
  .catch((e) => {
    console.error("[seed] Failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
