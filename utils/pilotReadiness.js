/**
 * Pilot / launch readiness scoring (heuristic). Used by GET /api/admin/pilot-readiness.
 * No secrets in output — caller passes a redacted snapshot only.
 */

const { getBusinessProfileForGet } = require("./businessProfile");
const { getBehaviorForGet } = require("./botBehavior");

function normalizeRole(role) {
  return String(role || "viewer").toLowerCase();
}

function operatorCapable(role) {
  const r = normalizeRole(role);
  return r === "owner" || r === "admin" || r === "operator";
}

function hasConfigWrite(role) {
  const r = normalizeRole(role);
  if (r === "owner" || r === "admin" || r === "operator") return true;
  return false;
}

function hasFunnelRead(role) {
  const r = normalizeRole(role);
  if (r === "owner" || r === "admin" || r === "operator" || r === "analyst" || r === "viewer") return true;
  return false;
}

function isBrandingConfigured(tenant) {
  const t = tenant || {};
  if (t.brandColor || t.botBg || t.botText || t.userBg || t.brandHover) return true;
  if (t.branding && typeof t.branding === "object" && Object.keys(t.branding).length > 0) return true;
  const s = t.settings && typeof t.settings === "object" ? t.settings : {};
  const ap = s.appearance && typeof s.appearance === "object" ? s.appearance : {};
  if (ap.theme === "dark" || ap.theme === "light") return true;
  return false;
}

function isBehaviorPilotReady(settings) {
  const { behavior, defaultsApplied } = getBehaviorForGet(settings);
  if (!defaultsApplied) return true;
  const keys = [
    "greeting",
    "businessRole",
    "primaryGoal",
    "fallbackAnswer",
    "escalationInstructions",
    "leadCaptureInstructions",
    "avoidTopics",
    "specialRules",
  ];
  return keys.some((k) => behavior[k] && String(behavior[k]).trim().length > 0);
}

function isBusinessProfileReady(settings) {
  return getBusinessProfileForGet(settings).defaultsApplied === false;
}

function verifyHasErrorSeverity(warnings) {
  if (!Array.isArray(warnings)) return false;
  return warnings.some((w) => w && w.severity === "error");
}

/**
 * @param {object} input
 * @param {object} input.tenant safe tenant row (settings, branding columns, no openaiKey string)
 * @param {boolean} input.readyForChat
 * @param {object} input.verify from verifyTenantForAdmin (ok, warnings, badges, readyForChat)
 * @param {number} input.activeKnowledgeCount
 * @param {number} input.conversationCount
 * @param {number} input.leadCount
 * @param {number} input.webhookEnabledCount
 * @param {boolean} input.integrationKeyConfigured
 * @param {string} input.role platform role
 * @param {boolean} input.devToolsHiddenInProd
 */
function computePilotReadiness(input) {
  const {
    tenant,
    readyForChat,
    verify,
    activeKnowledgeCount,
    conversationCount,
    leadCount,
    webhookEnabledCount,
    integrationKeyConfigured,
    role,
    devToolsHiddenInProd,
  } = input;

  const settings = tenant?.settings;
  const slug = tenant?.subdomain || tenant?.id || "";
  const displayName = tenant?.name || slug || "Tenant";
  const plan = tenant?.plan || "basic";

  const opCap = operatorCapable(role);
  const cfgWrite = hasConfigWrite(role);
  const funnelOk = hasFunnelRead(role);

  /** @type {object[]} */
  const items = [];

  const add = (def) => {
    items.push({
      id: def.id,
      group: def.group,
      label: def.label,
      status: def.status,
      severity: def.severity,
      customerVisible: def.customerVisible !== false,
      operatorOnly: Boolean(def.operatorOnly),
      message: def.message,
      actionLabel: def.actionLabel || null,
      actionTarget: def.actionTarget || null,
      technicalHint: def.technicalHint || null,
    });
  };

  // --- Core ---
  add({
    id: "tenant_loaded",
    group: "core",
    label: "Site profile",
    status: "ok",
    severity: "required",
    message: "This site is loaded and matches your selection.",
    actionLabel: null,
    actionTarget: null,
  });

  const aiOk = Boolean(readyForChat);
  let aiMessage = "Chat can reach an AI provider (tenant key, server key, or boot-optional mode).";
  if (!aiOk) {
    aiMessage =
      "Chat cannot run yet: add a dedicated AI key for this site, ask your operator to configure the server key, or enable OPENAI_BOOT_OPTIONAL for non-prod.";
  }
  add({
    id: "ai_provider",
    group: "core",
    label: "AI provider",
    status: aiOk ? "ok" : "fail",
    severity: "required",
    message: aiMessage,
    actionLabel: opCap ? "Site provisioning" : null,
    actionTarget: opCap ? "panel-onboarding" : null,
    operatorOnly: !cfgWrite && !aiOk,
    technicalHint: verify?.serverHints
      ? `globalOpenai=${Boolean(verify.serverHints.globalOpenaiConfigured)}, openaiBootOptional=${Boolean(verify.serverHints.openaiBootOptional)}`
      : null,
  });

  const bpOk = isBusinessProfileReady(settings);
  add({
    id: "business_profile",
    group: "core",
    label: "Business profile",
    status: bpOk ? "ok" : "fail",
    severity: "required",
    message: bpOk
      ? "Business context is saved for this site."
      : "Add your business name and basics so the bot has accurate context.",
    actionLabel: "Open business profile",
    actionTarget: "dashboard-business-profile-root",
  });

  const behOk = isBehaviorPilotReady(settings);
  add({
    id: "bot_behavior",
    group: "bot_quality",
    label: "Bot behavior",
    status: behOk ? "ok" : "fail",
    severity: "required",
    message: behOk
      ? "Guided behavior is configured beyond empty defaults."
      : "Set goals, tone, or lead capture guidance so replies match how you work.",
    actionLabel: "Open bot behavior",
    actionTarget: "dashboard-bot-behavior-root",
  });

  const knOk = activeKnowledgeCount > 0;
  add({
    id: "knowledge_base",
    group: "bot_quality",
    label: "Knowledge base",
    status: knOk ? "ok" : "fail",
    severity: "required",
    message: knOk
      ? `At least one active knowledge document (${activeKnowledgeCount}).`
      : "Add at least one active knowledge entry so the bot can cite your text.",
    actionLabel: "Open knowledge base",
    actionTarget: "dashboard-knowledge-root",
  });

  // --- Website (always available in-app; still listed for clarity) ---
  add({
    id: "chat_preview",
    group: "website",
    label: "Chat preview",
    status: "ok",
    severity: "required",
    message: "Hosted chat preview and link are available from this dashboard.",
    actionLabel: "Open chat preview",
    actionTarget: "panel-preview",
  });

  add({
    id: "install_snippet",
    group: "website",
    label: "Website install",
    status: "ok",
    severity: "required",
    message: "Install link and iframe snippet helpers are available.",
    actionLabel: "Open install helpers",
    actionTarget: "dashboard-website-modules",
  });

  const brOk = isBrandingConfigured(tenant);
  add({
    id: "branding",
    group: "website",
    label: "Look & feel",
    status: brOk ? "ok" : "warn",
    severity: "recommended",
    message: brOk
      ? "Brand colors or embed theme are customized."
      : "Optional: tune colors and embed theme so the chat matches your brand.",
    actionLabel: "Open look & feel",
    actionTarget: "dashboard-business-modules",
  });

  // --- Operations ---
  add({
    id: "conversations_module",
    group: "operations",
    label: "Conversations",
    status: funnelOk ? "ok" : "na",
    severity: "recommended",
    message: funnelOk
      ? "You can review recent threads with your current role."
      : "Your role cannot read the conversations list (funnel read).",
    actionLabel: funnelOk ? "Open conversations" : null,
    actionTarget: funnelOk ? "dashboard-conversations-root" : null,
    operatorOnly: !funnelOk,
  });

  add({
    id: "leads_module",
    group: "operations",
    label: "Leads",
    status: funnelOk ? "ok" : "na",
    severity: "recommended",
    message: funnelOk ? "You can review captured leads with your current role." : "Your role cannot read leads.",
    actionLabel: funnelOk ? "Open leads" : null,
    actionTarget: funnelOk ? "dashboard-leads-root" : null,
    operatorOnly: !funnelOk,
  });

  add({
    id: "pilot_conversation",
    group: "operations",
    label: "Test conversation",
    status: conversationCount >= 1 ? "ok" : "warn",
    severity: "recommended",
    message:
      conversationCount >= 1
        ? "At least one chat thread exists — good signal before a pilot."
        : "Optional: send a few test messages through hosted chat before inviting customers.",
    actionLabel: "Open chat preview",
    actionTarget: "panel-preview",
  });

  const { behavior: behForLead } = getBehaviorForGet(settings);
  const leadSignal =
    leadCount >= 1 || (behForLead.leadCaptureInstructions && String(behForLead.leadCaptureInstructions).trim());
  add({
    id: "pilot_leads_signal",
    group: "operations",
    label: "Lead capture signal",
    status: leadSignal ? "ok" : "warn",
    severity: "recommended",
    message: leadSignal
      ? "Leads exist or lead-capture instructions are set in bot behavior."
      : "Optional: capture a test lead or document how staff should collect contacts.",
    actionLabel: "Open bot behavior",
    actionTarget: "dashboard-bot-behavior-root",
  });

  const whOk = webhookEnabledCount > 0;
  add({
    id: "webhooks_optional",
    group: "operations",
    label: "Outbound webhooks",
    status: whOk ? "ok" : "warn",
    severity: "recommended",
    message: whOk
      ? `${webhookEnabledCount} enabled webhook(s). CRM events can be pushed.`
      : "Optional: add a webhook if external systems should receive lead events.",
    actionLabel: whOk ? null : null,
    actionTarget: whOk ? "dashboard-webhook-testing-root" : "panel-integrations",
  });

  if (whOk) {
    add({
      id: "webhook_test_reminder",
      group: "operations",
      label: "Webhook delivery test",
      status: cfgWrite ? "warn" : "na",
      severity: "recommended",
      customerVisible: true,
      operatorOnly: !cfgWrite,
      message: cfgWrite
        ? "Run a test delivery from Webhook test & health after any endpoint change."
        : "Ask an operator with config write to send a test delivery after changes.",
      actionLabel: cfgWrite ? "Open webhook test" : null,
      actionTarget: cfgWrite ? "dashboard-webhook-testing-root" : null,
    });
  }

  add({
    id: "integration_api_key",
    group: "operations",
    label: "Integration API key",
    status: integrationKeyConfigured ? "ok" : "warn",
    severity: "recommended",
    message: integrationKeyConfigured
      ? "An integration key is on file for inbound API calls."
      : "Inbound integration routes need a key — rotate or provision from operator tools.",
    actionLabel: opCap ? "Site provisioning" : null,
    actionTarget: opCap ? "panel-onboarding" : null,
    operatorOnly: true,
  });

  // --- Security ---
  add({
    id: "platform_auth",
    group: "security",
    label: "Signed in",
    status: "ok",
    severity: "required",
    message: "You are authenticated to the control panel.",
  });

  add({
    id: "role_pilot_edits",
    group: "security",
    label: "Role for edits",
    status: cfgWrite ? "ok" : "warn",
    severity: "recommended",
    message: cfgWrite
      ? "Your role can save tenant configuration in this UI."
      : "Your role is mostly read-only — an owner, admin, or operator should complete setup.",
    operatorOnly: !cfgWrite,
  });

  add({
    id: "dev_tools_exposure",
    group: "security",
    label: "Developer tools",
    status: devToolsHiddenInProd ? "ok" : "warn",
    severity: "recommended",
    message: devToolsHiddenInProd
      ? "Developer bearer-token tools are hidden in this production build."
      : "Developer access token UI is visible — avoid storing production secrets in the browser.",
    technicalHint: "ALLOW_ADMIN_BEARER_DEV_TOOLS / NODE_ENV",
  });

  const verifyErr = verifyHasErrorSeverity(verify?.warnings);
  add({
    id: "tenant_verify_signals",
    group: "security",
    label: "Operator readiness check",
    status: verifyErr ? "warn" : "ok",
    severity: "recommended",
    message: verifyErr
      ? "Provisioning verify reported blocking issues — review warnings with your operator."
      : "Provisioning verify shows no blocking warnings for this site.",
    actionLabel: opCap ? "Open provisioning" : null,
    actionTarget: opCap ? "panel-onboarding" : null,
    operatorOnly: !opCap && verifyErr,
    technicalHint: verify?.warnings?.length ? JSON.stringify(verify.warnings.map((w) => w.code)) : null,
  });

  // --- Scoring & rollup status ---
  const required = items.filter((i) => i.severity === "required");
  const recommended = items.filter((i) => i.severity === "recommended");

  const requiredFails = required.filter((i) => i.status === "fail");
  const requiredWarns = required.filter((i) => i.status === "warn");

  const recMiss = recommended.filter((i) => i.status === "fail" || i.status === "warn");

  let score = 100;
  score -= requiredFails.length * 18;
  score -= requiredWarns.length * 10;
  score -= Math.min(12, recMiss.length * 4);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let status = "ready";
  if (requiredFails.length > 0) {
    status = !cfgWrite ? "operator_required" : "needs_attention";
  }

  return {
    ok: true,
    tenant: {
      slug,
      displayName,
      plan,
    },
    readiness: {
      status,
      score,
      items,
    },
  };
}

module.exports = {
  computePilotReadiness,
  operatorCapable,
  isBrandingConfigured,
  isBehaviorPilotReady,
  isBusinessProfileReady,
};
