async function loadConversationMemory(prisma, tenantId, sessionId, opts = {}) {
  const limit = Number(opts.limit || 8);
  const conversation = await prisma.conversation.findUnique({
    where: { tenantId_sessionId: { tenantId, sessionId } },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: limit,
      },
    },
  });
  if (!conversation) return { summary: "", messages: [] };
  return {
    summary: conversation.summary || "",
    messages: [...conversation.messages].reverse().map((m) => ({ role: m.role, content: m.content })),
  };
}

async function updateConversationSummary(prisma, tenantId, sessionId, latestUser, latestAssistant) {
  const base = `${String(latestUser || "").slice(0, 300)} => ${String(latestAssistant || "").slice(0, 300)}`;
  await prisma.conversation.update({
    where: { tenantId_sessionId: { tenantId, sessionId } },
    data: { summary: base, summaryUpdatedAt: new Date() },
  });
}

module.exports = { loadConversationMemory, updateConversationSummary };
