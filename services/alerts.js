function compare(op, observed, threshold) {
  if (op === "gt") return observed > threshold;
  if (op === "lte") return observed <= threshold;
  if (op === "lt") return observed < threshold;
  if (op === "eq") return observed === threshold;
  return observed >= threshold;
}

async function evaluateMetricAlerts(prisma, tenantId, metricName) {
  const rules = await prisma.alertRule.findMany({
    where: { tenantId, metricName, enabled: true },
  });
  if (!rules.length) return;

  for (const rule of rules) {
    const since = new Date(Date.now() - rule.windowSec * 1000);
    const agg = await prisma.metric.aggregate({
      where: { tenantId, name: metricName, createdAt: { gte: since } },
      _avg: { value: true },
    });
    const observed = Number(agg._avg.value || 0);
    if (!compare(rule.comparator, observed, rule.threshold)) continue;

    await prisma.alertIncident.create({
      data: {
        tenantId,
        ruleId: rule.id,
        metricName,
        observed,
        threshold: rule.threshold,
        status: "open",
      },
    });
  }
}

module.exports = { evaluateMetricAlerts };
