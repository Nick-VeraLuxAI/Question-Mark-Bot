const { calculateCost } = require("../pricing");

function chooseModel(tenant, message) {
  const settings = tenant?.settings || {};
  const policy = settings.modelPolicy || {};
  const defaultModel = policy.defaultModel || process.env.DEFAULT_MODEL || "gpt-4o-mini";
  const premiumModel = policy.premiumModel || "gpt-4o";

  if ((tenant?.plan || "").toLowerCase() === "enterprise" && String(message || "").length > 1200) {
    return premiumModel;
  }
  return defaultModel;
}

async function enforceMonthlyCap(prisma, tenantId, capUsd) {
  if (!capUsd || capUsd <= 0) return { ok: true, spent: 0 };
  const periodStart = new Date();
  periodStart.setUTCDate(1);
  periodStart.setUTCHours(0, 0, 0, 0);

  const usage = await prisma.usage.aggregate({
    where: { tenantId, createdAt: { gte: periodStart } },
    _sum: { cost: true },
  });
  const spent = Number(usage._sum.cost || 0);
  return { ok: spent < capUsd, spent };
}

function estimateTextCost(model, promptTokens, completionTokens, cachedTokens) {
  return calculateCost(model, promptTokens, completionTokens, cachedTokens);
}

module.exports = { chooseModel, enforceMonthlyCap, estimateTextCost };
