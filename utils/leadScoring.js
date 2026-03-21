function scoreLead({ message, source, hasEmail, hasPhone, tags = [] }) {
  let score = 0;
  if (source === "contact") score += 45;
  if (hasEmail) score += 20;
  if (hasPhone) score += 20;
  score += Math.min(15, (Array.isArray(tags) ? tags.length : 0) * 5);
  if (String(message || "").length > 120) score += 5;

  let status = "new";
  if (score >= 75) status = "qualified";
  else if (score >= 45) status = "engaged";

  return { score, status };
}

module.exports = { scoreLead };
