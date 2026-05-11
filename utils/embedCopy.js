/**
 * Public embed copy for / (chat): client-facing visitors vs internal operator preview.
 * Optional overrides from Tenant.settings.appearance.embed (JSON).
 */

function clipStr(value, maxLen) {
  if (value === undefined || value === null) return "";
  const s = String(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim()
    .slice(0, maxLen);
  return s;
}

function sanitizeStarters(raw, maxItems = 6) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw.slice(0, maxItems)) {
    if (!item || typeof item !== "object") continue;
    const label = clipStr(item.label, 80);
    const prompt = clipStr(item.prompt, 500);
    if (!label) continue;
    out.push({ label, prompt });
  }
  return out.length ? out : null;
}

/** Tenant override: explicit `starters: []` means no shortcut pills; omit key → use profile defaults. */
function resolveStarters(embed, baseStarters) {
  if (!embed || typeof embed !== "object" || !Object.prototype.hasOwnProperty.call(embed, "starters")) {
    return baseStarters;
  }
  const raw = embed.starters;
  if (Array.isArray(raw) && raw.length === 0) return [];
  const sanitized = sanitizeStarters(raw);
  return sanitized !== null ? sanitized : baseStarters;
}

const CLIENT_DEFAULTS = {
  headerFallback: "Assistant",
  welcomeTitle: "How can we help you today?",
  welcomeSubtitle: "Send a message below — we will respond here in the chat.",
  /** Visitor-facing default: no preset shortcut pills (tenant may add via settings.appearance.embed.starters). */
  starters: [],
};

const INTERNAL_DEFAULTS = {
  headerFallback: "Solomon",
  welcomeTitle: "Solomon — operator preview",
  welcomeSubtitle:
    "Test tenants with ?tenant=slug and manage them in the dashboard. Live customer sites should run with UI_PROFILE=client.",
  starters: [
    { label: "Ask a question", prompt: "" },
    { label: "Generate content", prompt: "Help me generate content about " },
    { label: "Analyze something", prompt: "I'd like you to analyze " },
  ],
};

function resolveUiProfile(envVal) {
  return String(envVal || "").toLowerCase() === "internal" ? "internal" : "client";
}

/**
 * @param {object} opts
 * @param {string} [opts.uiProfileEnv] process.env.UI_PROFILE
 * @param {string} [opts.publicProductLabelEnv] process.env.PUBLIC_PRODUCT_LABEL — fallback header when no tenant name
 * @param {{ name?: string|null, settings?: object|null }|null} opts.tenant
 */
function buildPublicEmbedCopy(opts) {
  const profile = resolveUiProfile(opts.uiProfileEnv);
  const base = profile === "internal" ? INTERNAL_DEFAULTS : CLIENT_DEFAULTS;
  const embed =
    opts.tenant?.settings &&
    typeof opts.tenant.settings === "object" &&
    opts.tenant.settings.appearance &&
    typeof opts.tenant.settings.appearance === "object" &&
    opts.tenant.settings.appearance.embed &&
    typeof opts.tenant.settings.appearance.embed === "object"
      ? opts.tenant.settings.appearance.embed
      : {};

  const labelFallback =
    clipStr(opts.publicProductLabelEnv, 120) || base.headerFallback;

  const headerFromEmbed = clipStr(embed.headerTitle, 120);
  let tenantName = clipStr(opts.tenant?.name, 120);
  if (profile === "client" && tenantName && /^default$/i.test(tenantName.trim())) {
    tenantName = "";
  }

  let headerTitle = headerFromEmbed || tenantName || labelFallback;
  if (profile === "internal" && !headerFromEmbed && !tenantName) {
    headerTitle = INTERNAL_DEFAULTS.headerFallback;
  }

  const welcomeTitle = clipStr(embed.welcomeTitle, 200) || base.welcomeTitle;
  const welcomeSubtitle = clipStr(embed.welcomeSubtitle, 400) || base.welcomeSubtitle;

  const starters = resolveStarters(embed, base.starters);

  return {
    uiProfile: profile,
    headerTitle,
    welcomeTitle,
    welcomeSubtitle,
    starters,
  };
}

module.exports = {
  buildPublicEmbedCopy,
  resolveUiProfile,
};
