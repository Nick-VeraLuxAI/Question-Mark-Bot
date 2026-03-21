function pickVariant(tenantId, key, variants) {
  if (!variants.length) return null;
  const seed = `${tenantId}:${key}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % variants.length;
  return variants[idx];
}

async function loadPromptBundle(prisma, tenantId, fallbackPrompts) {
  const versions = await prisma.promptVersion.findMany({
    where: { tenantId, isActive: true },
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
  const byKey = new Map();
  for (const row of versions) {
    const arr = byKey.get(row.key) || [];
    arr.push(row);
    byKey.set(row.key, arr);
  }

  const resolveKey = (key, fallback) => {
    const variants = byKey.get(key) || [];
    const chosen = pickVariant(tenantId, key, variants);
    return chosen?.content || fallback || "";
  };

  return {
    system: resolveKey("system", fallbackPrompts.system),
    policy: resolveKey("policy", fallbackPrompts.policy),
    voice: resolveKey("voice", fallbackPrompts.voice),
  };
}

module.exports = { loadPromptBundle };
