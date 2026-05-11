(function () {
  const $ = (id) => document.getElementById(id);
  const tenantInput = $("tenant-slug");
  const authBanner = $("auth-banner");
  const globalToast = $("global-toast");
  const statsGrid = $("stats-grid");
  const configLine = $("config-line");
  const whEvents = $("wh-events");
  const whTbody = $("wh-tbody");
  const brandingStatus = $("branding-status");
  const overviewStatusRow = $("overview-status-row");
  const overviewService = $("overview-service");
  const sessionStrip = $("session-strip");
  const previewBanner = $("preview-banner");
  const keyRotateStatus = $("key-rotate-status");
  const whSectionStatus = $("wh-section-status");

  const TENANT_KEY = "solomon_dashboard_tenant";
  const TOKEN_KEY = "solomon_dashboard_bearer";
  const ADV_MODE_KEY = "solomon_admin_advanced";

  let csrfToken = null;
  /** @type {object | null} */
  let lastBrandingBody = null;

  const state = {
    me: null,
    /** @type {{ slug: string, displayName: string, role?: string, status?: string }[]} */
    allowedTenants: [],
    meStatus: null,
    ready: null,
    stats: null,
    statsStatus: null,
    config: null,
    configStatus: null,
    verify: null,
    verifyStatus: null,
    webhooks: null,
    webhooksStatus: null,
    tenantsListForbidden: false,
    /** @type {boolean | null} funnel:read for conversations API */
    adminConversationsOk: null,
    /** @type {boolean | null} funnel:read for leads API */
    adminLeadsOk: null,
    /** @type {boolean | null} config:read for knowledge list API */
    adminKnowledgeReadOk: null,
    /** Last successful knowledge list total (for capability card) */
    adminKnowledgeTotal: 0,
    /** @type {boolean | null} config:read for bot behavior API */
    adminBotBehaviorReadOk: null,
    /** @type {boolean | null} GET webhook-test probe: true = can run tests, false = 403 */
    adminWebhookTestOk: null,
    /** @type {boolean | null} config:read for business profile GET */
    adminBusinessProfileReadOk: null,
    /** Last GET defaultsApplied flag (null until loaded) */
    businessProfileDefaultsApplied: null,
  };

  const convListState = { offset: 0, limit: 25, q: "" };
  const leadsListState = { offset: 0, limit: 25, q: "" };
  const knowledgeListState = { offset: 0, limit: 25, q: "" };
  let leadsRowsCache = [];
  let transcriptPlainText = "";
  /** @type {object | null} */
  let knowledgeDetailCache = null;
  /** Local-only label for last webhook test send (this browser). */
  let webhookTestLastAt = "";

  /** Visible build marker (not a secret). Bump with static asset ?v= in admin.html. */
  const ADMIN_UI_VERSION = "Portal separation hardening / v18";

  /**
   * @typedef {object} AdminModuleDef
   * @property {string} id
   * @property {string} title
   * @property {string} [description]
   * @property {string} category
   * @property {"simple"|"advanced"|"operator"|"developer"} mode
   * @property {number} priority
   * @property {"ready"|"needs_setup"|"coming_soon"|"hidden"|"unavailable"} status
   * @property {string} mount
   * @property {string} [permission]
   * @property {string} [healthEndpoint]
   * @property {((ctx: object) => void) | null} [refresh]
   */

  /** Filled in init after all functions exist. */
  /** @type {AdminModuleDef[]} */
  let adminModules = [];

  function getPortalMode() {
    const d = document.body && document.body.getAttribute("data-portal");
    if (d === "client" || d === "operator") return d;
    const q = new URLSearchParams(location.search).get("portal");
    if (q === "client" || q === "operator") return q;
    return "operator";
  }

  function applyPortalMode() {
    const mode = getPortalMode();
    document.body.dataset.portalMode = mode;
    if (mode === "client") {
      applyAdminMode(false);
      try {
        localStorage.removeItem(ADV_MODE_KEY);
      } catch (_) {}
      const bar = $("admin-mode-bar");
      if (bar) bar.hidden = true;
      const intPanel = $("panel-integrations");
      if (intPanel) intPanel.classList.remove("advanced-only");
    } else {
      const bar = $("admin-mode-bar");
      if (bar) bar.hidden = false;
      const intPanel = $("panel-integrations");
      if (intPanel && !document.body.classList.contains("admin-advanced")) {
        intPanel.classList.add("advanced-only");
      }
    }
  }

  function resolveApiPath(fullPath) {
    if (getPortalMode() !== "client") return fullPath;
    const qIdx = fullPath.indexOf("?");
    const pathOnly = qIdx >= 0 ? fullPath.slice(0, qIdx) : fullPath;
    const qs = qIdx >= 0 ? fullPath.slice(qIdx) : "";
    if (/^\/api\/keys\/rotate$/.test(pathOnly)) return null;
    if (/^\/api\/admin\/tenants(\/|$)/.test(pathOnly)) return null;
    let next = pathOnly;
    if (pathOnly === "/api/stats") next = "/api/client/stats";
    else if (pathOnly === "/api/config") next = "/api/client/config";
    else if (/^\/api\/admin\/tenants\/[^/]+\/verify$/.test(pathOnly)) next = "/api/client/verify";
    else if (pathOnly === "/api/integrations/webhooks/meta") next = "/api/client/webhooks/meta";
    else if (pathOnly === "/api/integrations/webhooks") next = "/api/client/webhooks";
    else if (/^\/api\/integrations\/webhooks\/[^/]+$/.test(pathOnly)) {
      next = "/api/client/webhooks/" + pathOnly.split("/").pop();
    } else if (pathOnly === "/api/integrations/branding") next = "/api/client/branding";
    else if (pathOnly === "/api/integrations/webhook-test") next = "/api/client/webhook-test";
    else if (pathOnly.startsWith("/api/admin/")) next = "/api/client/" + pathOnly.slice("/api/admin/".length);
    return next + qs;
  }

  function readInitialAdvanced() {
    const q = new URLSearchParams(location.search);
    if (q.get("advanced") === "1") {
      localStorage.setItem(ADV_MODE_KEY, "1");
      return true;
    }
    if (q.get("simple") === "1") {
      localStorage.removeItem(ADV_MODE_KEY);
      return false;
    }
    return localStorage.getItem(ADV_MODE_KEY) === "1";
  }

  function isAdvanced() {
    return document.body.classList.contains("admin-advanced");
  }

  function isDeveloperSectionAllowed() {
    const devEl = document.getElementById("dev-section");
    if (!devEl) return false;
    if (devEl.hasAttribute("hidden")) return false;
    if (devEl.getAttribute("aria-hidden") === "true") return false;
    if (devEl.style && devEl.style.display === "none") return false;
    return true;
  }

  function getAdminContext() {
    const authed = Boolean(state.lastStatsR && state.lastStatsR.status !== 401);
    const platformRole =
      state.me && state.me.ok && state.me.body && state.me.body.user && state.me.body.user.platformRole != null
        ? String(state.me.body.user.platformRole).toLowerCase()
        : state.me && state.me.ok && state.me.body && state.me.body.role != null
          ? String(state.me.body.role).toLowerCase()
          : "";
    const roleRaw =
      state.me && state.me.ok && state.me.body && state.me.body.role != null
        ? String(state.me.body.role).toLowerCase()
        : "";
    const effectiveTenantRole = getPortalMode() === "client" ? roleRaw || platformRole : platformRole || roleRaw;
    const operatorCapable = ["owner", "admin", "operator"].includes(platformRole);
    const portalMode = getPortalMode();
    const technicalHintsAllowed =
      portalMode === "operator" ||
      (portalMode === "client" &&
        isAdvanced() &&
        ["owner", "admin", "operator"].includes(String(effectiveTenantRole || "").toLowerCase()));
    return {
      portalMode,
      modeAdvanced: isAdvanced(),
      modeSimple: !isAdvanced(),
      authenticated: authed,
      role: roleRaw || platformRole,
      platformRole: platformRole || roleRaw,
      effectiveTenantRole,
      operatorCapable,
      tenantSlug: tenantSlug(),
      developerSectionAllowed: isDeveloperSectionAllowed(),
      tenantsListForbidden: Boolean(state.tenantsListForbidden),
      technicalHintsAllowed,
    };
  }

  /**
   * Frontend visibility only — backend RBAC remains authoritative.
   * @param {AdminModuleDef} mod
   * @param {ReturnType<typeof getAdminContext>} ctx
   */
  function shouldShowModule(mod, ctx) {
    if (mod.status === "hidden") return false;
    const aud = mod.audience || (mod.mode === "operator" || mod.mode === "developer" ? "operator" : "both");
    if (ctx.portalMode === "client" && aud === "operator") return false;
    if (mod.id === "webhook-testing" && state.adminWebhookTestOk === false) return false;
    const mode = mod.mode || "simple";
    if (mode === "developer") return ctx.portalMode !== "client" && ctx.modeAdvanced && ctx.developerSectionAllowed;
    if (mode === "advanced") {
      if (ctx.portalMode === "client" && mod.id === "webhook-testing") return true;
      return ctx.modeAdvanced;
    }
    if (mode === "operator") return true;
    return true;
  }

  function renderModuleStatusPill(uiStatus) {
    const allowed = new Set(["ready", "needs_setup", "coming_soon", "api_only", "operator", "unavailable"]);
    const s = allowed.has(String(uiStatus || "")) ? String(uiStatus) : "ready";
    const label =
      s === "needs_setup"
        ? "Needs setup"
        : s === "coming_soon"
          ? "Coming soon"
          : s === "api_only"
            ? "API-only"
            : s === "operator"
              ? "Operator-only"
              : s === "unavailable"
                ? "Unavailable"
                : "Available";
    return '<span class="module-status-pill ' + s + '">' + escapeHtml(label) + "</span>";
  }

  function renderModuleShell(opts) {
    const title = escapeHtml(opts.title || "");
    const desc = opts.description ? "<p>" + escapeHtml(opts.description) + "</p>" : "";
    const pill = opts.pillHtml || "";
    const body = opts.bodyHtml || "";
    const cta = opts.ctaHtml
      ? '<div class="module-cta-row">' + opts.ctaHtml + "</div>"
      : "";
    return (
      '<div class="admin-stub-card" data-module-card="' +
      escapeHtml(opts.id || "") +
      '">' +
      pill +
      "<h3>" +
      title +
      "</h3>" +
      desc +
      body +
      cta +
      "</div>"
    );
  }

  function setModuleZoneState(mountSelector, dataState) {
    const el = document.querySelector(mountSelector);
    if (el) el.setAttribute("data-module-state", dataState || "ready");
  }

  function setModuleLoading(mountSelector) {
    setModuleZoneState(mountSelector, "loading");
  }

  function setModuleReady(mountSelector) {
    setModuleZoneState(mountSelector, "ready");
  }

  function setModuleNeedsSetup(mountSelector) {
    setModuleZoneState(mountSelector, "needs_setup");
  }

  function setModuleUnavailable(mountSelector) {
    setModuleZoneState(mountSelector, "unavailable");
  }

  function renderModuleError(message) {
    return '<p class="error-text">' + escapeHtml(message || "Something went wrong.") + "</p>";
  }

  function renderModuleEmpty(message) {
    return '<p class="muted">' + escapeHtml(message || "Nothing to show yet.") + "</p>";
  }

  function renderModuleCTA(html) {
    return html || "";
  }

  function buildCapabilityCardsDynamic(ctx) {
    const whCount = Array.isArray(state.webhooks) ? state.webhooks.length : 0;
    const base = [
      {
        id: "cap-chatbot",
        title: "AI chatbot",
        customerLabel: "Available",
        pill: "ready",
        mode: "simple",
        detail: "Hosted visitor chat and OpenAI-backed replies for the active site.",
      },
      {
        id: "cap-pilot-readiness",
        title: "Pilot readiness",
        customerLabel: ctx.authenticated ? "Available" : "Sign in to view",
        pill: ctx.authenticated ? "ready" : "needs_setup",
        mode: "simple",
        detail:
          "Consolidated go-live checklist (AI, profile, behavior, knowledge, branding, operations) — not a production audit.",
      },
      {
        id: "cap-branding",
        title: "Branding & theme",
        customerLabel: "Available",
        pill: "ready",
        mode: "simple",
        detail: "Dashboard controls for colors, theme, and chat appearance.",
      },
      {
        id: "cap-business-profile",
        title: "Business profile",
        customerLabel:
          ctx.authenticated === false
            ? "Sign in to view"
            : state.adminBusinessProfileReadOk === false
              ? "Restricted (role)"
              : state.adminBusinessProfileReadOk === true && state.businessProfileDefaultsApplied === true
                ? "Needs setup"
                : state.adminBusinessProfileReadOk === true
                  ? "Available"
                  : "Loading…",
        pill:
          ctx.authenticated === false
            ? "needs_setup"
            : state.adminBusinessProfileReadOk === false
              ? "operator"
              : state.adminBusinessProfileReadOk === true && state.businessProfileDefaultsApplied === true
                ? "needs_setup"
                : state.adminBusinessProfileReadOk === true
                  ? "ready"
                  : "needs_setup",
        mode: "simple",
        detail:
          "Structured identity, contact, hours, services, and policies under Look & feel — injected into chat as context (not a raw system prompt).",
      },
      {
        id: "cap-install",
        title: "Website install",
        customerLabel: "Available",
        pill: "ready",
        mode: "simple",
        detail: "Hosted chat link and iframe example — no first-party script-tag widget in this build.",
      },
      {
        id: "cap-leads",
        title: "Lead inbox",
        customerLabel:
          ctx.authenticated === false
            ? "Sign in to view"
            : state.adminLeadsOk === true
              ? "Available"
              : state.adminLeadsOk === false
                ? "Restricted (role)"
                : "Loading…",
        pill:
          ctx.authenticated === false
            ? "needs_setup"
            : state.adminLeadsOk === true
              ? "ready"
              : state.adminLeadsOk === false
                ? "operator"
                : "needs_setup",
        mode: "simple",
        detail: "Table of captured leads for this site (read-only). Conversation link is not stored on the Lead model yet.",
      },
      {
        id: "cap-stats",
        title: "Usage & activity",
        customerLabel: ctx.authenticated ? "Basic stats" : "Sign in to view",
        pill: ctx.authenticated ? "ready" : "needs_setup",
        mode: "simple",
        detail: "Thread, message, and 30-day token/cost aggregates in Overview when signed in.",
      },
      {
        id: "cap-webhooks",
        title: "Outbound webhooks",
        customerLabel:
          ctx.authenticated === false
            ? "Sign in to view"
            : ctx.modeAdvanced
              ? whCount > 0
                ? "Available (" + whCount + ")"
                : "Needs setup"
              : "Advanced",
        pill:
          ctx.authenticated === false
            ? "needs_setup"
            : ctx.modeAdvanced
              ? whCount > 0
                ? "ready"
                : "needs_setup"
              : "operator",
        mode: "advanced",
        detail: "HTTPS callbacks for canonical events (e.g. new leads). Managed under Advanced → integrations.",
      },
      {
        id: "cap-webhook-test",
        title: "Webhook testing",
        customerLabel:
          ctx.authenticated === false
            ? "Sign in to view"
            : state.adminWebhookTestOk === false
              ? "Restricted (role)"
              : state.adminWebhookTestOk === true
                ? "Available"
                : "Loading…",
        pill:
          ctx.authenticated === false
            ? "needs_setup"
            : state.adminWebhookTestOk === false
              ? "operator"
              : state.adminWebhookTestOk === true
                ? "ready"
                : "needs_setup",
        mode: "advanced",
        detail:
          "Send a safe test envelope to configured endpoints (does not create a lead). Requires config write.",
      },
      {
        id: "cap-inbound",
        title: "Inbound integrations",
        customerLabel: "API-only",
        pill: "api_only",
        mode: "advanced",
        detail: "REST adapters exist for server-to-server use; no guided connector UI here yet.",
      },
      {
        id: "cap-knowledge",
        title: "Knowledge base",
        customerLabel:
          ctx.authenticated === false
            ? "Sign in to view"
            : state.adminKnowledgeReadOk === false
              ? "Restricted (role)"
              : state.adminKnowledgeReadOk === true && state.adminKnowledgeTotal === 0
                ? "Empty — add text"
                : state.adminKnowledgeReadOk === true
                  ? "Available"
                  : "Loading…",
        pill:
          ctx.authenticated === false
            ? "needs_setup"
            : state.adminKnowledgeReadOk === false
              ? "operator"
              : state.adminKnowledgeReadOk === true && state.adminKnowledgeTotal === 0
                ? "needs_setup"
                : state.adminKnowledgeReadOk === true
                  ? "ready"
                  : "needs_setup",
        mode: "simple",
        detail:
          "Plain-text knowledge stored per site; keyword overlap RAG (same path as chat). Operators with config write can add, archive, or delete entries.",
      },
      {
        id: "cap-bot-behavior",
        title: "Bot behavior",
        customerLabel:
          ctx.authenticated === false
            ? "Sign in to view"
            : state.adminBotBehaviorReadOk === false
              ? "Restricted (role)"
              : state.adminBotBehaviorReadOk === true
                ? "Available"
                : "Loading…",
        pill:
          ctx.authenticated === false
            ? "needs_setup"
            : state.adminBotBehaviorReadOk === false
              ? "operator"
              : state.adminBotBehaviorReadOk === true
                ? "ready"
                : "needs_setup",
        mode: "simple",
        detail:
          "Guided tone, goals, escalation, and lead capture text stored in tenant settings — not a raw system prompt editor.",
      },
      {
        id: "cap-prompts",
        title: "System prompt editor",
        customerLabel: "Coming soon",
        pill: "coming_soon",
        mode: "advanced",
        detail:
          "DB/files and PromptVersion still power core system, policy, and voice prompts — raw editing is not enabled in this dashboard.",
      },
      {
        id: "cap-conversations",
        title: "Conversation viewer",
        customerLabel:
          ctx.authenticated === false
            ? "Sign in to view"
            : state.adminConversationsOk === true
              ? "Available"
              : state.adminConversationsOk === false
                ? "Restricted (role)"
                : "Loading…",
        pill:
          ctx.authenticated === false
            ? "needs_setup"
            : state.adminConversationsOk === true
              ? "ready"
              : state.adminConversationsOk === false
                ? "operator"
                : "needs_setup",
        mode: "simple",
        detail: "Browse recent threads and open read-only transcripts when your role includes funnel read access.",
      },
      {
        id: "cap-appointments",
        title: "Appointments & quotes",
        customerLabel: "API-only",
        pill: "api_only",
        mode: "advanced",
        detail: "Backend routes exist for bookings and quotes; no operator UI wired here.",
      },
      {
        id: "cap-handoff",
        title: "Human handoff",
        customerLabel: "API-only",
        pill: "api_only",
        mode: "advanced",
        detail: "Handoff sessions can be created via API; not exposed as a dashboard tool yet.",
      },
      {
        id: "cap-compliance",
        title: "Compliance export",
        customerLabel: "API-only",
        pill: "api_only",
        mode: "advanced",
        detail: "Tenant export endpoints exist for audits; not surfaced in this UI.",
      },
    ];
    return base.filter((c) => {
      if (c.mode === "advanced" && !ctx.modeAdvanced) return false;
      return true;
    });
  }

  function renderCapabilityCards(ctx) {
    const root = $("dashboard-capabilities-modules");
    if (!root) return;
    if (ctx.portalMode === "client") {
      root.innerHTML = "";
      return;
    }
    const cards = buildCapabilityCardsDynamic(ctx);
    root.innerHTML = cards
      .map((c) => {
        const pill = renderModuleStatusPill(c.pill);
        return (
          '<div class="admin-cap-card" data-capability="' +
          escapeHtml(c.id) +
          '">' +
          pill +
          "<h3>" +
          escapeHtml(c.title) +
          "</h3>" +
          "<p><strong>" +
          escapeHtml(c.customerLabel) +
          "</strong> — " +
          escapeHtml(c.detail) +
          "</p></div>"
        );
      })
      .join("");
  }

  function renderStubIntoContainer(container, defs, ctx) {
    if (!container) return;
    const html = defs
      .map((d) => {
        if (!shouldShowModule(d, ctx)) return "";
        const pill = renderModuleStatusPill(d.status === "coming_soon" ? "coming_soon" : d.status);
        return renderModuleShell({
          id: d.id,
          title: d.title,
          description: d.detail,
          pillHtml: pill,
        });
      })
      .filter(Boolean)
      .join("");
    container.innerHTML = html || renderModuleEmpty("No roadmap cards for this view.");
  }

  function getBusinessStubModules() {
    return [];
  }

  function getAnalyticsStubModules() {
    return [
      {
        id: "analytics",
        title: "Analytics dashboards",
        category: "analytics",
        mode: "advanced",
        priority: 30,
        status: "coming_soon",
        mount: "#dashboard-analytics-modules",
        detail: "Beyond Overview counts: funnels, charts, and cohort views — not built in this UI yet.",
      },
    ];
  }

  function getSecurityStubModules() {
    return [
      {
        id: "audit-log",
        title: "Audit log viewer",
        category: "security",
        mode: "advanced",
        priority: 10,
        status: "api_only",
        mount: "#dashboard-security-modules",
        detail: "AuditLog rows are written on sensitive actions; add filtered UI with audit:read permission.",
      },
      {
        id: "plan-controls",
        title: "Plans & billing caps",
        category: "security",
        mode: "advanced",
        priority: 20,
        status: "api_only",
        mount: "#dashboard-security-modules",
        detail: "Tenant.plan and cost caps exist in code paths; no billing console in this dashboard yet.",
      },
      {
        id: "model-policy",
        title: "Model routing & caps",
        category: "security",
        mode: "advanced",
        priority: 30,
        status: "coming_soon",
        mount: "#dashboard-security-modules",
        detail: "Surface settings.modelPolicy and monthly caps when a settings API is added for operators.",
      },
    ];
  }

  function renderRoadmapStubZones(ctx) {
    renderStubIntoContainer($("dashboard-business-stubs"), getBusinessStubModules(), ctx);
    renderStubIntoContainer($("dashboard-analytics-modules"), getAnalyticsStubModules(), ctx);
    renderStubIntoContainer($("dashboard-security-modules"), getSecurityStubModules(), ctx);
  }

  function applyOperationsLockBanner(ctx) {
    const el = $("operations-lock-banner");
    if (!el) return;
    if (ctx.portalMode === "client") {
      el.hidden = true;
      return;
    }
    if (!ctx.authenticated) {
      el.hidden = true;
      return;
    }
    if (!ctx.operatorCapable) {
      el.hidden = false;
      el.textContent =
        "Provisioning and some diagnostics need an operator, administrator, or owner role in your platform account. You can still use chat preview, look & feel, and pilot readiness where your permissions allow.";
    } else {
      el.hidden = true;
    }
  }

  function setAdminVersionMarker() {
    const slug = tenantSlug();
    const line =
      getPortalMode() === "client"
        ? "Admin UI version: " + ADMIN_UI_VERSION + (slug ? " · " + slug : "")
        : "Admin UI version: " + ADMIN_UI_VERSION + " · active site: " + (slug || "—");
    const g = $("admin-ui-version-global");
    if (g) g.textContent = line;
    const d = $("admin-ui-version");
    if (d) d.textContent = line;
  }

  function refreshOverviewModule() {
    renderOverviewService(state.ready);
    renderOverviewCards(state.lastStatsR, state.lastConfigR, state.lastVerifyR);
  }

  function buildAdminModuleRegistry() {
    return [
      {
        id: "overview",
        title: "Overview",
        audience: "both",
        description: "Stats, bot readiness, and service hints.",
        category: "overview",
        mode: "simple",
        priority: 10,
        status: "ready",
        mount: "#dashboard-overview-modules",
        healthEndpoint: "/api/ready",
        refresh: refreshOverviewModule,
      },
      {
        id: "capabilities",
        title: "Platform capabilities",
        audience: "operator",
        description: "Honest feature matrix for this deployment.",
        category: "overview",
        mode: "simple",
        priority: 15,
        status: "ready",
        mount: "#dashboard-capabilities-modules",
      },
      {
        id: "pilot-readiness",
        title: "Pilot readiness",
        audience: "both",
        description:
          "Ready / needs attention / operator required — scored checklist across core setup, bot quality, website launch, operations, and security.",
        category: "setup",
        mode: "simple",
        priority: 20,
        status: "ready",
        mount: "#dashboard-pilot-readiness-root",
        refresh: () => loadPilotReadinessModule(getAdminContext()),
      },
      {
        id: "chat-preview",
        title: "Chat preview",
        audience: "both",
        description: "Hosted chat iframe and deep link.",
        category: "bot",
        mode: "simple",
        priority: 30,
        status: "ready",
        mount: "#dashboard-bot-modules",
      },
      {
        id: "bot-behavior",
        title: "Bot behavior",
        audience: "both",
        description: "Guided tone, goals, escalation, and lead capture (read: config read; save: config write).",
        category: "bot",
        mode: "simple",
        priority: 31,
        status: "ready",
        mount: "#dashboard-bot-behavior-root",
      },
      {
        id: "website-install",
        title: "Website install",
        audience: "both",
        description: "Link and iframe snippet helpers.",
        category: "website",
        mode: "simple",
        priority: 40,
        status: "ready",
        mount: "#dashboard-website-modules",
      },
      {
        id: "branding",
        title: "Look & feel",
        audience: "both",
        description: "Tenant branding and embed theme.",
        category: "business",
        mode: "simple",
        priority: 50,
        status: "ready",
        mount: "#dashboard-business-modules",
        permission: "config:write",
      },
      {
        id: "business-profile",
        title: "Business profile",
        audience: "both",
        description:
          "Identity, contact, hours, services, booking link, and policies for chat context (read: config read; save: config write).",
        category: "business",
        mode: "simple",
        priority: 51,
        status: "ready",
        mount: "#dashboard-business-profile-root",
        permission: "config:write",
        refresh: () => loadBusinessProfileModule(getAdminContext()),
      },
      {
        id: "knowledge-base",
        title: "Knowledge base",
        audience: "both",
        description: "Plain-text entries for keyword RAG (read: config read; add/archive/delete: config write).",
        category: "business",
        mode: "simple",
        priority: 52,
        status: "ready",
        mount: "#dashboard-knowledge-root",
      },
      {
        id: "tenant-provisioning",
        title: "Site provisioning",
        audience: "operator",
        description: "Create tenants and rotate integration keys.",
        category: "operations",
        mode: "operator",
        priority: 60,
        status: "ready",
        mount: "#dashboard-operations-modules",
        permission: "tenants:provision",
      },
      {
        id: "conversations",
        title: "Conversations",
        audience: "both",
        description: "Recent threads and read-only transcripts (funnel read).",
        category: "operations",
        mode: "simple",
        priority: 62,
        status: "ready",
        mount: "#dashboard-conversations-root",
      },
      {
        id: "leads",
        title: "Leads",
        audience: "both",
        description: "Captured contacts for this site (read-only).",
        category: "operations",
        mode: "simple",
        priority: 63,
        status: "ready",
        mount: "#dashboard-leads-root",
      },
      {
        id: "integrations-advanced",
        title: "Integrations",
        audience: "operator",
        description: "Inbound API key and outbound webhooks.",
        category: "integrations",
        mode: "advanced",
        priority: 70,
        status: "ready",
        mount: "#dashboard-advanced-modules",
        permission: "config:write",
      },
      {
        id: "webhook-testing",
        title: "Webhook test & health",
        audience: "both",
        description:
          "POSTs a marked test envelope to outbound webhooks (admin.webhook_test or another canonical type). Does not create a lead.",
        category: "integrations",
        mode: "advanced",
        priority: 71,
        status: "ready",
        mount: "#dashboard-webhook-testing-root",
        permission: "config:write",
        refresh: () => loadWebhookTestModule(getAdminContext()),
      },
      {
        id: "developer-tools",
        title: "Developer tools",
        audience: "operator",
        description: "Optional bearer token for local API use.",
        category: "developer",
        mode: "developer",
        priority: 100,
        status: "ready",
        mount: "#dashboard-developer-modules",
      },
    ];
  }

  function applyModuleRegistryAfterLoad(ctx) {
    try {
      adminModules = buildAdminModuleRegistry();
      renderCapabilityCards(ctx);
      renderRoadmapStubZones(ctx);
      applyOperationsLockBanner(ctx);
      for (const m of adminModules) {
        if (!shouldShowModule(m, ctx)) continue;
        if (typeof m.refresh === "function") {
          try {
            const out = m.refresh();
            if (out != null && typeof out.then === "function") {
              void out.catch((e) => console.warn("module refresh failed", m.id, e));
            }
          } catch (e) {
            console.warn("module refresh failed", m.id, e);
          }
        }
      }
    } catch (e) {
      console.warn("applyModuleRegistryAfterLoad", e);
    }
  }

  function applyAdminMode(advanced) {
    document.body.classList.toggle("admin-advanced", advanced);
    document.body.classList.toggle("admin-simple", !advanced);
    const hint = $("admin-mode-hint");
    const btn = $("btn-toggle-mode");
    if (hint) {
      hint.textContent = advanced
        ? "Advanced view: integrations, webhooks, server diagnostics, and developer access token."
        : "Standard view — integrations and technical tools are tucked under Advanced.";
    }
    if (btn) btn.textContent = advanced ? "Standard view" : "Advanced…";
  }

  function syncModeUrl(advanced) {
    const q = new URLSearchParams(location.search);
    const slug = tenantSlugFromInputs();
    q.delete("advanced");
    q.delete("simple");
    if (slug) q.set("tenant", slug);
    if (advanced) q.set("advanced", "1");
    const qs = q.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
  }

  function tenantSlugFromInputs() {
    const q = new URLSearchParams(location.search).get("tenant");
    const fromInput = (tenantInput.value || "").trim();
    return fromInput || q || localStorage.getItem(TENANT_KEY) || "default";
  }

  function tenantSlug() {
    const raw = tenantSlugFromInputs();
    if (getPortalMode() === "client" && Array.isArray(state.allowedTenants) && state.allowedTenants.length) {
      const ok = state.allowedTenants.some((x) => x.slug === raw);
      if (!ok) return "";
    }
    return raw;
  }

  function authHeaders() {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return { Authorization: "Bearer " + t.trim() };
    return {};
  }

  async function ensureCsrf() {
    if (localStorage.getItem(TOKEN_KEY)) {
      csrfToken = null;
      return;
    }
    let slug = tenantSlug();
    if (!slug && getPortalMode() === "client" && state.allowedTenants && state.allowedTenants.length === 1) {
      slug = state.allowedTenants[0].slug;
    }
    if (!slug) {
      csrfToken = null;
      return;
    }
    const url = "/api/security/csrf-token?tenant=" + encodeURIComponent(slug);
    const res = await fetch(url, { credentials: "include", headers: { ...authHeaders() } });
    if (!res.ok) {
      csrfToken = null;
      return;
    }
    try {
      const b = await res.json();
      csrfToken = b.csrfToken || null;
    } catch {
      csrfToken = null;
    }
  }

  async function api(path, opts = {}) {
    const method = String(opts.method || "GET").toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      await ensureCsrf();
    }
    const realPath = resolveApiPath(path);
    if (realPath === null) {
      return { ok: false, status: 403, body: { error: "operator_action_not_available" } };
    }
    const slug = tenantSlug();
    if (getPortalMode() === "client" && !slug) {
      return { ok: false, status: 0, body: { error: "tenant_required" } };
    }
    const url = realPath + (realPath.includes("?") ? "&" : "?") + "tenant=" + encodeURIComponent(slug);
    const headers = {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...opts.headers,
    };
    if (csrfToken && !localStorage.getItem(TOKEN_KEY)) {
      headers["X-CSRF-Token"] = csrfToken;
    }
    const res = await fetch(url, {
      credentials: "include",
      headers,
      ...opts,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  }

  async function fetchReady() {
    try {
      const res = await fetch("/api/ready", { credentials: "omit" });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: { error: String(e.message || e) } };
    }
  }

  async function fetchMe() {
    try {
      const mePath = getPortalMode() === "client" ? "/api/client/me" : "/api/admin/me";
      const res = await fetch(mePath, { credentials: "include", headers: { ...authHeaders() } });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: null };
    }
  }

  function showAuth(msg, isError) {
    if (!authBanner) return;
    authBanner.hidden = false;
    authBanner.textContent = msg;
    authBanner.className = "banner" + (isError ? " error" : "");
  }

  function hideAuth() {
    if (authBanner) authBanner.hidden = true;
  }

  function showGlobalToast(msg, kind, ms) {
    if (!globalToast || !msg) return;
    globalToast.hidden = false;
    globalToast.textContent = msg;
    globalToast.className = "banner " + (kind === "error" ? "error" : kind === "success" ? "success" : "info");
    const t = ms || 4500;
    clearTimeout(showGlobalToast._t);
    showGlobalToast._t = setTimeout(() => {
      globalToast.hidden = true;
    }, t);
  }

  function hideSection(el) {
    if (el) el.hidden = true;
  }

  function showSectionText(el, msg, isError) {
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.className = "section-banner small " + (isError ? "error" : "muted");
  }

  async function copyToClipboard(text, successMsg) {
    const t = String(text || "");
    if (!t) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
      } else {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showGlobalToast(successMsg || "Copied to clipboard.", "success", 3200);
    } catch {
      showGlobalToast("Could not copy automatically — select the text and copy manually.", "error", 5000);
    }
  }

  function buildChatUrl() {
    const u = new URL("/", location.origin);
    u.searchParams.set("tenant", tenantSlug());
    return u.toString();
  }

  function buildIframeSnippet() {
    const url = buildChatUrl();
    return (
      '<iframe\n' +
      '  src="' +
      url.replace(/"/g, "&quot;") +
      '"\n' +
      '  title="Chat"\n' +
      '  width="380"\n' +
      '  height="640"\n' +
      '  style="border:0;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);"\n' +
      "  loading=\"lazy\"\n" +
      "></iframe>"
    );
  }

  function updateInstallPreviewUrls() {
    const chat = buildChatUrl();
    const iframe = buildIframeSnippet();
    const link = $("chat-preview-link");
    const installUrl = $("install-chat-url");
    const snippet = $("install-iframe-snippet");
    const frame = $("chat-preview-frame");
    if (link) {
      link.href = chat;
    }
    if (installUrl) installUrl.textContent = chat;
    if (snippet) snippet.textContent = iframe;
    if (frame) {
      frame.src = chat;
      if (previewBanner) {
        previewBanner.hidden = false;
        previewBanner.textContent =
          "Preview loads the same hosted chat page in a small frame below. If it appears empty, your browser may block embedded pages — use the button to open a new tab.";
      }
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function probeWebhookTestCapability() {
    const ctx = getAdminContext();
    if (!ctx.authenticated) {
      state.adminWebhookTestOk = null;
      return;
    }
    const r = await api("/api/integrations/webhook-test", { method: "GET" });
    if (r.status === 403) state.adminWebhookTestOk = false;
    else if (r.ok && r.body && r.body.ok) state.adminWebhookTestOk = true;
    else state.adminWebhookTestOk = null;
  }

  function syncWebhookTestPanel(ctx) {
    const health = $("wht-health");
    const empty = $("wht-empty");
    const sel = $("wht-webhook-select");
    const evSel = $("wht-event-type");
    const sendBtn = $("btn-wht-send");
    const rows = Array.isArray(state.webhooks) ? state.webhooks : [];
    const n = rows.length;
    const enabledCount = rows.filter((w) => w.enabled).length;
    if (health) {
      if (!ctx.authenticated) {
        health.textContent = "Sign in to run connectivity tests for this site.";
      } else if (state.adminWebhookTestOk === false) {
        health.textContent = "Your role cannot send webhook tests (requires config:write).";
      } else if (n === 0) {
        health.textContent = "No outbound webhooks configured for this site.";
      } else {
        health.textContent =
          n +
          " webhook row(s); " +
          enabledCount +
          " enabled. Only enabled endpoints that subscribe to the selected event receive the test.";
      }
    }
    if (sel) {
      const curWh = sel.value;
      sel.innerHTML =
        '<option value="__all__">All enabled (matching event)</option>' +
        rows
          .map((w) => {
            const ep = String(w.endpoint || "");
            const label = ep.length > 72 ? ep.slice(0, 69) + "…" : ep;
            const dis = w.enabled ? "" : " (disabled)";
            return (
              "<option value=\"" +
              escapeHtml(w.id) +
              "\">" +
              escapeHtml(label + dis) +
              "</option>"
            );
          })
          .join("");
      if (curWh && Array.from(sel.options).some((o) => o.value === curWh)) sel.value = curWh;
    }
    if (evSel) {
      const curEv = evSel.value;
      const list = (eventTypes.length ? [...eventTypes] : ["admin.webhook_test"]).sort((a, b) => {
        if (a === "admin.webhook_test") return -1;
        if (b === "admin.webhook_test") return 1;
        return a.localeCompare(b);
      });
      evSel.innerHTML = list
        .map((ev) => "<option value=\"" + escapeHtml(ev) + "\">" + escapeHtml(ev) + "</option>")
        .join("");
      if (curEv && list.includes(curEv)) evSel.value = curEv;
      else evSel.value = "admin.webhook_test";
    }
    if (empty) {
      empty.hidden = n !== 0 || !ctx.authenticated;
    }
    if (sendBtn) {
      sendBtn.disabled =
        !ctx.authenticated || state.adminWebhookTestOk !== true || enabledCount === 0;
    }
    const rootSel = "#dashboard-webhook-testing-root";
    if (!ctx.authenticated || state.adminWebhookTestOk !== true) {
      setModuleNeedsSetup(rootSel);
    } else if (n === 0 || enabledCount === 0) {
      setModuleNeedsSetup(rootSel);
    } else {
      setModuleReady(rootSel);
    }
  }

  async function loadWebhookTestModule(ctx) {
    await probeWebhookTestCapability();
    syncWebhookTestPanel(ctx || getAdminContext());
    const last = $("wht-last");
    if (last && webhookTestLastAt) last.textContent = "Last test (this browser): " + webhookTestLastAt;
  }

  async function sendWebhookTest() {
    const ctx = getAdminContext();
    const banner = $("wht-banner");
    const loading = $("wht-loading");
    const wrap = document.querySelector("#dashboard-webhook-testing-root .wht-results-wrap");
    const tbody = $("wht-tbody");
    const note = $("wht-note");
    const last = $("wht-last");
    if (banner) {
      banner.hidden = true;
      banner.textContent = "";
      banner.className = "section-banner small";
    }
    if (note) {
      note.hidden = true;
      note.textContent = "";
    }
    if (!ctx.authenticated || state.adminWebhookTestOk !== true) {
      if (banner) {
        banner.hidden = false;
        banner.textContent = "Sign in with a role that has config:write to send tests.";
        banner.className = "section-banner small error-text";
      }
      return;
    }
    const whSel = $("wht-webhook-select");
    const evSel = $("wht-event-type");
    const webhookIdRaw = whSel && whSel.value !== "__all__" ? String(whSel.value).trim() : "";
    const eventType = evSel && evSel.value ? String(evSel.value).trim() : "admin.webhook_test";
    const body = {};
    if (webhookIdRaw) body.webhookId = webhookIdRaw;
    if (eventType) body.eventType = eventType;
    if (loading) loading.hidden = false;
    const r = await api("/api/integrations/webhook-test", { method: "POST", body: JSON.stringify(body) });
    if (loading) loading.hidden = true;
    if (!r.ok) {
      if (banner) {
        banner.hidden = false;
        banner.textContent = r.body?.error || "Request failed (" + r.status + ")";
        banner.className = "section-banner small error-text";
      }
      return;
    }
    webhookTestLastAt = new Date().toLocaleString();
    if (last) last.textContent = "Last test (this browser): " + webhookTestLastAt;
    const tested = r.body.tested != null ? r.body.tested : (r.body.results || []).length;
    if (note && (r.body.note || tested === 0)) {
      note.hidden = false;
      const hints = {
        no_webhooks: "No enabled webhooks matched this request. Add or enable a webhook above.",
        no_hooks_subscribed_to_event:
          "No enabled webhook subscribes to this event for the selected target. Choose “All enabled”, another event type, or widen the webhook’s event filter.",
      };
      note.textContent =
        hints[r.body.note] || (r.body.note ? String(r.body.note) : "No deliveries ran — check filters and enabled state.");
    }
    if (wrap && tbody) {
      const list = r.body.results || [];
      wrap.hidden = list.length === 0;
      tbody.innerHTML = list
        .map((row) => {
          const okBadge = row.ok
            ? '<span class="wht-badge wht-badge-ok">OK</span>'
            : '<span class="wht-badge wht-badge-fail">Fail</span>';
          return (
            "<tr><td class=\"mono\">" +
            escapeHtml(String(row.endpoint || "")) +
            "</td><td>" +
            escapeHtml(String(row.status ?? "")) +
            "</td><td>" +
            okBadge +
            "</td><td>" +
            escapeHtml(row.durationMs != null ? String(row.durationMs) + " ms" : "—") +
            "</td><td class=\"wht-err-cell\">" +
            escapeHtml(row.error != null ? String(row.error) : "") +
            "</td></tr>"
          );
        })
        .join("");
    }
    if (r.body.ok === false && (r.body.results || []).some((x) => !x.ok)) {
      showGlobalToast("One or more webhook endpoints failed.", "warn");
    } else if (tested > 0) {
      showGlobalToast("Test finished for " + tested + " endpoint(s).", "success");
    }
    void loadPilotReadinessModule(getAdminContext()).catch(console.error);
  }

  function wireWebhookTestUi() {
    const b = $("btn-wht-send");
    if (b) b.addEventListener("click", () => sendWebhookTest().catch(console.error));
  }

  function formatAdminDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  }

  function adminListQuery(base, listState) {
    const u = base + (base.includes("?") ? "&" : "?");
    const parts = [
      "limit=" + encodeURIComponent(String(listState.limit)),
      "offset=" + encodeURIComponent(String(listState.offset)),
    ];
    if (listState.q) parts.push("q=" + encodeURIComponent(listState.q));
    return u + parts.join("&");
  }

  function renderConvPagination(total) {
    const root = $("conv-pagination");
    if (!root) return;
    const lim = convListState.limit;
    const off = convListState.offset;
    if (total <= lim && off === 0) {
      root.innerHTML = "";
      return;
    }
    const start = total === 0 ? 0 : off + 1;
    const end = Math.min(off + lim, total);
    const prevDisabled = off <= 0;
    const nextDisabled = off + lim >= total;
    root.innerHTML =
      '<span class="pagination-meta muted small">' +
      escapeHtml(String(start) + "–" + String(end) + " of " + String(total)) +
      "</span>" +
      '<button type="button" class="secondary" id="btn-conv-prev"' +
      (prevDisabled ? " disabled" : "") +
      ">Previous</button>" +
      '<button type="button" class="secondary" id="btn-conv-next"' +
      (nextDisabled ? " disabled" : "") +
      ">Next</button>";
    const prev = $("btn-conv-prev");
    const next = $("btn-conv-next");
    if (prev && !prevDisabled) {
      prev.addEventListener("click", () => {
        convListState.offset = Math.max(0, off - lim);
        loadConversationsModule(getAdminContext());
      });
    }
    if (next && !nextDisabled) {
      next.addEventListener("click", () => {
        convListState.offset = off + lim;
        loadConversationsModule(getAdminContext());
      });
    }
  }

  function renderLeadsPagination(total) {
    const root = $("leads-pagination");
    if (!root) return;
    const lim = leadsListState.limit;
    const off = leadsListState.offset;
    if (total <= lim && off === 0) {
      root.innerHTML = "";
      return;
    }
    const start = total === 0 ? 0 : off + 1;
    const end = Math.min(off + lim, total);
    const prevDisabled = off <= 0;
    const nextDisabled = off + lim >= total;
    root.innerHTML =
      '<span class="pagination-meta muted small">' +
      escapeHtml(String(start) + "–" + String(end) + " of " + String(total)) +
      "</span>" +
      '<button type="button" class="secondary" id="btn-leads-prev"' +
      (prevDisabled ? " disabled" : "") +
      ">Previous</button>" +
      '<button type="button" class="secondary" id="btn-leads-next"' +
      (nextDisabled ? " disabled" : "") +
      ">Next</button>";
    const prev = $("btn-leads-prev");
    const next = $("btn-leads-next");
    if (prev && !prevDisabled) {
      prev.addEventListener("click", () => {
        leadsListState.offset = Math.max(0, off - lim);
        loadLeadsModule(getAdminContext());
      });
    }
    if (next && !nextDisabled) {
      next.addEventListener("click", () => {
        leadsListState.offset = off + lim;
        loadLeadsModule(getAdminContext());
      });
    }
  }

  function closeTranscriptModal() {
    const m = $("transcript-modal");
    if (m) m.hidden = true;
    transcriptPlainText = "";
  }

  function renderTranscriptMessages(messages) {
    const lines = [];
    const parts = [];
    for (const m of messages || []) {
      const role = String(m.role || "").toLowerCase();
      const roleClass = role.replace(/[^a-z0-9_-]/g, "") || "unknown";
      const label = role === "user" ? "Visitor" : role === "assistant" ? "Assistant" : escapeHtml(m.role || "message");
      const when = formatAdminDate(m.createdAt);
      const body = escapeHtml(m.content || "").replace(/\r\n/g, "\n").replace(/\n/g, "<br />");
      lines.push(
        "[" +
          (role === "user" ? "Visitor" : role === "assistant" ? "Assistant" : escapeHtml(String(m.role || "?"))) +
          "] " +
          String(m.content || "")
      );
      parts.push(
        '<div class="transcript-msg transcript-msg--' +
        escapeHtml(roleClass) +
        '"><div class="transcript-msg-head"><span class="transcript-role">' +
        label +
        '</span><span class="transcript-time muted small">' +
        escapeHtml(when) +
        "</span></div><div class=\"transcript-msg-body\">" +
        body +
        "</div></div>"
      );
    }
    transcriptPlainText = lines.join("\n\n");
    return parts.join("");
  }

  async function openTranscriptModal(conversationId) {
    const modal = $("transcript-modal");
    const bodyEl = $("transcript-body");
    const meta = $("transcript-meta");
    if (!modal || !bodyEl) return;
    modal.hidden = false;
    bodyEl.innerHTML = '<p class="muted">Loading transcript…</p>';
    if (meta) meta.textContent = "";
    transcriptPlainText = "";
    const r = await api("/api/admin/conversations/" + encodeURIComponent(conversationId));
    if (r.status === 404) {
      bodyEl.innerHTML = '<p class="error-text">Conversation not found for this site.</p>';
      return;
    }
    if (r.status === 403) {
      bodyEl.innerHTML = '<p class="error-text">You do not have permission to read this transcript.</p>';
      return;
    }
    if (!r.ok) {
      bodyEl.innerHTML =
        '<p class="error-text">' + escapeHtml(r.body?.error || "Could not load transcript (" + r.status + ").") + "</p>";
      return;
    }
    const b = r.body;
    if (meta) {
      meta.textContent =
        "Updated " + formatAdminDate(b.updatedAt) + " · " + String((b.messages || []).length) + " messages shown (max 500).";
    }
    bodyEl.innerHTML = renderTranscriptMessages(b.messages || []);
  }

  async function loadConversationsModule(ctx) {
    const mount = "#dashboard-conversations-root";
    const tbody = $("conv-tbody");
    const loading = $("conv-loading");
    const empty = $("conv-empty");
    const table = $("conv-table");
    const banner = $("conv-banner");
    if (!tbody) return;

    if (!ctx.authenticated) {
      state.adminConversationsOk = null;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Sign in to list conversations for this site.", false);
      tbody.innerHTML = "";
      if (empty) empty.hidden = true;
      if (table) table.hidden = false;
      if (loading) loading.hidden = true;
      renderConvPagination(0);
      return;
    }

    if (loading) loading.hidden = false;
    setModuleLoading(mount);
    showSectionText(banner, "", false);

    const path = adminListQuery("/api/admin/conversations", convListState);
    const r = await api(path);

    if (loading) loading.hidden = true;

    if (r.status === 403) {
      state.adminConversationsOk = false;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Your role cannot read funnel/conversation data (funnel:read).", true);
      tbody.innerHTML = "";
      if (empty) empty.hidden = true;
      if (table) table.hidden = false;
      renderConvPagination(0);
      return;
    }
    if (r.status === 401) {
      state.adminConversationsOk = false;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Session expired — refresh the page or sign in again.", true);
      tbody.innerHTML = "";
      renderConvPagination(0);
      return;
    }
    if (!r.ok) {
      state.adminConversationsOk = false;
      setModuleUnavailable(mount);
      showSectionText(banner, r.body?.error || "Could not load conversations (" + r.status + ").", true);
      tbody.innerHTML = "";
      renderConvPagination(0);
      return;
    }

    state.adminConversationsOk = true;
    setModuleReady(mount);
    const items = r.body.items || [];
    const total = typeof r.body.total === "number" ? r.body.total : items.length;

    if (!items.length) {
      tbody.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = convListState.q
          ? "No conversations match your search."
          : "No conversations match your filters yet.";
      }
      if (table) table.hidden = true;
      renderConvPagination(total);
      return;
    }

    if (empty) empty.hidden = true;
    if (table) table.hidden = false;
    tbody.innerHTML = items
      .map((row) => {
        const id = escapeHtml(row.id);
        const lastAt = escapeHtml(formatAdminDate(row.lastMessageAt || row.updatedAt));
        const cnt = escapeHtml(String(row.messageCount ?? "0"));
        const u = escapeHtml((row.lastUserMessage || "").slice(0, 120));
        const a = escapeHtml((row.lastAssistantMessage || "").slice(0, 120));
        return (
          "<tr>" +
          "<td>" +
          lastAt +
          "</td>" +
          "<td>" +
          cnt +
          "</td>" +
          '<td class="cell-clip" title="' +
          escapeHtml(row.lastUserMessage || "") +
          '">' +
          u +
          (row.lastUserMessage && String(row.lastUserMessage).length > 120 ? "…" : "") +
          "</td>" +
          '<td class="cell-clip" title="' +
          escapeHtml(row.lastAssistantMessage || "") +
          '">' +
          a +
          (row.lastAssistantMessage && String(row.lastAssistantMessage).length > 120 ? "…" : "") +
          "</td>" +
          '<td><button type="button" class="secondary btn-transcript" data-conv-id="' +
          id +
          '">View transcript</button></td>' +
          "</tr>"
        );
      })
      .join("");

    tbody.querySelectorAll(".btn-transcript").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-conv-id");
        if (id) openTranscriptModal(id);
      });
    });

    renderConvPagination(total);
  }

  async function loadLeadsModule(ctx) {
    const mount = "#dashboard-leads-root";
    const tbody = $("leads-tbody");
    const loading = $("leads-loading");
    const empty = $("leads-empty");
    const table = $("leads-table");
    const banner = $("leads-banner");
    if (!tbody) return;

    if (!ctx.authenticated) {
      state.adminLeadsOk = null;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Sign in to list leads for this site.", false);
      tbody.innerHTML = "";
      leadsRowsCache = [];
      if (empty) empty.hidden = true;
      if (table) table.hidden = false;
      if (loading) loading.hidden = true;
      renderLeadsPagination(0);
      return;
    }

    if (loading) loading.hidden = false;
    setModuleLoading(mount);
    showSectionText(banner, "", false);

    const path = adminListQuery("/api/admin/leads", leadsListState);
    const r = await api(path);

    if (loading) loading.hidden = true;

    if (r.status === 403) {
      state.adminLeadsOk = false;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Your role cannot read leads (funnel:read).", true);
      tbody.innerHTML = "";
      leadsRowsCache = [];
      renderLeadsPagination(0);
      return;
    }
    if (r.status === 401) {
      state.adminLeadsOk = false;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Session expired — refresh the page or sign in again.", true);
      tbody.innerHTML = "";
      leadsRowsCache = [];
      renderLeadsPagination(0);
      return;
    }
    if (!r.ok) {
      state.adminLeadsOk = false;
      setModuleUnavailable(mount);
      showSectionText(banner, r.body?.error || "Could not load leads (" + r.status + ").", true);
      tbody.innerHTML = "";
      leadsRowsCache = [];
      renderLeadsPagination(0);
      return;
    }

    state.adminLeadsOk = true;
    setModuleReady(mount);
    const items = r.body.items || [];
    const total = typeof r.body.total === "number" ? r.body.total : items.length;
    leadsRowsCache = items;

    if (!items.length) {
      tbody.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = leadsListState.q
          ? "No leads match your search."
          : "No leads captured yet for this site.";
      }
      if (table) table.hidden = true;
      renderLeadsPagination(total);
      return;
    }

    if (empty) empty.hidden = true;
    if (table) table.hidden = false;
    tbody.innerHTML = items
      .map((row) => {
        const convId = row.conversationId;
        const convCell =
          convId != null && String(convId)
            ? '<button type="button" class="secondary btn-open-conv" data-conv-id="' +
              escapeHtml(String(convId)) +
              '">Open thread</button>'
            : '<span class="muted">—</span>';
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(formatAdminDate(row.createdAt)) +
          "</td>" +
          "<td>" +
          escapeHtml(row.name) +
          "</td>" +
          "<td>" +
          escapeHtml(row.email) +
          "</td>" +
          "<td>" +
          escapeHtml(row.phone) +
          "</td>" +
          "<td>" +
          escapeHtml(row.source || "") +
          "</td>" +
          "<td>" +
          escapeHtml(row.status || "") +
          "</td>" +
          "<td>" +
          convCell +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    tbody.querySelectorAll(".btn-open-conv").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-conv-id");
        if (id) openTranscriptModal(id);
      });
    });

    renderLeadsPagination(total);
  }

  function renderKnPagination(total) {
    const root = $("kn-pagination");
    if (!root) return;
    const lim = knowledgeListState.limit;
    const off = knowledgeListState.offset;
    if (total <= lim && off === 0) {
      root.innerHTML = "";
      return;
    }
    const start = total === 0 ? 0 : off + 1;
    const end = Math.min(off + lim, total);
    const prevDisabled = off <= 0;
    const nextDisabled = off + lim >= total;
    root.innerHTML =
      '<span class="pagination-meta muted small">' +
      escapeHtml(String(start) + "–" + String(end) + " of " + String(total)) +
      "</span>" +
      '<button type="button" class="secondary" id="btn-kn-prev"' +
      (prevDisabled ? " disabled" : "") +
      ">Previous</button>" +
      '<button type="button" class="secondary" id="btn-kn-next"' +
      (nextDisabled ? " disabled" : "") +
      ">Next</button>";
    const prev = $("btn-kn-prev");
    const next = $("btn-kn-next");
    if (prev && !prevDisabled) {
      prev.addEventListener("click", () => {
        knowledgeListState.offset = Math.max(0, off - lim);
        loadKnowledgeBaseModule(getAdminContext());
      });
    }
    if (next && !nextDisabled) {
      next.addEventListener("click", () => {
        knowledgeListState.offset = off + lim;
        loadKnowledgeBaseModule(getAdminContext());
      });
    }
  }

  function closeKnowledgeAddModal() {
    const m = $("knowledge-add-modal");
    if (m) m.hidden = true;
    const st = $("kn-add-status");
    if (st) st.textContent = "";
  }

  function openKnowledgeAddModal() {
    const ctx = getAdminContext();
    if (!ctx.operatorCapable) {
      showGlobalToast("Adding knowledge needs owner, admin, or operator role.", "info", 5000);
      return;
    }
    const m = $("knowledge-add-modal");
    if ($("kn-add-title")) $("kn-add-title").value = "";
    if ($("kn-add-source")) $("kn-add-source").value = "";
    if ($("kn-add-content")) $("kn-add-content").value = "";
    if (m) m.hidden = false;
  }

  function closeKnowledgeDetailModal() {
    const m = $("knowledge-detail-modal");
    if (m) m.hidden = true;
    knowledgeDetailCache = null;
  }

  function knowledgeDetailPlainText() {
    if (!knowledgeDetailCache) return "";
    const c = knowledgeDetailCache.content;
    if (c != null && String(c)) return String(c);
    const ch = knowledgeDetailCache.chunks;
    if (!Array.isArray(ch)) return "";
    return ch.map((x) => String(x.content || "")).join("\n\n");
  }

  function syncKnowledgeDetailActionButtons(ctx) {
    const canWrite = ctx.operatorCapable;
    const arch = $("btn-kn-archive");
    const rest = $("btn-kn-restore");
    const del = $("btn-kn-delete");
    const st = knowledgeDetailCache && knowledgeDetailCache.status;
    if (arch) {
      arch.hidden = !canWrite || st !== "active";
      arch.disabled = !canWrite || st !== "active";
    }
    if (rest) {
      rest.hidden = !canWrite || st !== "archived";
      rest.disabled = !canWrite || st !== "archived";
    }
    if (del) {
      del.hidden = !canWrite;
      del.disabled = !canWrite;
    }
  }

  async function openKnowledgeItem(id) {
    const r = await api("/api/admin/knowledge/" + encodeURIComponent(id));
    if (!r.ok) {
      showGlobalToast(r.body?.error || "Could not load knowledge (" + r.status + ").", "error");
      return;
    }
    knowledgeDetailCache = r.body;
    const modal = $("knowledge-detail-modal");
    const titleEl = $("knowledge-detail-title");
    const meta = $("knowledge-detail-meta");
    const chunksEl = $("knowledge-detail-chunks");
    if (titleEl) titleEl.textContent = r.body.title || "Knowledge";
    if (meta) {
      meta.textContent =
        "Status: " +
        (r.body.status || "—") +
        " · Updated " +
        formatAdminDate(r.body.updatedAt) +
        " · Source: " +
        (r.body.source || "—") +
        " · " +
        String((r.body.chunks || []).length) +
        " chunks";
    }
    if (chunksEl) {
      const parts = (r.body.chunks || []).map((ch, i) => {
        return (
          '<div class="knowledge-chunk-block">' +
          '<div class="knowledge-chunk-head muted small">Chunk ' +
          escapeHtml(String(i + 1)) +
          " · " +
          escapeHtml(formatAdminDate(ch.createdAt)) +
          "</div>" +
          '<div class="knowledge-chunk-body">' +
          escapeHtml(ch.content || "").replace(/\r\n/g, "\n").replace(/\n/g, "<br />") +
          "</div></div>"
        );
      });
      chunksEl.innerHTML = parts.length ? parts.join("") : '<p class="muted">No chunks.</p>';
    }
    syncKnowledgeDetailActionButtons(getAdminContext());
    if (modal) modal.hidden = false;
  }

  function syncKnowledgeAddButton(ctx) {
    const addBtn = $("btn-kn-add");
    if (addBtn) {
      addBtn.disabled = !ctx.authenticated || !ctx.operatorCapable;
      addBtn.title =
        !ctx.authenticated || !ctx.operatorCapable
          ? "Requires sign-in and owner, admin, or operator role to add knowledge."
          : "";
    }
  }

  async function loadKnowledgeBaseModule(ctx) {
    const mount = "#dashboard-knowledge-root";
    const tbody = $("kn-tbody");
    const loading = $("kn-loading");
    const empty = $("kn-empty");
    const table = $("kn-table");
    const banner = $("kn-banner");
    if (!tbody) return;

    if (!ctx.authenticated) {
      state.adminKnowledgeReadOk = null;
      state.adminKnowledgeTotal = 0;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Sign in to manage knowledge for this site.", false);
      tbody.innerHTML = "";
      if (empty) empty.hidden = true;
      if (table) table.hidden = false;
      if (loading) loading.hidden = true;
      renderKnPagination(0);
      syncKnowledgeAddButton(ctx);
      return;
    }

    if (loading) loading.hidden = false;
    setModuleLoading(mount);
    showSectionText(banner, "", false);

    const path = adminListQuery("/api/admin/knowledge", knowledgeListState);
    const r = await api(path);

    if (loading) loading.hidden = true;

    if (r.status === 403) {
      state.adminKnowledgeReadOk = false;
      state.adminKnowledgeTotal = 0;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Your role cannot read knowledge (config:read).", true);
      tbody.innerHTML = "";
      renderKnPagination(0);
      syncKnowledgeAddButton(ctx);
      return;
    }
    if (r.status === 401) {
      state.adminKnowledgeReadOk = false;
      state.adminKnowledgeTotal = 0;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Session expired — refresh the page or sign in again.", true);
      tbody.innerHTML = "";
      renderKnPagination(0);
      syncKnowledgeAddButton(ctx);
      return;
    }
    if (!r.ok) {
      state.adminKnowledgeReadOk = false;
      state.adminKnowledgeTotal = 0;
      setModuleUnavailable(mount);
      showSectionText(banner, r.body?.error || "Could not load knowledge (" + r.status + ").", true);
      tbody.innerHTML = "";
      renderKnPagination(0);
      syncKnowledgeAddButton(ctx);
      return;
    }

    state.adminKnowledgeReadOk = true;
    setModuleReady(mount);
    const items = r.body.items || [];
    const total = typeof r.body.total === "number" ? r.body.total : items.length;
    state.adminKnowledgeTotal = total;

    if (!items.length) {
      tbody.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = knowledgeListState.q
          ? "No knowledge documents match your search."
          : "No knowledge has been added yet.";
      }
      if (table) table.hidden = true;
      renderKnPagination(total);
      syncKnowledgeAddButton(ctx);
      return;
    }

    if (empty) empty.hidden = true;
    if (table) table.hidden = false;
    tbody.innerHTML = items
      .map((row) => {
        const id = escapeHtml(row.id);
        const st = escapeHtml(row.status || "");
        const badgeClass =
          String(row.status || "").toLowerCase() === "archived" ? "kb-status kb-status--archived" : "kb-status kb-status--active";
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(formatAdminDate(row.updatedAt)) +
          "</td>" +
          "<td>" +
          escapeHtml(row.title) +
          "</td>" +
          "<td class=\"cell-clip\">" +
          escapeHtml(row.source || "") +
          "</td>" +
          '<td><span class="' +
          badgeClass +
          '">' +
          st +
          "</span></td>" +
          "<td>" +
          escapeHtml(String(row.chunkCount ?? 0)) +
          "</td>" +
          '<td class="cell-clip" title="' +
          escapeHtml(row.preview || "") +
          '">' +
          escapeHtml((row.preview || "").slice(0, 100)) +
          ((row.preview || "").length > 100 ? "…" : "") +
          "</td>" +
          '<td><button type="button" class="secondary btn-kn-view" data-kn-id="' +
          id +
          '">View</button></td>' +
          "</tr>"
        );
      })
      .join("");

    tbody.querySelectorAll(".btn-kn-view").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kid = btn.getAttribute("data-kn-id");
        if (kid) openKnowledgeItem(kid);
      });
    });

    renderKnPagination(total);
    syncKnowledgeAddButton(ctx);
  }

  async function saveKnowledgeFromForm() {
    const ctx = getAdminContext();
    if (!ctx.operatorCapable) return;
    const title = ($("kn-add-title") && $("kn-add-title").value.trim()) || "";
    const source = ($("kn-add-source") && $("kn-add-source").value.trim()) || "";
    const content = ($("kn-add-content") && $("kn-add-content").value) || "";
    const statusEl = $("kn-add-status");
    if (statusEl) statusEl.textContent = "";
    if (!title) {
      if (statusEl) statusEl.textContent = "Title is required.";
      return;
    }
    if (!String(content).trim()) {
      if (statusEl) statusEl.textContent = "Content is required.";
      return;
    }
    const r = await api("/api/admin/knowledge", {
      method: "POST",
      body: JSON.stringify({ title, source, content }),
    });
    if (r.status === 403) {
      if (statusEl) statusEl.textContent = "Your role cannot create knowledge (config:write).";
      return;
    }
    if (!r.ok) {
      if (statusEl) statusEl.textContent = r.body?.error || "Save failed (" + r.status + ").";
      return;
    }
    showGlobalToast("Knowledge saved.", "success");
    closeKnowledgeAddModal();
    knowledgeListState.offset = 0;
    await loadKnowledgeBaseModule(getAdminContext());
    applyModuleRegistryAfterLoad(getAdminContext());
  }

  async function patchKnowledgeDocument(id, status) {
    const r = await api("/api/admin/knowledge/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    if (!r.ok) {
      showGlobalToast(r.body?.error || "Update failed (" + r.status + ").", "error");
      return false;
    }
    showGlobalToast(status === "archived" ? "Archived." : "Restored to active.", "success");
    return true;
  }

  async function deleteKnowledgeDocument(id) {
    const r = await api("/api/admin/knowledge/" + encodeURIComponent(id), { method: "DELETE" });
    if (r.status === 404) {
      showGlobalToast("Already removed.", "info");
      return true;
    }
    if (!r.ok && r.status !== 204) {
      showGlobalToast(r.body?.error || "Delete failed (" + r.status + ").", "error");
      return false;
    }
    showGlobalToast("Knowledge deleted.", "success", 4000);
    return true;
  }

  async function runKnowledgeRetrievalTest() {
    const qEl = $("kn-retrieval-q");
    const out = $("kn-retrieval-out");
    const q = qEl ? qEl.value.trim() : "";
    if (!q) {
      showGlobalToast("Enter a sample question first.", "info");
      return;
    }
    const ctx = getAdminContext();
    if (!ctx.authenticated) {
      showGlobalToast("Sign in to test retrieval.", "info");
      return;
    }
    const r = await api("/api/admin/knowledge-retrieval?q=" + encodeURIComponent(q));
    if (!r.ok) {
      if (out) {
        out.hidden = false;
        out.textContent = JSON.stringify(r.body || { error: r.status }, null, 2);
      }
      return;
    }
    if (out) {
      out.hidden = false;
      out.textContent = JSON.stringify(r.body, null, 2);
    }
  }

  function downloadLeadsCsv() {
    const rows = leadsRowsCache || [];
    if (!rows.length) {
      showGlobalToast("No lead rows loaded to export.", "info");
      return;
    }
    const headers = ["id", "name", "email", "phone", "source", "status", "createdAt", "conversationId"];
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(
        headers
          .map((h) => esc(h === "createdAt" && row[h] ? new Date(row[h]).toISOString() : row[h]))
          .join(",")
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "leads-" + tenantSlug() + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
    showGlobalToast("CSV downloaded.", "success");
  }

  function wireConversationsLeadsUi() {
    const qIn = $("conv-q");
    if ($("btn-conv-search")) {
      $("btn-conv-search").addEventListener("click", () => {
        convListState.q = qIn ? qIn.value.trim() : "";
        convListState.offset = 0;
        loadConversationsModule(getAdminContext());
      });
    }
    if ($("btn-conv-refresh")) {
      $("btn-conv-refresh").addEventListener("click", () => {
        loadConversationsModule(getAdminContext());
      });
    }
    if (qIn) {
      qIn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          convListState.q = qIn.value.trim();
          convListState.offset = 0;
          loadConversationsModule(getAdminContext());
        }
      });
    }

    const lq = $("leads-q");
    if ($("btn-leads-search")) {
      $("btn-leads-search").addEventListener("click", () => {
        leadsListState.q = lq ? lq.value.trim() : "";
        leadsListState.offset = 0;
        loadLeadsModule(getAdminContext());
      });
    }
    if ($("btn-leads-refresh")) {
      $("btn-leads-refresh").addEventListener("click", () => {
        loadLeadsModule(getAdminContext());
      });
    }
    if ($("btn-leads-csv")) {
      $("btn-leads-csv").addEventListener("click", downloadLeadsCsv);
    }
    if (lq) {
      lq.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          leadsListState.q = lq.value.trim();
          leadsListState.offset = 0;
          loadLeadsModule(getAdminContext());
        }
      });
    }

    if ($("btn-transcript-close")) {
      $("btn-transcript-close").addEventListener("click", closeTranscriptModal);
    }
    if ($("btn-transcript-copy")) {
      $("btn-transcript-copy").addEventListener("click", () => {
        copyToClipboard(transcriptPlainText, "Transcript copied.");
      });
    }
    const modal = $("transcript-modal");
    if (modal) {
      modal.addEventListener("click", (ev) => {
        if (ev.target === modal) closeTranscriptModal();
      });
    }
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (modal && !modal.hidden) {
        closeTranscriptModal();
        return;
      }
      const kdm = $("knowledge-detail-modal");
      if (kdm && !kdm.hidden) {
        closeKnowledgeDetailModal();
        return;
      }
      const kam = $("knowledge-add-modal");
      if (kam && !kam.hidden) closeKnowledgeAddModal();
    });
  }

  function wireKnowledgeUi() {
    const knQ = $("kn-q");
    if ($("btn-kn-search")) {
      $("btn-kn-search").addEventListener("click", () => {
        knowledgeListState.q = knQ ? knQ.value.trim() : "";
        knowledgeListState.offset = 0;
        loadKnowledgeBaseModule(getAdminContext());
      });
    }
    if ($("btn-kn-refresh")) {
      $("btn-kn-refresh").addEventListener("click", () => {
        loadKnowledgeBaseModule(getAdminContext());
      });
    }
    if (knQ) {
      knQ.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          knowledgeListState.q = knQ.value.trim();
          knowledgeListState.offset = 0;
          loadKnowledgeBaseModule(getAdminContext());
        }
      });
    }
    if ($("btn-kn-add")) $("btn-kn-add").addEventListener("click", openKnowledgeAddModal);
    if ($("btn-kn-add-close")) $("btn-kn-add-close").addEventListener("click", closeKnowledgeAddModal);
    if ($("btn-kn-add-cancel")) $("btn-kn-add-cancel").addEventListener("click", closeKnowledgeAddModal);
    if ($("btn-kn-save")) $("btn-kn-save").addEventListener("click", () => saveKnowledgeFromForm());
    const addModal = $("knowledge-add-modal");
    if (addModal) {
      addModal.addEventListener("click", (ev) => {
        if (ev.target === addModal) closeKnowledgeAddModal();
      });
    }

    if ($("btn-kn-retrieval")) $("btn-kn-retrieval").addEventListener("click", runKnowledgeRetrievalTest);

    if ($("btn-kn-detail-close")) $("btn-kn-detail-close").addEventListener("click", closeKnowledgeDetailModal);
    const detModal = $("knowledge-detail-modal");
    if (detModal) {
      detModal.addEventListener("click", (ev) => {
        if (ev.target === detModal) closeKnowledgeDetailModal();
      });
    }
    if ($("btn-kn-detail-copy")) {
      $("btn-kn-detail-copy").addEventListener("click", () => {
        copyToClipboard(knowledgeDetailPlainText(), "Knowledge text copied.");
      });
    }
    if ($("btn-kn-archive")) {
      $("btn-kn-archive").addEventListener("click", async () => {
        if (!knowledgeDetailCache || !knowledgeDetailCache.id) return;
        const ok = await patchKnowledgeDocument(knowledgeDetailCache.id, "archived");
        if (ok) {
          await openKnowledgeItem(knowledgeDetailCache.id);
          await loadKnowledgeBaseModule(getAdminContext());
          applyModuleRegistryAfterLoad(getAdminContext());
        }
      });
    }
    if ($("btn-kn-restore")) {
      $("btn-kn-restore").addEventListener("click", async () => {
        if (!knowledgeDetailCache || !knowledgeDetailCache.id) return;
        const ok = await patchKnowledgeDocument(knowledgeDetailCache.id, "active");
        if (ok) {
          await openKnowledgeItem(knowledgeDetailCache.id);
          await loadKnowledgeBaseModule(getAdminContext());
          applyModuleRegistryAfterLoad(getAdminContext());
        }
      });
    }
    if ($("btn-kn-delete")) {
      $("btn-kn-delete").addEventListener("click", async () => {
        if (!knowledgeDetailCache || !knowledgeDetailCache.id) return;
        if (
          !confirm(
            "Permanently delete this knowledge document and all its chunks? This cannot be undone."
          )
        )
          return;
        const ok = await deleteKnowledgeDocument(knowledgeDetailCache.id);
        if (ok) {
          closeKnowledgeDetailModal();
          await loadKnowledgeBaseModule(getAdminContext());
          applyModuleRegistryAfterLoad(getAdminContext());
        }
      });
    }
  }

  let behaviorDirty = false;
  let behaviorBaseline = "";
  let behaviorLoaded = false;
  let bpDirty = false;
  let bpBaseline = "";
  let bpLoaded = false;

  function defaultBehaviorPayload() {
    return {
      greeting: "",
      tone: "professional",
      businessRole: "",
      primaryGoal: "",
      fallbackAnswer: "",
      escalationInstructions: "",
      leadCaptureInstructions: "",
      avoidTopics: "",
      specialRules: "",
    };
  }

  function defaultBpPayload() {
    return {
      businessName: "",
      shortDescription: "",
      services: "",
      serviceAreas: "",
      address: "",
      phone: "",
      email: "",
      website: "",
      bookingUrl: "",
      hours: "",
      afterHoursMessage: "",
      escalationContact: "",
      policies: "",
    };
  }

  function readBehaviorFromForm() {
    const toneEl = $("bb-tone");
    return {
      greeting: ($("bb-greeting") && $("bb-greeting").value.trim()) || "",
      tone: (toneEl && toneEl.value) || "professional",
      businessRole: ($("bb-business-role") && $("bb-business-role").value.trim()) || "",
      primaryGoal: ($("bb-primary-goal") && $("bb-primary-goal").value.trim()) || "",
      fallbackAnswer: ($("bb-fallback") && $("bb-fallback").value.trim()) || "",
      escalationInstructions: ($("bb-escalation") && $("bb-escalation").value.trim()) || "",
      leadCaptureInstructions: ($("bb-lead-capture") && $("bb-lead-capture").value.trim()) || "",
      avoidTopics: ($("bb-avoid") && $("bb-avoid").value.trim()) || "",
      specialRules: ($("bb-special") && $("bb-special").value.trim()) || "",
    };
  }

  function applyBehaviorToForm(b) {
    const x = b && typeof b === "object" ? b : defaultBehaviorPayload();
    if ($("bb-greeting")) $("bb-greeting").value = x.greeting || "";
    if ($("bb-tone")) $("bb-tone").value = x.tone || "professional";
    if ($("bb-business-role")) $("bb-business-role").value = x.businessRole || "";
    if ($("bb-primary-goal")) $("bb-primary-goal").value = x.primaryGoal || "";
    if ($("bb-fallback")) $("bb-fallback").value = x.fallbackAnswer || "";
    if ($("bb-escalation")) $("bb-escalation").value = x.escalationInstructions || "";
    if ($("bb-lead-capture")) $("bb-lead-capture").value = x.leadCaptureInstructions || "";
    if ($("bb-avoid")) $("bb-avoid").value = x.avoidTopics || "";
    if ($("bb-special")) $("bb-special").value = x.specialRules || "";
  }

  function updateBehaviorDirtyState() {
    if (!behaviorLoaded) return;
    const cur = JSON.stringify(readBehaviorFromForm());
    behaviorDirty = cur !== behaviorBaseline;
    const d = $("bb-dirty");
    if (d) d.hidden = !behaviorDirty;
    syncBehaviorReadOnly(getAdminContext());
  }

  function setBehaviorBaselineFromForm() {
    behaviorBaseline = JSON.stringify(readBehaviorFromForm());
    behaviorDirty = false;
    const d = $("bb-dirty");
    if (d) d.hidden = true;
  }

  function syncBehaviorPreview() {
    const b = readBehaviorFromForm();
    const pt = $("bb-preview-tone");
    if (pt) pt.textContent = b.tone || "professional";
    const g = $("bb-preview-greeting");
    if (g) {
      g.textContent = b.greeting ? "Greeting: " + b.greeting : "No custom greeting set.";
    }
    const f = $("bb-preview-fallback");
    if (f) {
      f.textContent = b.fallbackAnswer ? "Fallback: " + b.fallbackAnswer.slice(0, 200) + (b.fallbackAnswer.length > 200 ? "…" : "") : "";
    }
    const e = $("bb-preview-escalation");
    if (e) {
      e.textContent = b.escalationInstructions
        ? "Escalation: " + b.escalationInstructions.slice(0, 200) + (b.escalationInstructions.length > 200 ? "…" : "")
        : "";
    }
  }

  function syncBehaviorReadOnly(ctx) {
    const wrap = $("bb-form-wrap");
    const ro = !ctx.operatorCapable;
    if (wrap) wrap.classList.toggle("behavior-readonly", ro);
    const ids = [
      "bb-greeting",
      "bb-tone",
      "bb-business-role",
      "bb-primary-goal",
      "bb-fallback",
      "bb-escalation",
      "bb-lead-capture",
      "bb-avoid",
      "bb-special",
    ];
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.disabled = ro;
    });
    const save = $("btn-bb-save");
    const reset = $("btn-bb-reset");
    if (save) save.disabled = ro || !ctx.authenticated || !behaviorLoaded || !behaviorDirty;
    if (reset) reset.disabled = ro || !ctx.authenticated;
  }

  function updateBehaviorLastSaved(behavior) {
    const el = $("bb-last-saved");
    if (!el) return;
    const u = behavior && behavior.updatedAt;
    el.textContent = u ? "Last updated: " + formatAdminDate(u) : "Not saved yet (defaults shown).";
  }

  async function loadBotBehaviorModule(ctx) {
    const mount = "#dashboard-bot-behavior-root";
    const banner = $("bb-banner");
    behaviorLoaded = false;
    if (!mount || !$("bb-greeting")) return;

    if (!ctx.authenticated) {
      state.adminBotBehaviorReadOk = null;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Sign in to view and edit bot behavior for this site.", false);
      applyBehaviorToForm(defaultBehaviorPayload());
      syncBehaviorPreview();
      syncBehaviorReadOnly(ctx);
      updateBehaviorLastSaved(null);
      return;
    }

    setModuleLoading(mount);
    showSectionText(banner, "", false);
    const r = await api("/api/admin/bot-behavior");

    if (r.status === 403) {
      state.adminBotBehaviorReadOk = false;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Your role cannot read bot behavior (config:read).", true);
      applyBehaviorToForm(defaultBehaviorPayload());
      syncBehaviorPreview();
      syncBehaviorReadOnly(ctx);
      updateBehaviorLastSaved(null);
      setModuleReady(mount);
      return;
    }
    if (!r.ok) {
      state.adminBotBehaviorReadOk = false;
      setModuleUnavailable(mount);
      showSectionText(banner, r.body?.error || "Could not load bot behavior (" + r.status + ").", true);
      applyBehaviorToForm(defaultBehaviorPayload());
      syncBehaviorPreview();
      syncBehaviorReadOnly(ctx);
      return;
    }

    state.adminBotBehaviorReadOk = true;
    setModuleReady(mount);
    const b = r.body.behavior || defaultBehaviorPayload();
    applyBehaviorToForm(b);
    behaviorLoaded = true;
    setBehaviorBaselineFromForm();
    syncBehaviorPreview();
    syncBehaviorReadOnly(ctx);
    updateBehaviorLastSaved(b);
    if (r.body.defaultsApplied) {
      showSectionText(banner, "Defaults are shown until you save — nothing is stored yet.", false);
    } else {
      showSectionText(banner, "", false);
    }
  }

  async function saveBotBehavior() {
    const ctx = getAdminContext();
    if (!ctx.operatorCapable) return;
    const behavior = readBehaviorFromForm();
    const r = await api("/api/admin/bot-behavior", {
      method: "PATCH",
      body: JSON.stringify({ behavior }),
    });
    if (r.status === 403) {
      showGlobalToast("Your role cannot save bot behavior (config:write).", "error");
      return;
    }
    if (!r.ok) {
      const det = r.body?.details;
      const msg = det
        ? "Validation failed: " + JSON.stringify(det)
        : r.body?.error || "Save failed (" + r.status + ").";
      showGlobalToast(msg, "error", 7000);
      return;
    }
    showGlobalToast("Bot behavior saved.", "success");
    applyBehaviorToForm(r.body.behavior);
    setBehaviorBaselineFromForm();
    syncBehaviorPreview();
    updateBehaviorLastSaved(r.body.behavior);
    const ban = $("bb-banner");
    if (ban) showSectionText(ban, "", false);
    syncBehaviorReadOnly(getAdminContext());
    applyModuleRegistryAfterLoad(getAdminContext());
  }

  async function resetBotBehaviorToDefaults() {
    const ctx = getAdminContext();
    if (!ctx.operatorCapable) return;
    if (!confirm("Reset guided bot behavior to defaults on the server? This clears custom text for this site.")) return;
    const behavior = defaultBehaviorPayload();
    const r = await api("/api/admin/bot-behavior", {
      method: "PATCH",
      body: JSON.stringify({ behavior }),
    });
    if (!r.ok) {
      showGlobalToast(r.body?.error || "Reset failed (" + r.status + ").", "error");
      return;
    }
    showGlobalToast("Behavior reset to defaults.", "success");
    applyBehaviorToForm(r.body.behavior);
    setBehaviorBaselineFromForm();
    syncBehaviorPreview();
    updateBehaviorLastSaved(r.body.behavior);
    const ban = $("bb-banner");
    if (ban) showSectionText(ban, "", false);
    syncBehaviorReadOnly(getAdminContext());
    applyModuleRegistryAfterLoad(getAdminContext());
  }

  function readBpFromForm() {
    return {
      businessName: val("bp-business-name"),
      shortDescription: ($("bp-short-description") && $("bp-short-description").value.trim()) || "",
      services: ($("bp-services") && $("bp-services").value.trim()) || "",
      serviceAreas: ($("bp-service-areas") && $("bp-service-areas").value.trim()) || "",
      address: val("bp-address"),
      phone: val("bp-phone"),
      email: val("bp-email"),
      website: val("bp-website"),
      bookingUrl: val("bp-booking-url"),
      hours: ($("bp-hours") && $("bp-hours").value.trim()) || "",
      afterHoursMessage: ($("bp-after-hours") && $("bp-after-hours").value.trim()) || "",
      escalationContact: ($("bp-escalation") && $("bp-escalation").value.trim()) || "",
      policies: ($("bp-policies") && $("bp-policies").value.trim()) || "",
    };
  }

  function applyBpToForm(p) {
    const x = p && typeof p === "object" ? p : defaultBpPayload();
    const setv = (id, v) => {
      const el = $(id);
      if (el) el.value = v == null ? "" : String(v);
    };
    setv("bp-business-name", x.businessName);
    setv("bp-short-description", x.shortDescription);
    setv("bp-services", x.services);
    setv("bp-service-areas", x.serviceAreas);
    setv("bp-address", x.address);
    setv("bp-phone", x.phone);
    setv("bp-email", x.email);
    setv("bp-website", x.website);
    setv("bp-booking-url", x.bookingUrl);
    setv("bp-hours", x.hours);
    setv("bp-after-hours", x.afterHoursMessage);
    setv("bp-escalation", x.escalationContact);
    setv("bp-policies", x.policies);
  }

  function syncBpPreview() {
    const p = readBpFromForm();
    const nameEl = $("bp-preview-name");
    if (nameEl) nameEl.textContent = p.businessName || "—";
    const contactParts = [];
    if (p.phone) contactParts.push("Phone: " + p.phone);
    if (p.email) contactParts.push("Email: " + p.email);
    if (p.address) contactParts.push(p.address);
    if (p.website) contactParts.push(p.website);
    const c = $("bp-preview-contact");
    if (c) c.textContent = contactParts.join(" · ") || "No contact fields yet.";
    const h = $("bp-preview-hours");
    if (h) h.textContent = p.hours ? "Hours: " + p.hours : "";
    const s = $("bp-preview-services");
    if (s) {
      const ex = p.services ? p.services.slice(0, 220) + (p.services.length > 220 ? "…" : "") : "";
      s.textContent = ex ? "Services: " + ex : "";
    }
    const b = $("bp-preview-booking");
    if (b) b.textContent = p.bookingUrl ? "Booking: " + p.bookingUrl : "";
  }

  function updateBpDirtyState() {
    if (!bpLoaded) return;
    const cur = JSON.stringify(readBpFromForm());
    bpDirty = cur !== bpBaseline;
    const d = $("bp-dirty");
    if (d) d.hidden = !bpDirty;
    syncBpReadOnly(getAdminContext());
  }

  function setBpBaselineFromForm() {
    bpBaseline = JSON.stringify(readBpFromForm());
    bpDirty = false;
    const d = $("bp-dirty");
    if (d) d.hidden = true;
  }

  function syncBpReadOnly(ctx) {
    const wrap = $("bp-form-wrap");
    const ro = !ctx.operatorCapable;
    if (wrap) wrap.classList.toggle("business-profile-readonly", ro);
    const ids = [
      "bp-business-name",
      "bp-short-description",
      "bp-services",
      "bp-service-areas",
      "bp-address",
      "bp-phone",
      "bp-email",
      "bp-website",
      "bp-booking-url",
      "bp-hours",
      "bp-after-hours",
      "bp-escalation",
      "bp-policies",
    ];
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.disabled = ro;
    });
    const save = $("btn-bp-save");
    const reset = $("btn-bp-reset");
    if (save) save.disabled = ro || !ctx.authenticated || !bpLoaded || !bpDirty;
    if (reset) reset.disabled = ro || !ctx.authenticated;
  }

  function updateBpLastSaved(profile) {
    const el = $("bp-last-updated");
    if (!el) return;
    const u = profile && profile.updatedAt;
    el.textContent = u ? "Last updated: " + formatAdminDate(u) : "Not saved yet (defaults shown).";
  }

  async function loadBusinessProfileModule(ctx) {
    const mount = "#dashboard-business-profile-root";
    const banner = $("bp-banner");
    bpLoaded = false;
    if (!$("bp-business-name")) return;

    if (!ctx.authenticated) {
      state.adminBusinessProfileReadOk = null;
      state.businessProfileDefaultsApplied = null;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Sign in to view and edit the business profile for this site.", false);
      applyBpToForm(defaultBpPayload());
      syncBpPreview();
      syncBpReadOnly(ctx);
      updateBpLastSaved(null);
      return;
    }

    setModuleLoading(mount);
    showSectionText(banner, "", false);
    const r = await api("/api/admin/business-profile");

    if (r.status === 403) {
      state.adminBusinessProfileReadOk = false;
      state.businessProfileDefaultsApplied = null;
      setModuleNeedsSetup(mount);
      showSectionText(banner, "Your role cannot read the business profile (config:read).", true);
      applyBpToForm(defaultBpPayload());
      syncBpPreview();
      syncBpReadOnly(ctx);
      updateBpLastSaved(null);
      setModuleReady(mount);
      return;
    }
    if (!r.ok) {
      state.adminBusinessProfileReadOk = false;
      state.businessProfileDefaultsApplied = null;
      setModuleUnavailable(mount);
      showSectionText(banner, r.body?.error || "Could not load business profile (" + r.status + ").", true);
      applyBpToForm(defaultBpPayload());
      syncBpPreview();
      syncBpReadOnly(ctx);
      return;
    }

    state.adminBusinessProfileReadOk = true;
    state.businessProfileDefaultsApplied = r.body.defaultsApplied === true;
    setModuleReady(mount);
    const p = r.body.businessProfile || defaultBpPayload();
    applyBpToForm(p);
    bpLoaded = true;
    setBpBaselineFromForm();
    syncBpPreview();
    syncBpReadOnly(ctx);
    updateBpLastSaved(p);
    if (r.body.defaultsApplied) {
      showSectionText(banner, "Defaults are shown until you save — nothing is stored yet.", false);
    } else {
      showSectionText(banner, "", false);
    }
  }

  async function saveBusinessProfile() {
    const ctx = getAdminContext();
    if (!ctx.operatorCapable) return;
    const businessProfile = readBpFromForm();
    const r = await api("/api/admin/business-profile", {
      method: "PATCH",
      body: JSON.stringify({ businessProfile }),
    });
    if (r.status === 403) {
      showGlobalToast("Your role cannot save the business profile (config:write).", "error");
      return;
    }
    if (!r.ok) {
      const det = r.body?.details;
      const msg = det
        ? "Validation failed: " + JSON.stringify(det)
        : r.body?.error || "Save failed (" + r.status + ").";
      showGlobalToast(msg, "error", 8000);
      return;
    }
    showGlobalToast("Business profile saved.", "success");
    applyBpToForm(r.body.businessProfile);
    setBpBaselineFromForm();
    syncBpPreview();
    updateBpLastSaved(r.body.businessProfile);
    const ban = $("bp-banner");
    if (ban) showSectionText(ban, "", false);
    state.businessProfileDefaultsApplied = r.body.defaultsApplied === true;
    syncBpReadOnly(getAdminContext());
    applyModuleRegistryAfterLoad(getAdminContext());
  }

  async function resetBusinessProfileFields() {
    const ctx = getAdminContext();
    if (!ctx.operatorCapable) return;
    if (!confirm("Clear every business profile field on the server for this site? This cannot be undone.")) return;
    applyBpToForm(defaultBpPayload());
    const businessProfile = readBpFromForm();
    const r = await api("/api/admin/business-profile", {
      method: "PATCH",
      body: JSON.stringify({ businessProfile }),
    });
    if (!r.ok) {
      showGlobalToast(r.body?.error || "Clear failed (" + r.status + ").", "error");
      return;
    }
    showGlobalToast("Business profile cleared.", "success");
    applyBpToForm(r.body.businessProfile);
    setBpBaselineFromForm();
    syncBpPreview();
    updateBpLastSaved(r.body.businessProfile);
    state.businessProfileDefaultsApplied = true;
    const ban = $("bp-banner");
    if (ban) showSectionText(ban, "Defaults are shown until you add content again.", false);
    syncBpReadOnly(getAdminContext());
    applyModuleRegistryAfterLoad(getAdminContext());
  }

  function wireBusinessProfileUi() {
    const ids = [
      "bp-business-name",
      "bp-short-description",
      "bp-services",
      "bp-service-areas",
      "bp-address",
      "bp-phone",
      "bp-email",
      "bp-website",
      "bp-booking-url",
      "bp-hours",
      "bp-after-hours",
      "bp-escalation",
      "bp-policies",
    ];
    ids.forEach((id) => {
      const el = $(id);
      if (!el) return;
      const handler = () => {
        syncBpPreview();
        updateBpDirtyState();
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    });
    if ($("btn-bp-save")) $("btn-bp-save").addEventListener("click", () => saveBusinessProfile());
    if ($("btn-bp-reset")) $("btn-bp-reset").addEventListener("click", () => resetBusinessProfileFields());
  }

  function wireBotBehaviorUi() {
    const inputs = [
      "bb-greeting",
      "bb-tone",
      "bb-business-role",
      "bb-primary-goal",
      "bb-fallback",
      "bb-escalation",
      "bb-lead-capture",
      "bb-avoid",
      "bb-special",
    ];
    inputs.forEach((id) => {
      const el = $(id);
      if (!el) return;
      const handler = () => {
        syncBehaviorPreview();
        updateBehaviorDirtyState();
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    });
    if ($("btn-bb-save")) $("btn-bb-save").addEventListener("click", () => saveBotBehavior());
    if ($("btn-bb-reset")) $("btn-bb-reset").addEventListener("click", () => resetBotBehaviorToDefaults());
  }

  function renderSessionStrip(meR) {
    if (!sessionStrip) return;
    if (meR && meR.ok && meR.body && meR.body.signedIn) {
      const b = meR.body;
      const role = b.role ? escapeHtml(b.role) : "—";
      const email = (b.email || (b.user && b.user.email) || "").trim();
      const emailHtml = email ? escapeHtml(email) : "Signed in";
      const opLink =
        getPortalMode() === "client" && b.canUseOperatorPortal
          ? " · <a href=\"/admin/operator\">Open operator console</a>"
          : "";
      sessionStrip.hidden = false;
      sessionStrip.innerHTML =
        "<strong>Signed in</strong> · " +
        emailHtml +
        (b.role ? " · access <strong>" + role + "</strong>" : "") +
        opLink;
    } else {
      sessionStrip.hidden = true;
      sessionStrip.textContent = "";
    }
  }

  function renderOverviewService(readyR) {
    if (!overviewService) return;
    if (!readyR || !readyR.body) {
      overviewService.hidden = true;
      return;
    }
    const b = readyR.body;
    const ctx = getAdminContext();
    if (readyR.status === 503) {
      overviewService.hidden = false;
      if (ctx.portalMode === "client") {
        overviewService.innerHTML =
          "<strong>Service status</strong>: we could not reach all systems (" +
          escapeHtml(b.reason || "unknown") +
          "). Try again later or contact support.";
      } else {
        overviewService.innerHTML =
          "<strong>Core services</strong>: not ready (" + escapeHtml(b.reason || "unknown") + ").";
      }
      return;
    }
    if (b.status === "ready") {
      const parts = [];
      if (b.checks) {
        if (b.checks.database) parts.push("database " + b.checks.database);
        if (b.checks.redis && b.checks.redis !== "skipped_non_production") parts.push("cache " + b.checks.redis);
      }
      overviewService.hidden = false;
      const label = ctx.portalMode === "client" ? "Service status" : "Core services";
      overviewService.innerHTML =
        "<strong>" + label + "</strong>: " +
        (parts.length ? escapeHtml(parts.join(", ")) : "reachable") +
        ".";
      const hints = Array.isArray(b.hints) ? b.hints : [];
      if (hints.length && ctx.technicalHintsAllowed) {
        overviewService.innerHTML +=
          "<ul style='margin:0.5rem 0 0;padding-left:1.2rem'>" +
          hints.map((h) => "<li>" + escapeHtml(h.message || h.code || "") + "</li>").join("") +
          "</ul>";
      } else if (hints.length && !ctx.technicalHintsAllowed) {
        overviewService.innerHTML +=
          " <span class='muted'>One or more optional warnings apply — ask your administrator if chat seems unavailable.</span>";
      }
      return;
    }
    overviewService.hidden = true;
  }

  function renderOverviewCards(statsR, configR, verifyR) {
    if (!overviewStatusRow || !statsGrid) return;

    const signedIn = statsR && statsR.status !== 401;
    let statusClass = "muted-card";
    let statusTitle = "Bot status";
    let statusText = "Sign in to evaluate this site.";

    if (!signedIn) {
      statusText = isAdvanced()
        ? "Open your platform portal, launch Solomon (SSO), or use a developer access token under Advanced."
        : "You’re not signed in yet. Open Solomon from your company portal, or ask your administrator for access. (Advanced: developer access token.)";
    } else if (verifyR && verifyR.ok && verifyR.body) {
      const ready = verifyR.body.readyForChat === true;
      statusClass = ready ? "ok" : "warn";
      statusTitle = "Bot readiness";
      statusText = ready
        ? "Ready for chat with the current AI configuration."
        : "Needs attention — review Pilot readiness below or ask your operator to fix AI keys.";
    } else if (verifyR && verifyR.status === 403) {
      statusClass = "muted-card";
      statusTitle = "Bot readiness";
      statusText = "Detailed readiness is operator-only. Use “Run readiness check” in the operator section if you have access.";
    } else if (verifyR && !verifyR.ok) {
      statusClass = "warn";
      statusTitle = "Bot readiness";
      statusText = "Could not load readiness (" + (verifyR.body?.error || verifyR.status) + ").";
    } else if (configR && configR.ok && configR.body) {
      statusClass = configR.body.hasOpenAIKey ? "ok" : "warn";
      statusTitle = "AI connection";
      statusText = configR.body.hasOpenAIKey
        ? "This site has a dedicated AI key on file."
        : "This site relies on the host’s shared AI connection (normal for managed setups).";
    }

    const slug = escapeHtml(tenantSlug());
    const portal = getPortalMode();
    const tenantLine =
      configR && configR.ok && configR.body
        ? portal === "client"
          ? escapeHtml((configR.body.name || "") + "")
          : escapeHtml((configR.body.name || "") + "") +
            " · Site ID <span class='mono'>" +
            slug +
            "</span>" +
            (configR.body.subdomain ? " · subdomain <span class='mono'>" + escapeHtml(configR.body.subdomain) + "</span>" : "")
        : portal === "client"
          ? "Your assistant"
          : "Site ID <span class='mono'>" + slug + "</span>";

    overviewStatusRow.innerHTML =
      '<div class="status-chip-card ' +
      statusClass +
      '"><strong>' +
      statusTitle +
      '</strong><div class="big">' +
      statusText +
      "</div></div>" +
      '<div class="status-chip-card muted-card"><strong>' +
      (portal === "client" ? "Your business" : isAdvanced() ? "Active tenant" : "Current site") +
      '</strong><div class="big">' +
      tenantLine +
      "</div></div>";

    if (!signedIn) {
      statsGrid.innerHTML =
        "<div class='stat' style='grid-column: 1 / -1'><div class='lbl'>Activity</div><div class='val' style='font-size:1rem'>—</div><div class='lbl'>Sign in to load stats</div></div>";
      if (configLine) configLine.textContent = "";
      showAuth(statusText, true);
      return;
    }

    hideAuth();

    if (!statsR || !statsR.ok) {
      statsGrid.innerHTML =
        "<div class='stat' style='grid-column:1/-1'><div class='lbl'>Stats</div><div class='val'>—</div><div class='lbl'>" +
        escapeHtml(statsR?.body?.error || "Could not load activity") +
        "</div></div>";
    } else {
      const s = statsR.body;
      const advanced = isAdvanced();
      const rows = advanced
        ? [
            ["Conversations", s.conversations],
            ["Leads", s.leads],
            ["Messages", s.messages],
            ["API calls (30d)", s.usage30d?.requests ?? "—"],
            ["Tokens in (30d)", s.usage30d?.promptTokens ?? "—"],
            ["Cost (30d)", s.usage30d?.cost != null ? "$" + Number(s.usage30d.cost).toFixed(4) : "—"],
          ]
        : [
            ["Chat threads", s.conversations],
            ["Leads captured", s.leads],
            ["Messages", s.messages],
            ["AI requests (30 days)", s.usage30d?.requests ?? "—"],
            ["AI tokens in (30 days)", s.usage30d?.promptTokens ?? "—"],
            ["Est. AI cost (30 days)", s.usage30d?.cost != null ? "$" + Number(s.usage30d.cost).toFixed(4) : "—"],
          ];
      statsGrid.innerHTML = rows
        .map(
          ([lbl, val]) =>
            `<div class="stat"><div class="val">${val}</div><div class="lbl">${escapeHtml(lbl)}</div></div>`
        )
        .join("");
    }

    if (configLine) {
      const c = configR && configR.ok ? configR.body : null;
      configLine.textContent = c
        ? `${c.name || ""} · subdomain ${c.subdomain || "—"} · dedicated AI key ${c.hasOpenAIKey ? "yes" : "no"} · email (SMTP) ${c.hasSmtpConfig ? "yes" : "no"}`
        : "";
    }

    if (statsR && statsR.ok && (!configR || !configR.ok) && configR?.status !== 401) {
      showGlobalToast("Activity loaded, but profile details were incomplete. Pilot readiness may be limited.", "warn", 6000);
    }
  }

  function scrollToModule(targetId) {
    if (!targetId) return;
    const el = document.getElementById(targetId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      el.focus({ preventScroll: true });
    } catch (_) {}
  }

  const PR_GROUP_LABELS = {
    core: "Core setup",
    bot_quality: "Bot quality",
    website: "Website launch",
    operations: "Operations",
    security: "Security & operator",
  };

  function pilotPillClass(status) {
    if (status === "ok") return "pr-pill pr-pill--ok";
    if (status === "fail") return "pr-pill pr-pill--fail";
    if (status === "warn") return "pr-pill pr-pill--warn";
    return "pr-pill pr-pill--na";
  }

  function pilotPillLabel(status) {
    if (status === "ok") return "OK";
    if (status === "fail") return "Needs work";
    if (status === "warn") return "Suggested";
    return "N/A";
  }

  function renderLaunchStatusClient(body, ctx) {
    const launch = body && body.launch;
    const root = $("dashboard-pilot-readiness-root");
    const sum = $("pr-summary");
    const scoreEl = $("pr-score-fill");
    const scorePct = $("pr-score-pct");
    const titleEl = $("pr-summary-title");
    const tenantEl = $("pr-summary-tenant");
    const groupsEl = $("pr-groups");
    if (!root || !sum || !groupsEl || !titleEl) return;

    if (!ctx.authenticated) {
      setModuleNeedsSetup("#dashboard-pilot-readiness-root");
      titleEl.textContent = "Sign in required";
      if (tenantEl) tenantEl.textContent = "";
      if (scorePct) scorePct.textContent = "—";
      if (scoreEl) scoreEl.style.width = "0%";
      groupsEl.innerHTML = "<p class=\"muted\">Sign in to view launch status.</p>";
      return;
    }

    if (!launch) {
      setModuleUnavailable("#dashboard-pilot-readiness-root");
      titleEl.textContent = "Could not load";
      if (tenantEl) tenantEl.textContent = "";
      groupsEl.innerHTML = "<p class=\"error-text\">No launch status returned.</p>";
      return;
    }

    setModuleReady("#dashboard-pilot-readiness-root");
    const st = launch.status === "ready" ? "ready" : launch.status === "operator_required" ? "operator_required" : "needs_attention";
    sum.setAttribute("data-pr-status", st);
    titleEl.textContent = launch.headline || "Launch status";
    if (tenantEl) tenantEl.textContent = launch.summary || "";
    const sc = typeof launch.score === "number" ? launch.score : 0;
    if (scorePct) scorePct.textContent = String(sc) + "%";
    if (scoreEl) scoreEl.style.width = Math.max(0, Math.min(100, sc)) + "%";

    const items = Array.isArray(launch.items) ? launch.items : [];
    if (!items.length) {
      groupsEl.innerHTML = "<p class=\"muted\">No checklist rows to show.</p>";
    } else {
      groupsEl.innerHTML =
        "<div class=\"pr-group-rows\">" +
        items
          .map((it) => {
            const s = String(it.status || "").toLowerCase();
            const pill =
              s === "ok" || s === "pass"
                ? pilotPillClass("ok")
                : s === "fail" || s === "error"
                  ? pilotPillClass("fail")
                  : pilotPillClass("warn");
            const pl =
              s === "ok" || s === "pass" ? "OK" : s === "fail" || s === "error" ? "Needs attention" : "Note";
            return (
              "<div class=\"pr-row\"><div class=\"pr-row-main\"><span class=\"" +
              pill +
              "\">" +
              escapeHtml(pl) +
              "</span><div class=\"pr-row-text\"><div class=\"pr-row-title\">" +
              escapeHtml(it.label || "") +
              "</div><p class=\"pr-row-msg muted small\">" +
              escapeHtml(it.message || "") +
              "</p></div></div></div>"
            );
          })
          .join("") +
        "</div>";
    }

    const foot = $("pr-footnote");
    if (foot) {
      foot.textContent =
        "This summary helps you go live — it does not replace a full security or compliance review.";
    }
  }

  function renderPilotReadinessUi(body, ctx) {
    const root = $("dashboard-pilot-readiness-root");
    const sum = $("pr-summary");
    const scoreEl = $("pr-score-fill");
    const scorePct = $("pr-score-pct");
    const titleEl = $("pr-summary-title");
    const tenantEl = $("pr-summary-tenant");
    const lastEl = $("pr-last-checked");
    const groupsEl = $("pr-groups");
    const banner = $("pr-banner");
    if (!root || !sum || !groupsEl) return;

    const adv = Boolean(ctx.technicalHintsAllowed);
    if (banner) {
      banner.hidden = true;
      banner.textContent = "";
      banner.className = "section-banner small";
    }

    if (!ctx.authenticated) {
      setModuleNeedsSetup("#dashboard-pilot-readiness-root");
      titleEl.textContent = "Sign in required";
      tenantEl.textContent = "";
      if (scorePct) scorePct.textContent = "—";
      if (scoreEl) scoreEl.style.width = "0%";
      groupsEl.innerHTML =
        "<p class=\"muted\">Sign in to load pilot readiness for the active site.</p>";
      if (lastEl) lastEl.textContent = "";
      return;
    }

    if (!body || !body.readiness) {
      setModuleUnavailable("#dashboard-pilot-readiness-root");
      titleEl.textContent = "Could not load";
      groupsEl.innerHTML = "<p class=\"error-text\">No readiness data returned.</p>";
      return;
    }

    const r = body.readiness;
    const tenant = body.tenant || {};
    const st = r.status || "needs_attention";
    const score = typeof r.score === "number" ? r.score : 0;

    setModuleReady("#dashboard-pilot-readiness-root");
    sum.setAttribute("data-pr-status", st);
    if (st === "ready") {
      titleEl.textContent = adv ? "Ready for pilot" : "Ready for your pilot";
    } else if (st === "operator_required") {
      titleEl.textContent = adv ? "Operator action required" : "Your team needs an operator";
    } else {
      titleEl.textContent = adv ? "Needs attention" : "Almost there — a few fixes left";
    }
    tenantEl.textContent =
      (tenant.displayName || tenant.slug || "") + (tenant.plan ? " · plan " + tenant.plan : "");

    if (scorePct) scorePct.textContent = String(score) + "%";
    if (scoreEl) scoreEl.style.width = Math.max(0, Math.min(100, score)) + "%";

    const byGroup = {};
    (r.items || []).forEach((it) => {
      const g = it.group || "core";
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(it);
    });

    const order = ["core", "bot_quality", "website", "operations", "security"];
    groupsEl.innerHTML = order
      .map((gid) => {
        const list = byGroup[gid];
        if (!list || !list.length) return "";
        const label = PR_GROUP_LABELS[gid] || gid;
        const rows = list
          .map((it) => {
            const hint =
              adv && it.technicalHint
                ? "<p class=\"pr-tech-hint muted small mono\">" + escapeHtml(it.technicalHint) + "</p>"
                : "";
            const opTag = it.operatorOnly
              ? "<span class=\"pr-op-tag muted small\">Operator</span>"
              : "";
            const cta =
              it.actionLabel && it.actionTarget
                ? "<button type=\"button\" class=\"secondary pr-row-cta\" data-pr-scroll=\"" +
                  escapeHtml(it.actionTarget) +
                  "\">" +
                  escapeHtml(it.actionLabel) +
                  "</button>"
                : "";
            return (
              "<div class=\"pr-row\" data-pr-item=\"" +
              escapeHtml(it.id) +
              "\">" +
              "<div class=\"pr-row-main\">" +
              "<span class=\"" +
              pilotPillClass(it.status) +
              "\">" +
              escapeHtml(pilotPillLabel(it.status)) +
              "</span>" +
              "<div class=\"pr-row-text\">" +
              "<div class=\"pr-row-title\">" +
              escapeHtml(it.label) +
              opTag +
              "</div>" +
              "<p class=\"pr-row-msg muted small\">" +
              escapeHtml(it.message || "") +
              "</p>" +
              hint +
              "</div></div>" +
              (cta ? "<div class=\"pr-row-actions\">" + cta + "</div>" : "") +
              "</div>"
            );
          })
          .join("");
        return (
          "<section class=\"pr-group\" aria-labelledby=\"pr-h-" +
          escapeHtml(gid) +
          "\">" +
          "<h3 class=\"pr-group-title\" id=\"pr-h-" +
          escapeHtml(gid) +
          "\">" +
          escapeHtml(label) +
          "</h3>" +
          "<div class=\"pr-group-rows\">" +
          rows +
          "</div></section>"
        );
      })
      .join("");

    groupsEl.querySelectorAll("[data-pr-scroll]").forEach((btn) => {
      btn.addEventListener("click", () => scrollToModule(btn.getAttribute("data-pr-scroll")));
    });

    const foot = $("pr-footnote");
    if (foot) {
      foot.textContent = adv
        ? "GET /api/admin/pilot-readiness — heuristic only; does not call OpenAI or hit webhook receivers. Not a substitute for production monitoring."
        : "This summary is a best-effort guide before a pilot — it does not replace security review or monitoring.";
    }
  }

  async function loadPilotReadinessModule(ctx) {
    const lastEl = $("pr-last-checked");
    if (lastEl && ctx.authenticated) lastEl.textContent = "Checking…";

    if (!ctx.authenticated) {
      renderPilotReadinessUi(null, ctx);
      if (lastEl) lastEl.textContent = "";
      return;
    }

    const r = await api("/api/admin/pilot-readiness");
    if (getPortalMode() === "client" && r.ok && r.body && r.body.launch) {
      if (lastEl) lastEl.textContent = "Last checked: " + new Date().toLocaleString();
      renderLaunchStatusClient(r.body, ctx);
      return;
    }
    if (!r.ok) {
      if (lastEl) lastEl.textContent = "";
      const ban = $("pr-banner");
      if (ban) {
        ban.hidden = false;
        ban.textContent = r.body?.error || "Could not load pilot readiness (" + r.status + ").";
        ban.className = "section-banner small error-text";
      }
      const groupsEl = $("pr-groups");
      if (groupsEl) {
        groupsEl.innerHTML =
          "<p class=\"error-text\">" +
          escapeHtml(r.body?.error || "Request failed (" + r.status + ").") +
          "</p>";
      }
      const titleEl = $("pr-summary-title");
      if (titleEl) titleEl.textContent = "Could not load readiness";
      setModuleUnavailable("#dashboard-pilot-readiness-root");
      return;
    }
    if (lastEl) lastEl.textContent = "Last checked: " + new Date().toLocaleString();
    renderPilotReadinessUi(r.body, ctx);
  }

  async function loadDashboardData() {
    const readyR = await fetchReady();
    const meR = await fetchMe();
    const statsR = await api("/api/stats");
    const configR = await api("/api/config");
    let verifyR = { ok: false, status: 401, body: null };
    if (statsR.status !== 401) {
      verifyR = await api("/api/admin/tenants/" + encodeURIComponent(tenantSlug()) + "/verify");
    }

    state.ready = readyR;
    state.me = meR;
    state.stats = statsR;
    state.config = configR;
    state.verify = verifyR;
    state.lastStatsR = statsR;
    state.lastConfigR = configR;
    state.lastVerifyR = verifyR;

    renderSessionStrip(meR);
    renderOverviewService(readyR);
    renderOverviewCards(statsR, configR, verifyR);
    return { readyR, meR, statsR, configR, verifyR };
  }

  let eventTypes = [];

  async function loadWebhookMeta() {
    const { ok, body } = await api("/api/integrations/webhooks/meta");
    if (!ok || !body?.eventTypes) return;
    eventTypes = body.eventTypes;
    whEvents.innerHTML = eventTypes
      .map(
        (ev) =>
          `<label><input type="checkbox" name="ev" value="${ev.replace(/"/g, "&quot;")}" /> ${escapeHtml(ev)}</label>`
      )
      .join("");
  }

  async function loadWebhooks() {
    hideSection(whSectionStatus);
    const { ok, status, body } = await api("/api/integrations/webhooks");
    if (status === 401) {
      state.webhooks = [];
      state.webhooksStatus = "auth";
      if (whTbody) whTbody.innerHTML = "";
      return [];
    }
    if (!ok) {
      state.webhooks = [];
      state.webhooksStatus = body?.error || String(status);
      if (whTbody) {
        whTbody.innerHTML =
          "<tr><td colspan='4' class='muted'>Could not load webhooks (" + escapeHtml(String(body?.error || status)) + ")</td></tr>";
      }
      return [];
    }
    const rows = body.webhooks || [];
    state.webhooks = rows;
    state.webhooksStatus = null;
    if (!rows.length) {
      whTbody.innerHTML = "<tr><td colspan='4' class='muted'>No webhooks yet. Add one to notify your CRM when events occur.</td></tr>";
    } else {
      whTbody.innerHTML = rows
        .map((w) => {
          const ev =
            !w.events || !w.events.length
              ? "<em>all</em>"
              : w.events.map((e) => `<span class="mono">${escapeHtml(e)}</span>`).join(", ");
          return `<tr>
          <td class="mono">${escapeHtml(w.endpoint)}</td>
          <td>${w.enabled ? "yes" : "no"}</td>
          <td>${ev}</td>
          <td><button type="button" class="danger" data-del="${escapeHtml(w.id)}">Remove</button></td>
        </tr>`;
        })
        .join("");
      whTbody.querySelectorAll("[data-del]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove this webhook? Your systems will stop receiving these events.")) return;
          const id = btn.getAttribute("data-del");
          const r = await api("/api/integrations/webhooks/" + id, { method: "DELETE" });
          if (!r.ok && r.status !== 204) {
            showSectionText(whSectionStatus, r.body?.error || "Remove failed (" + r.status + ")", true);
          } else {
            showGlobalToast("Webhook removed.", "success");
          }
          loadWebhooks().then(() => {
            syncWebhookTestPanel(getAdminContext());
            void loadPilotReadinessModule(getAdminContext()).catch(console.error);
          });
        });
      });
    }
    return rows;
  }

  function val(id) {
    const el = $(id);
    return el ? el.value.trim() : "";
  }

  function setBrandingField(id, v) {
    const el = $(id);
    if (el) el.value = v == null || v === "" ? "" : String(v);
  }

  function hexToRgb(hex) {
    const h = String(hex || "").trim();
    const m = /^#?([0-9a-fA-F]{6})$/.exec(h);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function syncBrandingPreview() {
    const card = $("branding-preview-card");
    if (!card) return;
    const brand = val("br-brand") || "#6B705C";
    const botBg = val("br-bot-bg") || "#F4F1EA";
    const botText = val("br-bot-text") || "#2C2C2C";
    const userBg = val("br-user-bg") || "#8A7B68";
    const userText = val("br-user-text") || "#FFFFFF";
    const glass = val("br-glass-bg") || "rgba(250,248,244,0.92)";
    card.style.setProperty("--preview-brand", brand);
    card.style.setProperty("--preview-bot-bg", botBg);
    card.style.setProperty("--preview-bot-text", botText);
    card.style.setProperty("--preview-user-bg", userBg);
    card.style.setProperty("--preview-user-text", userText);
    card.style.background = glass;
    const hdr = $("bp-header");
    if (hdr) hdr.style.color = brand;
    const rgb = hexToRgb(brand);
    if (rgb) {
      card.style.borderColor = "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + ",0.35)";
    }
  }

  async function loadBranding() {
    if (!brandingStatus) return;
    brandingStatus.textContent = "";
    const { ok, status, body } = await api("/api/integrations/branding");
    if (status === 401) {
      lastBrandingBody = null;
      return false;
    }
    if (!ok) {
      brandingStatus.textContent = "Could not load look & feel: " + (body?.error || status);
      lastBrandingBody = null;
      return false;
    }
    lastBrandingBody = body;
    const ap = body.appearance || {};
    const th = $("br-theme");
    if (th) th.value = ap.theme === "light" || ap.theme === "dark" ? ap.theme : "auto";
    setBrandingField("br-brand", body.brandColor);
    setBrandingField("br-brand-hover", body.brandHover);
    setBrandingField("br-bot-bg", body.botBg);
    setBrandingField("br-bot-text", body.botText);
    setBrandingField("br-user-bg", body.userBg);
    setBrandingField("br-user-text", body.userText);
    setBrandingField("br-glass-bg", body.glassBg);
    setBrandingField("br-glass-top", body.glassTop);
    setBrandingField("br-blur", body.blurPx);
    setBrandingField("br-font", body.fontFamily);
    setBrandingField("br-watermark", body.watermarkUrl);
    setBrandingField("br-header-glow", body.headerGlow);
    syncBrandingPreview();
    return true;
  }

  async function saveBranding() {
    if (!brandingStatus) return;
    const themeEl = $("br-theme");
    const payload = {
      appearance: { theme: (themeEl && themeEl.value) || "auto" },
    };
    const pairs = [
      ["br-brand", "brandColor"],
      ["br-brand-hover", "brandHover"],
      ["br-bot-bg", "botBg"],
      ["br-bot-text", "botText"],
      ["br-user-bg", "userBg"],
      ["br-user-text", "userText"],
      ["br-glass-bg", "glassBg"],
      ["br-glass-top", "glassTop"],
      ["br-blur", "blurPx"],
      ["br-font", "fontFamily"],
      ["br-watermark", "watermarkUrl"],
      ["br-header-glow", "headerGlow"],
    ];
    for (const [id, key] of pairs) {
      const s = val(id);
      if (s) payload[key] = s;
    }
    const r = await api("/api/integrations/branding", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      brandingStatus.textContent = "Save failed: " + (r.body?.error || r.status);
      brandingStatus.className = "muted mt-1 error-text";
      return;
    }
    brandingStatus.className = "muted mt-1";
    brandingStatus.textContent =
      "Saved. Visitors may see theme updates within about a minute due to browser or CDN caching.";
    showGlobalToast("Look & feel saved.", "success");
    await loadBranding();
    applyModuleRegistryAfterLoad(getAdminContext());
  }

  function selectedEvents() {
    const boxes = whEvents.querySelectorAll('input[name="ev"]:checked');
    return Array.from(boxes).map((b) => b.value);
  }

  async function addWebhook() {
    hideSection(whSectionStatus);
    const endpoint = $("wh-endpoint").value.trim();
    const secret = $("wh-secret").value.trim();
    const events = selectedEvents();
    const payload = { endpoint, enabled: true, events };
    if (secret) payload.secret = secret;
    const r = await api("/api/integrations/webhooks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      showSectionText(whSectionStatus, r.body?.error || "Could not add webhook (" + r.status + ")", true);
      return;
    }
    $("wh-endpoint").value = "";
    $("wh-secret").value = "";
    whEvents.querySelectorAll('input[name="ev"]').forEach((x) => (x.checked = false));
    showGlobalToast("Webhook added.", "success");
    const rows = await loadWebhooks();
    syncWebhookTestPanel(getAdminContext());
    loadPilotReadinessModule(getAdminContext());
  }

  async function rotateKey() {
    if (getPortalMode() === "client") return;
    hideSection(keyRotateStatus);
    if (
      !confirm(
        "Rotate the integration API key for this site?\n\nAny connected CRM, scripts, or middleware must be updated immediately — the old key stops working."
      )
    ) {
      return;
    }
    const r = await api("/api/keys/rotate", { method: "POST", body: "{}" });
    const box = $("key-reveal");
    if (!r.ok) {
      if (box) {
        box.hidden = false;
        box.textContent = "Error: " + (r.body?.error || r.status);
      }
      showSectionText(keyRotateStatus, "Rotation failed.", true);
      return;
    }
    if (box) {
      box.hidden = false;
      box.textContent = r.body.apiKey || "";
    }
    showSectionText(
      keyRotateStatus,
      "New key shown above — copy it to your secrets store now. It will not be shown again.",
      false
    );
    showGlobalToast("Integration API key rotated. Update external systems.", "warn", 7000);
    const rows = await loadWebhooks();
    loadPilotReadinessModule(getAdminContext());
  }

  function syncOnbOpenaiField() {
    const g = $("onb-use-global-openai");
    const k = $("onb-openai-key");
    if (!k || !g) return;
    k.disabled = g.checked;
    if (g.checked) k.value = "";
  }

  async function loadTenantDirectory() {
    if (getPortalMode() === "client") return;
    const dir = $("onb-directory");
    if (!dir) return;
    const r = await api("/api/admin/tenants");
    if (r.status === 401) {
      state.tenantsListForbidden = false;
      dir.innerHTML = "";
      return;
    }
    if (r.status === 403) {
      state.tenantsListForbidden = true;
      dir.innerHTML =
        '<li class="muted">Listing all sites requires an <strong>operator</strong>, <strong>admin</strong>, or <strong>owner</strong> role.</li>';
      return;
    }
    if (!r.ok) {
      state.tenantsListForbidden = false;
      dir.innerHTML = "<li>Could not load sites: " + escapeHtml(String(r.body?.error || r.status)) + "</li>";
      return;
    }
    state.tenantsListForbidden = false;
    renderServerHints(r.body.serverHints);
    const tenants = r.body.tenants || [];
    const advanced = isAdvanced();
    dir.innerHTML = tenants.length
      ? tenants
          .map((t) =>
            advanced
              ? `<li><strong class="mono">${escapeHtml(t.id)}</strong> — ${escapeHtml(t.name)} · plan ${escapeHtml(t.plan)} · dedicated AI ${t.hasOpenaiKey ? "yes" : "no"} · integration key ${t.hasIntegrationKey ? "yes" : "no"}</li>`
              : `<li><strong>${escapeHtml(t.name)}</strong><span class="muted"> · Site ID ${escapeHtml(t.id)}</span></li>`
          )
          .join("")
      : `<li>${advanced ? "No tenants yet." : "No site profiles yet."}</li>`;
  }

  function renderServerHints(sh) {
    const el = $("onb-server-hints");
    if (!el) return;
    if (!sh) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const lines = [];
    const adv = isAdvanced();
    if (!sh.globalOpenaiConfigured && !sh.openaiBootOptional) {
      lines.push(
        adv
          ? "No OPENAI_API_KEY on the server (and OPENAI_BOOT_OPTIONAL is off). Each tenant needs a per-tenant key or chat will fail."
          : "The host has not configured a shared AI key on the server. Each site may need its own dedicated key — ask your operator."
      );
    } else if (sh.globalOpenaiConfigured) {
      lines.push(
        adv
          ? "OPENAI_API_KEY is set — tenants can rely on the global key when they do not have a per-tenant key."
          : "A shared AI key is configured on the host — sites can normally use it without storing their own."
      );
    }
    if (sh.openaiBootOptional) {
      lines.push(
        adv
          ? "OPENAI_BOOT_OPTIONAL=1 — the process starts without a global OpenAI key; every chat tenant must have openaiKey stored in the database."
          : "The server is configured to start without a shared AI key — every site must have its own key stored."
      );
    }
    if (sh.nodeEnv && sh.nodeEnv !== "production") {
      lines.push(
        adv
          ? 'NODE_ENV is not "production" — /api/ready skips Redis and bootstrap-tenant checks. Use NODE_ENV=production for managed installs.'
          : "This deployment is not in production mode — some automatic health checks are relaxed."
      );
    }
    if (!lines.length) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = "banner onb-hints warn";
    el.innerHTML =
      "<strong>" +
      (adv ? "Environment" : "Host configuration") +
      "</strong><ul>" +
      lines.map((l) => "<li>" + escapeHtml(l) + "</li>").join("") +
      "</ul>";
  }

  function onbSlug() {
    return val("onb-slug");
  }

  async function createOnboardingTenant() {
    if (getPortalMode() === "client") return;
    const status = $("onb-status");
    const keyBox = $("onb-key-reveal");
    if (!status || !keyBox) return;
    status.textContent = "";
    status.className = "muted mt-1";
    keyBox.hidden = true;
    keyBox.textContent = "";

    const slug = onbSlug();
    const name = val("onb-name");
    if (!slug || !name) {
      status.textContent = "Site ID and business display name are required.";
      return;
    }

    const useGlobal = $("onb-use-global-openai")?.checked !== false;
    const payload = {
      slug,
      name,
      plan: ($("onb-plan") && $("onb-plan").value) || "basic",
      useGlobalOpenai: useGlobal,
      openaiKey: useGlobal ? "" : val("onb-openai-key"),
      skipIntegrationKey: $("onb-skip-int-key")?.checked === true,
      bootstrapPrompts: $("onb-bootstrap-prompts")?.checked !== false,
      force: $("onb-force")?.checked === true,
    };

    const r = await api("/api/admin/tenants", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (r.status === 403) {
      status.textContent = "Your role cannot create site profiles. Ask an operator or administrator.";
      return;
    }
    if (!r.ok) {
      status.textContent =
        "Could not save: " + (r.body?.error || r.status) + (r.body?.code ? " (" + r.body.code + ")" : "");
      return;
    }

    let msg = r.body.updated
      ? "Site profile updated. Copy any new keys below if shown."
      : "Site profile created. Copy the integration API key below now — it will not be shown again.";
    if (r.body.integrationKey) {
      keyBox.hidden = false;
      keyBox.textContent = r.body.integrationKey;
    }
    if (r.body.bootstrap && r.body.bootstrap.files) {
      const parts = r.body.bootstrap.files.map((f) => f.file + ": " + f.status);
      msg += " Prompt files: " + parts.join(", ") + ".";
    }
    if (r.body.hints && r.body.hints.length) {
      msg +=
        "\n\n" +
        r.body.hints.map((h) => "[" + h.severity + "] " + h.message).join("\n");
    }
    status.textContent = msg;
    showGlobalToast("Site profile saved.", "success");
    loadTenantDirectory();
    tenantInput.value = slug;
    localStorage.setItem(TENANT_KEY, slug);
    await loadAll();
  }

  async function verifyOnboardingTenant() {
    if (getPortalMode() === "client") return;
    const status = $("onb-status");
    const keyBox = $("onb-key-reveal");
    if (!status) return;
    const slug = onbSlug() || tenantSlug();
    if (!slug) {
      status.textContent = "Enter a Site ID first.";
      return;
    }
    status.className = "muted mt-1";
    if (keyBox) keyBox.hidden = true;
    const r = await api("/api/admin/tenants/" + encodeURIComponent(slug) + "/verify");
    if (r.status === 403) {
      status.textContent = "You don’t have permission to run the detailed readiness check.";
      return;
    }
    if (!r.ok) {
      status.textContent = "Readiness check failed: " + (r.body?.error || r.status);
      status.className = "muted mt-1 verify-out blocked";
      return;
    }
    const t = r.body.tenant;
    const lines = [
      (r.body.readyForChat === false ? "Not ready — " : "Ready — ") +
        `${t.name} · AI: ${t.openai} · Integration key: ${t.integrationKey} · Prompts: ${t.prompts}`,
    ];
    if (r.body.badges) {
      const b = r.body.badges;
      lines.push(`Signals — chat: ${b.chat} · integrations: ${b.integrations} · prompts: ${b.prompts}`);
    }
    if (r.body.warnings && r.body.warnings.length) {
      lines.push(r.body.warnings.map((w) => `[${w.severity}] ${w.message}`).join("\n"));
    }
    status.textContent = lines.join("\n\n");
    status.className = "muted mt-1 verify-out" + (r.body.readyForChat === false ? " blocked" : "");
    await loadAll();
  }

  async function bootstrapOnboardingPrompts() {
    if (getPortalMode() === "client") return;
    const status = $("onb-status");
    if (!status) return;
    const slug = onbSlug();
    if (!slug) {
      status.textContent = "Enter a Site ID first.";
      return;
    }
    const r = await api("/api/admin/tenants/" + encodeURIComponent(slug) + "/bootstrap-prompts", {
      method: "POST",
      body: "{}",
    });
    if (!r.ok) {
      status.textContent = "Could not copy prompt files: " + (r.body?.error || r.status);
      return;
    }
    const parts = (r.body.files || []).map((f) => f.file + ": " + f.status);
    status.textContent = "Prompt files: " + parts.join(", ");
    showGlobalToast("Prompt file copy finished.", "success");
  }

  async function rotateOnboardingIntegrationKey() {
    if (getPortalMode() === "client") return;
    const status = $("onb-status");
    const keyBox = $("onb-key-reveal");
    if (!status || !keyBox) return;
    const slug = onbSlug();
    if (!slug) {
      status.textContent = "Enter a Site ID first.";
      return;
    }
    if (
      !confirm(
        'Rotate the integration API key for "' +
          slug +
          '"?\n\nThe previous key stops working immediately. Update every system that calls Solomon before you continue.'
      )
    )
      return;
    const r = await api("/api/admin/tenants/" + encodeURIComponent(slug) + "/rotate-integration-key", {
      method: "POST",
      body: "{}",
    });
    if (!r.ok) {
      status.textContent = "Rotate failed: " + (r.body?.error || r.status);
      return;
    }
    status.textContent =
      (r.body.message || "New integration key — copy now (shown only once):") +
      "\n\nCopy the key below before leaving this page.";
    keyBox.hidden = false;
    keyBox.textContent = r.body.apiKey || "";
    showGlobalToast("Integration API key rotated for " + slug + ".", "warn", 7000);
    loadTenantDirectory();
    await loadAll();
  }

  function wireBrandingPreviewInputs() {
    const ids = [
      "br-brand",
      "br-bot-bg",
      "br-bot-text",
      "br-user-bg",
      "br-user-text",
      "br-glass-bg",
      "br-theme",
    ];
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("input", syncBrandingPreview);
      if (el) el.addEventListener("change", syncBrandingPreview);
    });
  }

  async function loadAll() {
    hideSection(globalToast);
    const brandingOk = await loadBranding().catch(() => false);
    let whRows = [];
    try {
      await loadWebhookMeta();
      whRows = await loadWebhooks();
    } catch {
      whRows = [];
    }
    const dash = { statsR: null, configR: null, verifyR: null };
    try {
      const d = await loadDashboardData();
      dash.statsR = d.statsR;
      dash.configR = d.configR;
      dash.verifyR = d.verifyR;
    } catch {
      showAuth("Could not refresh the dashboard. Try again in a moment.", true);
    }
    try {
      await loadTenantDirectory();
    } catch (_) {}
    updateInstallPreviewUrls();
    const ctx = getAdminContext();
    try {
      await loadConversationsModule(ctx);
    } catch (e) {
      console.warn("loadConversationsModule", e);
    }
    try {
      await loadLeadsModule(ctx);
    } catch (e) {
      console.warn("loadLeadsModule", e);
    }
    try {
      await loadKnowledgeBaseModule(ctx);
    } catch (e) {
      console.warn("loadKnowledgeBaseModule", e);
    }
    try {
      await loadBotBehaviorModule(ctx);
    } catch (e) {
      console.warn("loadBotBehaviorModule", e);
    }
    try {
      await loadBusinessProfileModule(ctx);
    } catch (e) {
      console.warn("loadBusinessProfileModule", e);
    }
    try {
      await loadWebhookTestModule(ctx);
    } catch (e) {
      console.warn("loadWebhookTestModule", e);
    }
    applyModuleRegistryAfterLoad(ctx);
    setAdminVersionMarker();
  }

  async function init() {
    applyPortalMode();
    if (getPortalMode() === "operator") {
      applyAdminMode(readInitialAdvanced());
    }

    const browserTenantQ = new URLSearchParams(location.search).get("tenant");
    const stored = localStorage.getItem(TENANT_KEY);
    const meR = await fetchMe();
    state.me = meR;
    state.allowedTenants =
      meR.ok && meR.body && Array.isArray(meR.body.allowedTenants) ? meR.body.allowedTenants : [];

    if (getPortalMode() === "client") {
      const allowed = state.allowedTenants;
      const slugs = new Set(allowed.map((t) => t.slug));
      if (stored && !slugs.has(stored)) {
        try {
          localStorage.removeItem(TENANT_KEY);
        } catch (_) {}
      }
      if (browserTenantQ && !slugs.has(browserTenantQ)) {
        showGlobalToast("That business is not available for this account.", "error", 6500);
        const nu = new URLSearchParams(location.search);
        nu.delete("tenant");
        history.replaceState(null, "", location.pathname + (nu.toString() ? "?" + nu.toString() : ""));
      }

      let pick =
        (browserTenantQ && slugs.has(browserTenantQ) ? browserTenantQ : null) ||
        (stored && slugs.has(stored) ? stored : null) ||
        (meR.body &&
        meR.body.currentTenant &&
        meR.body.currentTenant.slug &&
        slugs.has(meR.body.currentTenant.slug)
          ? meR.body.currentTenant.slug
          : null);

      const bizRow = $("client-business-row");
      const bizSel = $("client-business-select");
      if (allowed.length > 1) {
        if (bizRow) bizRow.hidden = false;
        if (tenantInput) tenantInput.value = pick || "";
        if (bizSel && !bizSel.dataset.wired) {
          bizSel.dataset.wired = "1";
          bizSel.innerHTML =
            '<option value="">' +
            escapeHtml("Select a business…") +
            "</option>" +
            allowed
              .map(
                (t) =>
                  "<option value=\"" +
                  escapeHtml(t.slug) +
                  "\">" +
                  escapeHtml(t.displayName || t.slug) +
                  "</option>"
              )
              .join("");
          if (pick) bizSel.value = pick;
          bizSel.addEventListener("change", () => {
            const v = bizSel.value.trim();
            if (!v) return;
            if (tenantInput) tenantInput.value = v;
            try {
              localStorage.setItem(TENANT_KEY, v);
            } catch (_) {}
            const nu = new URLSearchParams(location.search);
            nu.set("tenant", v);
            history.replaceState(null, "", location.pathname + "?" + nu.toString());
            loadAll();
          });
        }
        if (!pick && tenantInput) tenantInput.value = "";
      } else if (allowed.length === 1) {
        if (bizRow) bizRow.hidden = true;
        pick = allowed[0].slug;
        if (tenantInput) tenantInput.value = pick;
        try {
          localStorage.setItem(TENANT_KEY, pick);
        } catch (_) {}
        const nu = new URLSearchParams(location.search);
        nu.set("tenant", pick);
        history.replaceState(null, "", location.pathname + "?" + nu.toString());
      } else {
        if (tenantInput) tenantInput.value = "";
        if (bizRow) bizRow.hidden = true;
        showAuth("No business access is assigned to this account yet. Ask your administrator to invite you.", true);
      }
    } else if (tenantInput) {
      tenantInput.value = browserTenantQ || stored || "default";
    }

    const btnMode = $("btn-toggle-mode");
    if (btnMode) {
      btnMode.addEventListener("click", () => {
        const next = !document.body.classList.contains("admin-advanced");
        localStorage.setItem(ADV_MODE_KEY, next ? "1" : "0");
        applyAdminMode(next);
        syncModeUrl(next);
        const intPanel = $("panel-integrations");
        if (intPanel) {
          if (next) intPanel.classList.remove("advanced-only");
          else intPanel.classList.add("advanced-only");
        }
        loadAll();
      });
    }

    const tok = localStorage.getItem(TOKEN_KEY);
    if (tok && $("dev-token")) $("dev-token").value = tok;

    if (tenantInput) {
      tenantInput.addEventListener("change", () => {
      if (getPortalMode() === "client" && state.allowedTenants && state.allowedTenants.length) {
        const v = tenantInput.value.trim();
        const ok = state.allowedTenants.some((t) => t.slug === v);
        if (!ok) {
          showGlobalToast("Use the business list to switch sites.", "error", 5000);
          return;
        }
      }
      localStorage.setItem(TENANT_KEY, tenantInput.value.trim() || "default");
      const os = $("onb-slug");
      if (os && !os.value.trim()) os.value = tenantSlug();
      convListState.offset = 0;
      leadsListState.offset = 0;
      knowledgeListState.offset = 0;
      knowledgeListState.q = "";
      const knQ = $("kn-q");
      if (knQ) knQ.value = "";
      const knRet = $("kn-retrieval-q");
      if (knRet) knRet.value = "";
      const knOut = $("kn-retrieval-out");
      if (knOut) {
        knOut.textContent = "";
        knOut.hidden = true;
      }
      closeKnowledgeDetailModal();
      closeKnowledgeAddModal();
      closeTranscriptModal();
      knowledgeDetailCache = null;
      leadsRowsCache = [];
      transcriptPlainText = "";
      behaviorLoaded = false;
      bpLoaded = false;
      loadAll();
    });
    }

    const br = $("btn-reload");
    if (br) br.addEventListener("click", loadAll);
    const brk = $("btn-rotate-key");
    if (brk) brk.addEventListener("click", rotateKey);
    const badd = $("btn-add-webhook");
    if (badd) badd.addEventListener("click", addWebhook);
    const btnBr = $("btn-save-branding");
    if (btnBr) btnBr.addEventListener("click", saveBranding);
    const bst = $("btn-save-token");
    if (bst) {
      bst.addEventListener("click", () => {
        const dt = $("dev-token");
        const v = dt ? dt.value.trim() : "";
        if (v) localStorage.setItem(TOKEN_KEY, v);
        else localStorage.removeItem(TOKEN_KEY);
        loadAll();
      });
    }
    const bcl = $("btn-clear-token");
    if (bcl) {
      bcl.addEventListener("click", () => {
        localStorage.removeItem(TOKEN_KEY);
        const dt = $("dev-token");
        if (dt) dt.value = "";
        loadAll();
      });
    }

    const gOpen = $("onb-use-global-openai");
    if (gOpen) gOpen.addEventListener("change", syncOnbOpenaiField);
    syncOnbOpenaiField();
    const btnOnb = $("btn-onb-create");
    if (btnOnb) btnOnb.addEventListener("click", createOnboardingTenant);
    const btnV = $("btn-onb-verify");
    if (btnV) btnV.addEventListener("click", verifyOnboardingTenant);
    const btnB = $("btn-onb-bootstrap");
    if (btnB) btnB.addEventListener("click", bootstrapOnboardingPrompts);
    const btnR = $("btn-onb-rotate-int");
    if (btnR) btnR.addEventListener("click", rotateOnboardingIntegrationKey);

    const bcc = $("btn-copy-chat-url");
    if (bcc) bcc.addEventListener("click", () => copyToClipboard(buildChatUrl(), "Chat link copied."));
    const bci = $("btn-copy-install-url");
    if (bci) bci.addEventListener("click", () => copyToClipboard(buildChatUrl(), "Hosted chat URL copied."));
    const bcf = $("btn-copy-iframe");
    if (bcf) bcf.addEventListener("click", () => copyToClipboard(buildIframeSnippet(), "Iframe HTML copied."));

    wireBrandingPreviewInputs();
    wireConversationsLeadsUi();
    wireKnowledgeUi();
    wireBotBehaviorUi();
    wireBusinessProfileUi();
    wireWebhookTestUi();
    const btnPr = $("btn-pr-refresh");
    if (btnPr) btnPr.addEventListener("click", () => loadPilotReadinessModule(getAdminContext()));
    const osInit = $("onb-slug");
    if (osInit && !osInit.value.trim()) osInit.value = tenantSlug();
    adminModules = buildAdminModuleRegistry();
    setAdminVersionMarker();
    renderSessionStrip(meR);

    if (getPortalMode() === "client") {
      if (!state.allowedTenants.length) {
        return;
      }
      if (state.allowedTenants.length > 1 && !tenantSlug()) {
        return;
      }
    }

    await loadAll();
  }

  void init();
})();
