function tokenize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 64);
}

function scoreOverlap(queryTokens, text) {
  const docTokens = new Set(tokenize(text));
  let score = 0;
  for (const tok of queryTokens) {
    if (docTokens.has(tok)) score += 1;
  }
  return score;
}

async function retrieveContext(prisma, tenantId, question, limit = 4) {
  const rows = await prisma.knowledgeChunk.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { document: true },
  });
  const qTokens = tokenize(question);
  const ranked = rows
    .map((row) => ({ row, score: scoreOverlap(qTokens, row.content) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked.map(({ row }) => ({
    documentTitle: row.document?.title || "Untitled",
    sourceUrl: row.document?.sourceUrl || "",
    content: row.content,
  }));
}

module.exports = { retrieveContext };
