/**
 * Client portal API — tenant access is enforced via TenantMembership (see middleware/clientPortal.js).
 * Mirrors a subset of /api/admin/* and /api/integrations/* with membership-scoped roles.
 */

const { toClientLaunchStatus } = require("../utils/clientLaunchStatus");
const { hasPermission } = require("../middleware/rbac");

const KNOWLEDGE_CHUNK_MAX = 2500;
const ADMIN_KNOWLEDGE_MAX_TITLE = 500;
const ADMIN_KNOWLEDGE_MAX_SOURCE = 2000;
const ADMIN_KNOWLEDGE_MAX_CONTENT = 100000;

function splitKnowledgeContent(raw) {
  const text = String(raw || "");
  if (!text.length) return [""];
  const parts = [];
  for (let i = 0; i < text.length; i += KNOWLEDGE_CHUNK_MAX) {
    parts.push(text.slice(i, i + KNOWLEDGE_CHUNK_MAX));
  }
  return parts;
}

function assertAllowedWebhookUrl(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint).trim());
  } catch {
    return { error: "invalid_endpoint" };
  }
  const host = url.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !isLocal) {
    return { error: "https_required" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "invalid_endpoint" };
  }
  return { ok: true };
}

function attachClientPortalRoutes(app, deps) {
  const {
    prisma,
    requirePlatformAuth,
    platformOperatorCapable,
    loadClientTenant,
    assertTenantAccess,
    requireClientPermission,
    authLimiter,
    writeAudit,
    retrieveContext,
    getBehaviorForGet,
    mergeBehaviorIncoming,
    validateAndNormalizeBehaviorPatch,
    getBusinessProfileForGet,
    mergeBusinessProfileIncoming,
    validateAndNormalizeBusinessProfilePatch,
    computePilotReadiness,
    verifyTenantForAdmin,
    getAdminServerHints,
    normalizeEmbedTheme,
    clipCssishToken,
    BRANDING_COLUMNS,
    listEventTypes,
    INTEGRATION_SCHEMA_VERSION,
    sendGenericWebhook,
    parseAdminListPagination,
    adminSearchText,
    parseOptionalIsoDate,
    normalizeRole,
  } = deps;

  app.get("/api/client/me", requirePlatformAuth, async (req, res) => {
    try {
      const userId = String(req.platformUser?.id || "");
      const platformRole = normalizeRole(req.platformUser?.role);
      const canUseOperatorPortal =
        Boolean(platformOperatorCapable(platformRole)) || hasPermission(platformRole, "tenants:provision");

      const memberships = await prisma.tenantMembership.findMany({
        where: { userId, status: "active" },
        include: { tenant: { select: { id: true, name: true, subdomain: true, plan: true } } },
        orderBy: { createdAt: "asc" },
      });

      const allowedTenants = memberships.map((m) => ({
        slug: m.tenant.subdomain || m.tenant.id,
        displayName: m.tenant.name,
        role: m.role,
        status: m.status,
      }));

      const superBypass =
        process.env.ALLOW_PLATFORM_SUPER_ADMIN_ALL_TENANTS === "1" &&
        (platformRole === "owner" || platformRole === "admin");

      let currentTenant = null;
      let membership = null;
      if (memberships.length === 1) {
        const m = memberships[0];
        currentTenant = {
          slug: m.tenant.subdomain || m.tenant.id,
          displayName: m.tenant.name,
          status: m.status,
        };
        membership = { role: m.role, status: m.status };
      } else if (superBypass && req.platformTenant?.slug) {
        const slug = String(req.platformTenant.slug).toLowerCase();
        const row = await prisma.tenant.findFirst({
          where: { OR: [{ subdomain: slug }, { id: slug }] },
          select: { id: true, name: true, subdomain: true, plan: true },
        });
        if (row) {
          currentTenant = { slug: row.subdomain || row.id, displayName: row.name, status: "active" };
          membership = { role: platformRole, status: "active" };
        }
      }

      const siteRole = membership?.role != null ? String(membership.role) : platformRole;
      res.json({
        signedIn: true,
        id: userId || null,
        email: req.platformUser?.email != null ? String(req.platformUser.email) : null,
        role: siteRole,
        user: {
          id: userId,
          email: req.platformUser?.email != null ? String(req.platformUser.email) : null,
          platformRole,
        },
        portalMode: "client",
        currentTenant,
        membership,
        allowedTenants,
        canUseOperatorPortal,
      });
    } catch (e) {
      console.error("client me", e);
      res.status(500).json({ error: "client_me_failed" });
    }
  });

  const clientReadCfg = [requirePlatformAuth, loadClientTenant, assertTenantAccess, requireClientPermission("config:read")];
  const clientReadStats = [requirePlatformAuth, loadClientTenant, assertTenantAccess, requireClientPermission("stats:read")];
  const clientWriteCfg = [authLimiter, requirePlatformAuth, loadClientTenant, assertTenantAccess, requireClientPermission("config:write")];
  const clientReadFunnel = [requirePlatformAuth, loadClientTenant, assertTenantAccess, requireClientPermission("funnel:read")];

  app.get("/api/client/stats", ...clientReadStats, async (req, res) => {
    const tenantId = req.tenantId;
    try {
      const [conversations, leads, messages, recentUsage] = await Promise.all([
        prisma.conversation.count({ where: { tenantId } }),
        prisma.lead.count({ where: { tenantId } }),
        prisma.message.count({ where: { conversation: { tenantId } } }),
        prisma.usage.aggregate({
          where: { tenantId, createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
          _sum: { promptTokens: true, completionTokens: true, cost: true },
          _count: true,
        }),
      ]);
      await writeAudit(prisma, req, {
        action: "client.stats.read",
        resource: "tenant_stats",
        outcome: "ok",
        details: { tenantId },
      });
      res.json({
        conversations,
        leads,
        messages,
        usage30d: {
          requests: recentUsage._count,
          promptTokens: recentUsage._sum.promptTokens ?? 0,
          completionTokens: recentUsage._sum.completionTokens ?? 0,
          cost: recentUsage._sum.cost ?? 0,
        },
      });
    } catch (err) {
      console.error("client stats", err);
      res.status(500).json({ error: "stats_failed" });
    }
  });

  app.get("/api/client/config", ...clientReadCfg, async (req, res) => {
    const t = req.tenant;
    if (!t) return res.status(404).json({ error: "tenant_not_found" });
    await writeAudit(prisma, req, {
      action: "client.config.read",
      resource: "tenant_config",
      outcome: "ok",
      details: { tenantId: t.id },
    });
    res.json({
      name: t.name,
      subdomain: t.subdomain,
      hasOpenAIKey: !!t.openaiKey,
      hasSmtpConfig: !!(t.smtpHost && t.smtpUser),
      hasGoogleOAuth: !!t.googleClientId,
      branding: {
        brandColor: t.brandColor,
        brandHover: t.brandHover,
        fontFamily: t.fontFamily,
        watermarkUrl: t.watermarkUrl,
      },
    });
  });

  app.get("/api/client/verify", ...clientReadCfg, async (req, res) => {
    try {
      const sh = getAdminServerHints();
      const slug = req.tenant?.subdomain || req.tenant?.id || req.tenantId;
      const v = await verifyTenantForAdmin(prisma, slug, undefined, {
        globalOpenaiConfigured: sh.globalOpenaiConfigured,
        openaiBootOptional: sh.openaiBootOptional,
      });
      if (!v.ok) {
        return res.status(404).json({ ok: false, readyForChat: false });
      }
      res.json({ ok: true, readyForChat: Boolean(v.readyForChat) });
    } catch (err) {
      console.error("client verify", err);
      res.status(500).json({ error: "verify_failed" });
    }
  });

  app.get("/api/client/pilot-readiness", ...clientReadCfg, async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const slug = req.tenant?.subdomain || req.tenant?.id || tenantId;
      const sh = getAdminServerHints();
      const verify = await verifyTenantForAdmin(prisma, slug, undefined, {
        globalOpenaiConfigured: sh.globalOpenaiConfigured,
        openaiBootOptional: sh.openaiBootOptional,
      });
      const readyForChat = verify.ok ? Boolean(verify.readyForChat) : false;
      const [activeKnowledgeCount, conversationCount, leadCount, webhookEnabledCount] = await Promise.all([
        prisma.knowledgeDocument.count({ where: { tenantId, status: "active" } }),
        prisma.conversation.count({ where: { tenantId } }),
        prisma.lead.count({ where: { tenantId } }),
        prisma.leadWebhook.count({ where: { tenantId, enabled: true } }),
      ]);
      const integrationKeyConfigured = Boolean(req.tenant?.apiKeyHash);
      const hideDev =
        process.env.NODE_ENV === "production" && process.env.ALLOW_ADMIN_BEARER_DEV_TOOLS !== "1";
      const roleForPilot = normalizeRole(req.effectiveTenantRole);
      const full = computePilotReadiness({
        tenant: req.tenant,
        readyForChat,
        verify,
        activeKnowledgeCount,
        conversationCount,
        leadCount,
        webhookEnabledCount,
        integrationKeyConfigured,
        role: roleForPilot,
        devToolsHiddenInProd: hideDev,
      });
      const launch = toClientLaunchStatus(full);
      await writeAudit(prisma, req, {
        action: "client.launch_status.read",
        resource: "tenant_readiness",
        outcome: "ok",
        details: { tenantId, status: launch.status },
      });
      res.json({ launch });
    } catch (err) {
      console.error("client pilot_readiness", err);
      res.status(500).json({ error: "pilot_readiness_failed" });
    }
  });

  app.get("/api/client/knowledge", ...clientReadCfg, async (req, res) => {
    const tenantId = req.tenantId;
    const { limit, offset } = parseAdminListPagination(req);
    const q = adminSearchText(req);
    const where = {
      tenantId,
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { content: { contains: q, mode: "insensitive" } },
              { sourceUrl: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    try {
      const [total, rows] = await Promise.all([
        prisma.knowledgeDocument.count({ where }),
        prisma.knowledgeDocument.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            title: true,
            sourceUrl: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { chunks: true } },
            chunks: { orderBy: { idx: "asc" }, take: 1, select: { content: true } },
          },
        }),
      ]);
      const items = rows.map((row) => {
        const first = row.chunks[0]?.content || "";
        const preview = first.slice(0, 220);
        return {
          id: row.id,
          title: row.title,
          source: row.sourceUrl || "",
          status: row.status,
          chunkCount: row._count.chunks,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          preview: preview + (first.length > 220 ? "…" : ""),
        };
      });
      await writeAudit(prisma, req, {
        action: "client.knowledge.list",
        resource: "knowledge_document",
        outcome: "ok",
        details: { tenantId, limit, offset },
      });
      res.json({ items, total, limit, offset });
    } catch (err) {
      console.error("client knowledge list", err);
      res.status(500).json({ error: "knowledge_list_failed" });
    }
  });

  app.get("/api/client/knowledge/:id", ...clientReadCfg, async (req, res) => {
    const tenantId = req.tenantId;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });
    try {
      const doc = await prisma.knowledgeDocument.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          title: true,
          sourceUrl: true,
          status: true,
          content: true,
          createdAt: true,
          updatedAt: true,
          chunks: { orderBy: { idx: "asc" }, select: { id: true, content: true, createdAt: true } },
        },
      });
      if (!doc) return res.status(404).json({ error: "not_found" });
      await writeAudit(prisma, req, {
        action: "client.knowledge.read",
        resource: "knowledge_document",
        resourceId: id,
        outcome: "ok",
        details: { tenantId },
      });
      res.json({
        id: doc.id,
        title: doc.title,
        source: doc.sourceUrl || "",
        status: doc.status,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        content: doc.content,
        chunks: doc.chunks,
      });
    } catch (err) {
      console.error("client knowledge read", err);
      res.status(500).json({ error: "knowledge_read_failed" });
    }
  });

  app.get("/api/client/knowledge-retrieval", ...clientReadCfg, async (req, res) => {
    const tenantId = req.tenantId;
    const q = String(req.query.q ?? "").trim().slice(0, 500);
    if (!q) return res.status(400).json({ error: "q_required" });
    try {
      const matches = await retrieveContext(prisma, tenantId, q, 8);
      res.json({
        query: q,
        matches: matches.map((m) => ({
          documentTitle: m.documentTitle,
          source: m.sourceUrl || "",
          excerpt: (m.content || "").slice(0, 900),
        })),
      });
    } catch (err) {
      console.error("client knowledge retrieval", err);
      res.status(500).json({ error: "knowledge_retrieval_failed" });
    }
  });

  app.post("/api/client/knowledge", ...clientWriteCfg, async (req, res) => {
    const tenantId = req.tenantId;
    const body = req.body || {};
    const title = String(body.title ?? "").trim();
    const content = String(body.content ?? "");
    const source = body.source != null ? String(body.source).trim() : "";
    if (!title) return res.status(400).json({ error: "title_required" });
    if (!content.trim()) return res.status(400).json({ error: "content_required" });
    if (title.length > ADMIN_KNOWLEDGE_MAX_TITLE) return res.status(400).json({ error: "title_too_long" });
    if (source.length > ADMIN_KNOWLEDGE_MAX_SOURCE) return res.status(400).json({ error: "source_too_long" });
    if (content.length > ADMIN_KNOWLEDGE_MAX_CONTENT) return res.status(400).json({ error: "content_too_long" });
    const parts = splitKnowledgeContent(content);
    try {
      const created = await prisma.$transaction(async (tx) => {
        const doc = await tx.knowledgeDocument.create({
          data: { tenantId, title, sourceUrl: source || null, content, status: "active" },
        });
        await tx.knowledgeChunk.createMany({
          data: parts.map((c, idx) => ({ tenantId, documentId: doc.id, idx, content: c })),
        });
        return doc;
      });
      await writeAudit(prisma, req, {
        action: "client.knowledge.create",
        resource: "knowledge_document",
        resourceId: created.id,
        outcome: "ok",
        details: { tenantId },
      });
      res.status(201).json({
        id: created.id,
        title: created.title,
        source: created.sourceUrl || "",
        status: created.status,
        chunkCount: parts.length,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        preview: (parts[0] || "").slice(0, 220) + ((parts[0] || "").length > 220 ? "…" : ""),
      });
    } catch (err) {
      console.error("client knowledge create", err);
      res.status(500).json({ error: "knowledge_create_failed" });
    }
  });

  app.patch("/api/client/knowledge/:id", ...clientWriteCfg, async (req, res) => {
    const tenantId = req.tenantId;
    const id = String(req.params.id || "").trim();
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const nextStatus = String(body.status ?? "").trim().toLowerCase();
    if (!id) return res.status(400).json({ error: "id_required" });
    if (!["active", "archived"].includes(nextStatus)) {
      return res.status(400).json({ error: "invalid_status", allowed: ["active", "archived"] });
    }
    try {
      const existing = await prisma.knowledgeDocument.findFirst({ where: { id, tenantId }, select: { id: true } });
      if (!existing) return res.status(404).json({ error: "not_found" });
      const upd = await prisma.knowledgeDocument.updateMany({ where: { id, tenantId }, data: { status: nextStatus } });
      if (upd.count === 0) return res.status(404).json({ error: "not_found" });
      const updated = await prisma.knowledgeDocument.findFirst({
        where: { id, tenantId },
        select: { id: true, title: true, sourceUrl: true, status: true, updatedAt: true, _count: { select: { chunks: true } } },
      });
      await writeAudit(prisma, req, {
        action: "client.knowledge.patch",
        resource: "knowledge_document",
        resourceId: id,
        outcome: "ok",
        details: { tenantId, status: nextStatus },
      });
      res.json({
        id: updated.id,
        title: updated.title,
        source: updated.sourceUrl || "",
        status: updated.status,
        chunkCount: updated._count.chunks,
        updatedAt: updated.updatedAt,
      });
    } catch (err) {
      console.error("client knowledge patch", err);
      res.status(500).json({ error: "knowledge_patch_failed" });
    }
  });

  app.delete("/api/client/knowledge/:id", ...clientWriteCfg, async (req, res) => {
    const tenantId = req.tenantId;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });
    try {
      const deleted = await prisma.$transaction(async (tx) => {
        await tx.knowledgeChunk.deleteMany({ where: { documentId: id, tenantId } });
        return tx.knowledgeDocument.deleteMany({ where: { id, tenantId } });
      });
      if (deleted.count === 0) return res.status(404).json({ error: "not_found" });
      await writeAudit(prisma, req, {
        action: "client.knowledge.delete",
        resource: "knowledge_document",
        resourceId: id,
        outcome: "ok",
        details: { tenantId },
      });
      res.status(204).send();
    } catch (err) {
      console.error("client knowledge delete", err);
      res.status(500).json({ error: "knowledge_delete_failed" });
    }
  });

  app.get("/api/client/bot-behavior", ...clientReadCfg, async (req, res) => {
    try {
      const payload = getBehaviorForGet(req.tenant?.settings);
      await writeAudit(prisma, req, {
        action: "client.bot_behavior.read",
        resource: "tenant_settings",
        outcome: "ok",
        details: { tenantId: req.tenantId },
      });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: "bot_behavior_read_failed" });
    }
  });

  app.patch("/api/client/bot-behavior", ...clientWriteCfg, async (req, res) => {
    const tenantId = req.tenantId;
    const behaviorIn = req.body && req.body.behavior;
    const merged = mergeBehaviorIncoming(req.tenant?.settings, behaviorIn);
    const v = validateAndNormalizeBehaviorPatch(merged);
    if (!v.ok) return res.status(v.status).json({ error: "validation_failed", details: v.errors });
    try {
      const prevSettings = req.tenant?.settings;
      const base =
        prevSettings && typeof prevSettings === "object" && !Array.isArray(prevSettings)
          ? JSON.parse(JSON.stringify(prevSettings))
          : {};
      base.behavior = v.normalized;
      await prisma.tenant.update({ where: { id: tenantId }, data: { settings: base } });
      await writeAudit(prisma, req, {
        action: "client.bot_behavior.update",
        resource: "tenant_settings",
        outcome: "ok",
        details: { tenantId },
      });
      res.json(getBehaviorForGet(base));
    } catch (err) {
      res.status(500).json({ error: "bot_behavior_update_failed" });
    }
  });

  app.get("/api/client/business-profile", ...clientReadCfg, async (req, res) => {
    try {
      const payload = getBusinessProfileForGet(req.tenant?.settings);
      await writeAudit(prisma, req, {
        action: "client.business_profile.read",
        resource: "tenant_settings",
        outcome: "ok",
        details: { tenantId: req.tenantId },
      });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: "business_profile_read_failed" });
    }
  });

  app.patch("/api/client/business-profile", ...clientWriteCfg, async (req, res) => {
    const tenantId = req.tenantId;
    const profileIn = req.body && req.body.businessProfile;
    const merged = mergeBusinessProfileIncoming(req.tenant?.settings, profileIn);
    const v = validateAndNormalizeBusinessProfilePatch(merged);
    if (!v.ok) return res.status(v.status).json({ error: "validation_failed", details: v.errors });
    try {
      const prevSettings = req.tenant?.settings;
      const base =
        prevSettings && typeof prevSettings === "object" && !Array.isArray(prevSettings)
          ? JSON.parse(JSON.stringify(prevSettings))
          : {};
      base.businessProfile = v.normalized;
      await prisma.tenant.update({ where: { id: tenantId }, data: { settings: base } });
      await writeAudit(prisma, req, {
        action: "client.business_profile.update",
        resource: "tenant_settings",
        outcome: "ok",
        details: { tenantId },
      });
      res.json(getBusinessProfileForGet(base));
    } catch (err) {
      res.status(500).json({ error: "business_profile_update_failed" });
    }
  });

  app.get("/api/client/conversations", ...clientReadFunnel, async (req, res) => {
    const tenantId = req.tenantId;
    const { limit, offset } = parseAdminListPagination(req);
    const q = adminSearchText(req);
    const from = parseOptionalIsoDate(req.query.from);
    const to = parseOptionalIsoDate(req.query.to);
    const where = {
      tenantId,
      ...(from || to ? { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(q
        ? {
            OR: [
              { summary: { contains: q, mode: "insensitive" } },
              { sessionId: { contains: q, mode: "insensitive" } },
              { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : {}),
    };
    try {
      const [total, rows] = await Promise.all([
        prisma.conversation.count({ where }),
        prisma.conversation.findMany({
          where,
          orderBy: { startedAt: "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            sessionId: true,
            startedAt: true,
            endedAt: true,
            summary: true,
            summaryUpdatedAt: true,
            _count: { select: { messages: true } },
            messages: { orderBy: { createdAt: "desc" }, take: 80, select: { role: true, content: true, createdAt: true } },
          },
        }),
      ]);
      const items = rows.map((row) => {
        let lastUser = "";
        let lastAssistant = "";
        let lastAt = row.startedAt;
        for (const m of row.messages) {
          if (new Date(m.createdAt) > new Date(lastAt)) lastAt = m.createdAt;
          const role = String(m.role || "").toLowerCase();
          if (!lastUser && role === "user") lastUser = m.content || "";
          if (!lastAssistant && role === "assistant") lastAssistant = m.content || "";
          if (lastUser && lastAssistant) break;
        }
        const updatedAt = row.summaryUpdatedAt || lastAt;
        return {
          id: row.id,
          createdAt: row.startedAt,
          updatedAt,
          messageCount: row._count.messages,
          lastMessageAt: lastAt,
          lastUserMessage: lastUser.slice(0, 500),
          lastAssistantMessage: lastAssistant.slice(0, 500),
          leadCount: 0,
          channel: null,
          source: null,
        };
      });
      await writeAudit(prisma, req, {
        action: "client.conversations.list",
        resource: "conversation",
        outcome: "ok",
        details: { tenantId },
      });
      res.json({ items, total, limit, offset });
    } catch (err) {
      res.status(500).json({ error: "conversations_list_failed" });
    }
  });

  app.get("/api/client/conversations/:id", ...clientReadFunnel, async (req, res) => {
    const tenantId = req.tenantId;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });
    try {
      const convo = await prisma.conversation.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          sessionId: true,
          startedAt: true,
          endedAt: true,
          summary: true,
          summaryUpdatedAt: true,
        },
      });
      if (!convo) return res.status(404).json({ error: "not_found" });
      const messages = await prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "asc" },
        take: 500,
        select: { id: true, role: true, content: true, createdAt: true },
      });
      const lastMsg = messages.length ? messages[messages.length - 1].createdAt : convo.startedAt;
      const updatedAt = convo.summaryUpdatedAt || lastMsg;
      await writeAudit(prisma, req, {
        action: "client.conversations.read",
        resource: "conversation",
        resourceId: id,
        outcome: "ok",
        details: { tenantId },
      });
      res.json({
        id: convo.id,
        createdAt: convo.startedAt,
        updatedAt,
        sessionId: convo.sessionId,
        messages,
        leads: [],
      });
    } catch (err) {
      res.status(500).json({ error: "conversation_read_failed" });
    }
  });

  app.get("/api/client/leads", ...clientReadFunnel, async (req, res) => {
    const tenantId = req.tenantId;
    const { limit, offset } = parseAdminListPagination(req);
    const q = adminSearchText(req);
    const from = parseOptionalIsoDate(req.query.from);
    const to = parseOptionalIsoDate(req.query.to);
    const where = {
      tenantId,
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
              { snippet: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    try {
      const [total, rows] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            source: true,
            status: true,
            createdAt: true,
            score: true,
          },
        }),
      ]);
      const items = rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        source: r.source,
        status: r.status,
        createdAt: r.createdAt,
        conversationId: null,
      }));
      await writeAudit(prisma, req, {
        action: "client.leads.list",
        resource: "lead",
        outcome: "ok",
        details: { tenantId },
      });
      res.json({ items, total, limit, offset });
    } catch (err) {
      res.status(500).json({ error: "leads_list_failed" });
    }
  });

  app.get("/api/client/branding", ...clientReadCfg, async (req, res) => {
    const t = req.tenant;
    if (!t) return res.status(404).json({ error: "tenant_not_found" });
    const branding = t.branding && typeof t.branding === "object" ? t.branding : {};
    const settings = t.settings && typeof t.settings === "object" ? t.settings : {};
    await writeAudit(prisma, req, {
      action: "client.branding.read",
      resource: "tenant_branding",
      outcome: "ok",
      details: { tenantId: t.id },
    });
    res.json({
      brandColor: t.brandColor,
      brandHover: t.brandHover,
      botBg: t.botBg,
      botText: t.botText,
      userBg: t.userBg,
      userText: t.userText,
      glassBg: t.glassBg,
      glassTop: t.glassTop,
      blurPx: t.blurPx,
      headerGlow: t.headerGlow,
      watermarkUrl: t.watermarkUrl,
      fontFamily: t.fontFamily,
      branding,
      appearance: (() => {
        const ap = settings.appearance && typeof settings.appearance === "object" ? settings.appearance : {};
        return { ...ap, theme: normalizeEmbedTheme(ap.theme) };
      })(),
    });
  });

  app.patch("/api/client/branding", ...clientWriteCfg, async (req, res) => {
    const t = req.tenant;
    if (!t) return res.status(404).json({ error: "tenant_not_found" });
    const body = req.body || {};
    const data = {};
    for (const key of BRANDING_COLUMNS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const raw = body[key];
      if (raw === "" || raw === null) {
        data[key] = null;
        continue;
      }
      const v = clipCssishToken(raw, key === "headerGlow" ? 1200 : 600);
      data[key] = v;
    }
    if (body.branding !== undefined && body.branding !== null && typeof body.branding === "object") {
      const cur = t.branding && typeof t.branding === "object" ? { ...t.branding } : {};
      for (const [k, v] of Object.entries(body.branding)) {
        if (typeof v === "string") cur[k] = clipCssishToken(v, 2000);
        else if (typeof v === "number" && Number.isFinite(v)) cur[k] = v;
        else if (typeof v === "boolean") cur[k] = v;
      }
      data.branding = cur;
    }
    if (body.appearance !== undefined && body.appearance !== null && typeof body.appearance === "object") {
      const curSettings = t.settings && typeof t.settings === "object" ? { ...t.settings } : {};
      const curApp =
        curSettings.appearance && typeof curSettings.appearance === "object" ? { ...curSettings.appearance } : {};
      const nextApp = { ...curApp };
      for (const [k, v] of Object.entries(body.appearance)) {
        if (k === "theme") nextApp.theme = normalizeEmbedTheme(v);
        else if (typeof v === "string") nextApp[k] = clipCssishToken(v, 240);
        else if (typeof v === "number" && Number.isFinite(v)) nextApp[k] = v;
        else if (typeof v === "boolean") nextApp[k] = v;
      }
      nextApp.theme = normalizeEmbedTheme(nextApp.theme);
      curSettings.appearance = nextApp;
      data.settings = curSettings;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "no_valid_fields" });
    await prisma.tenant.update({ where: { id: t.id }, data });
    await writeAudit(prisma, req, {
      action: "client.branding.update",
      resource: "tenant_branding",
      outcome: "ok",
      details: { tenantId: t.id },
    });
    res.json({ ok: true });
  });

  app.get("/api/client/webhooks/meta", requirePlatformAuth, loadClientTenant, assertTenantAccess, requireClientPermission("config:read"), (_req, res) => {
    res.json({ schemaVersion: INTEGRATION_SCHEMA_VERSION, eventTypes: listEventTypes() });
  });

  app.get("/api/client/webhooks", ...clientReadCfg, async (req, res) => {
    const rows = await prisma.leadWebhook.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, endpoint: true, enabled: true, events: true, createdAt: true },
    });
    res.json({ webhooks: rows });
  });

  app.post("/api/client/webhooks", ...clientWriteCfg, async (req, res) => {
    const body = req.body || {};
    const endpoint = String(body.endpoint || "").trim();
    if (!endpoint) return res.status(400).json({ error: "endpoint_required" });
    const chk = assertAllowedWebhookUrl(endpoint);
    if (chk.error) return res.status(400).json({ error: chk.error });
    const enabled = body.enabled !== false;
    const events = Array.isArray(body.events)
      ? body.events.filter((e) => typeof e === "string").map((e) => e.slice(0, 128)).slice(0, 32)
      : [];
    const secret =
      body.secret === undefined || body.secret === null || body.secret === ""
        ? null
        : String(body.secret).slice(0, 512);
    const row = await prisma.leadWebhook.create({
      data: {
        tenantId: req.tenantId,
        endpoint: endpoint.slice(0, 2048),
        secret,
        enabled,
        events,
      },
      select: { id: true, endpoint: true, enabled: true, events: true, createdAt: true },
    });
    await writeAudit(prisma, req, {
      action: "client.webhook.create",
      resource: "lead_webhook",
      resourceId: row.id,
      outcome: "ok",
    });
    res.status(201).json({ webhook: row });
  });

  app.patch("/api/client/webhooks/:id", ...clientWriteCfg, async (req, res) => {
    const { id } = req.params;
    const existing = await prisma.leadWebhook.findFirst({ where: { id, tenantId: req.tenantId } });
    if (!existing) return res.status(404).json({ error: "not_found" });
    const body = req.body || {};
    const data = {};
    if (typeof body.endpoint === "string") {
      const ep = body.endpoint.trim();
      const chk = assertAllowedWebhookUrl(ep);
      if (chk.error) return res.status(400).json({ error: chk.error });
      data.endpoint = ep.slice(0, 2048);
    }
    if (typeof body.enabled === "boolean") data.enabled = body.enabled;
    if (Array.isArray(body.events)) {
      data.events = body.events.filter((e) => typeof e === "string").map((e) => e.slice(0, 128)).slice(0, 32);
    }
    if (body.secret === null) data.secret = null;
    else if (typeof body.secret === "string" && body.secret.length > 0) {
      data.secret = String(body.secret).slice(0, 512);
    }
    const upd = await prisma.leadWebhook.updateMany({ where: { id, tenantId: req.tenantId }, data });
    if (upd.count === 0) return res.status(404).json({ error: "not_found" });
    const row = await prisma.leadWebhook.findFirst({
      where: { id, tenantId: req.tenantId },
      select: { id: true, endpoint: true, enabled: true, events: true, createdAt: true },
    });
    await writeAudit(prisma, req, {
      action: "client.webhook.update",
      resource: "lead_webhook",
      resourceId: id,
      outcome: "ok",
    });
    res.json({ webhook: row });
  });

  app.delete("/api/client/webhooks/:id", ...clientWriteCfg, async (req, res) => {
    const { id } = req.params;
    const existing = await prisma.leadWebhook.findFirst({ where: { id, tenantId: req.tenantId } });
    if (!existing) return res.status(404).json({ error: "not_found" });
    await prisma.leadWebhook.delete({ where: { id } });
    await writeAudit(prisma, req, {
      action: "client.webhook.delete",
      resource: "lead_webhook",
      resourceId: id,
      outcome: "ok",
    });
    res.status(204).end();
  });

  app.get(
    "/api/client/webhook-test",
    authLimiter,
    requirePlatformAuth,
    loadClientTenant,
    assertTenantAccess,
    requireClientPermission("config:write"),
    (_req, res) => {
      res.json({ ok: true, available: true });
    }
  );

  app.post(
    "/api/client/webhook-test",
    authLimiter,
    requirePlatformAuth,
    loadClientTenant,
    assertTenantAccess,
    requireClientPermission("config:write"),
    async (req, res) => {
      const tenantId = req.tenantId;
      const body = req.body || {};
      const endpointRaw = body.endpoint != null ? String(body.endpoint).trim() : "";
      const results = [];
      if (endpointRaw) {
        const secret = String(body.secret || "");
        const payload = typeof body.payload === "object" && body.payload && !Array.isArray(body.payload) ? body.payload : {};
        const t0 = Date.now();
        try {
          const out = await sendGenericWebhook(endpointRaw, { tenantId, test: true, ...payload }, secret);
          results.push({
            webhookId: null,
            endpoint: endpointRaw.slice(0, 200),
            ok: out.ok,
            status: out.status,
            durationMs: Date.now() - t0,
            error: null,
          });
        } catch (e) {
          results.push({
            webhookId: null,
            endpoint: endpointRaw.slice(0, 200),
            ok: false,
            status: 0,
            durationMs: Date.now() - t0,
            error: String(e.message || e),
          });
        }
      }
      res.json({ ok: true, results });
    }
  );
}

module.exports = { attachClientPortalRoutes };
