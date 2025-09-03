// scripts/encrypt_secrets.js
const { PrismaClient } = require('@prisma/client');
const { encrypt, isEncrypted } = require('../utils/kms');

const prisma = new PrismaClient();

async function run() {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, smtpPass: true, openaiKey: true, googleTokens: true }
  });

  let changed = 0;

  for (const t of tenants) {
    const data = {};

    // smtpPass
    if (t.smtpPass && !isEncrypted(t.smtpPass)) {
      data.smtpPass = encrypt(t.smtpPass);
    }

    // openaiKey
    if (t.openaiKey && !isEncrypted(t.openaiKey)) {
      data.openaiKey = encrypt(t.openaiKey);
    }

    // googleTokens (may be JSON or string)
    if (t.googleTokens) {
      const raw =
        typeof t.googleTokens === 'string'
          ? t.googleTokens
          : JSON.stringify(t.googleTokens);
      if (!isEncrypted(raw)) {
        data.googleTokens = encrypt(raw);
      }
    }

    if (Object.keys(data).length) {
      await prisma.tenant.update({ where: { id: t.id }, data });
      changed++;
    }
  }

  console.log(`✅ Done. Updated ${changed} tenant(s).`);
}

run()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
