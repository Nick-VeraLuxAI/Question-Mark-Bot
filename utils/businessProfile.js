/**
 * Tenant business profile (Tenant.settings.businessProfile).
 * Context for the model — does not replace policy, safety, or system prompts.
 */

const BP_FIELD_KEYS = [
  "businessName",
  "shortDescription",
  "services",
  "serviceAreas",
  "address",
  "phone",
  "email",
  "website",
  "bookingUrl",
  "hours",
  "afterHoursMessage",
  "escalationContact",
  "policies",
];

const LIMITS = {
  businessName: 200,
  shortDescription: 1000,
  services: 3000,
  serviceAreas: 2000,
  address: 500,
  phone: 100,
  email: 200,
  website: 500,
  bookingUrl: 500,
  hours: 2000,
  afterHoursMessage: 1000,
  escalationContact: 1000,
  policies: 3000,
};

const MAX_BUSINESS_PROFILE_INSTRUCTION_CHARS = 5000;

function clampStr(v, max) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function isValidOptionalHttpUrl(s) {
  if (!s || !String(s).trim()) return true;
  const t = String(s).trim();
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidOptionalEmail(s) {
  if (!s || !String(s).trim()) return true;
  const t = String(s).trim();
  if (t.length > LIMITS.email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

function getRawBusinessProfile(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const p = settings.businessProfile;
  if (!p || typeof p !== "object" || Array.isArray(p)) return {};
  return p;
}

function normalizeBusinessProfileForStorage(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const key of BP_FIELD_KEYS) {
    out[key] = clampStr(src[key], LIMITS[key]);
  }
  out.updatedAt =
    typeof src.updatedAt === "string" && src.updatedAt.trim()
      ? src.updatedAt.trim().slice(0, 40)
      : "";
  return out;
}

function defaultBusinessProfilePayload() {
  const o = {};
  for (const key of BP_FIELD_KEYS) o[key] = "";
  o.updatedAt = "";
  return o;
}

/**
 * Merge PATCH `businessProfile` into current stored profile (only keys explicitly sent are replaced).
 * @param {unknown} existingSettings tenant.settings
 * @param {unknown} patch businessProfile object from client
 */
function mergeBusinessProfileIncoming(existingSettings, patch) {
  const cur = normalizeBusinessProfileForStorage(getRawBusinessProfile(existingSettings));
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return cur;
  const next = { ...cur };
  for (const key of BP_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  return next;
}

/**
 * @returns {{ ok: true, normalized: object } | { ok: false, errors: object[], status: number }}
 */
function validateAndNormalizeBusinessProfilePatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ code: "business_profile_object_required" }], status: 400 };
  }
  const errors = [];

  for (const key of BP_FIELD_KEYS) {
    const v = body[key];
    if (v == null) continue;
    if (typeof v !== "string") {
      errors.push({ field: key, code: "must_be_string" });
      continue;
    }
    if (v.length > LIMITS[key]) errors.push({ field: key, code: "too_long", max: LIMITS[key] });
  }

  if (body.updatedAt != null && body.updatedAt !== "") {
    if (typeof body.updatedAt !== "string") errors.push({ field: "updatedAt", code: "must_be_string" });
  }

  if (errors.length) return { ok: false, errors, status: 400 };

  const email = body.email != null ? String(body.email).trim() : "";
  if (email && !isValidOptionalEmail(email)) {
    errors.push({ field: "email", code: "invalid_email" });
  }
  const website = body.website != null ? String(body.website).trim() : "";
  if (website && !isValidOptionalHttpUrl(website)) {
    errors.push({ field: "website", code: "invalid_url" });
  }
  const bookingUrl = body.bookingUrl != null ? String(body.bookingUrl).trim() : "";
  if (bookingUrl && !isValidOptionalHttpUrl(bookingUrl)) {
    errors.push({ field: "bookingUrl", code: "invalid_url" });
  }

  if (errors.length) return { ok: false, errors, status: 400 };

  const normalized = normalizeBusinessProfileForStorage(body);
  normalized.updatedAt = new Date().toISOString();
  return { ok: true, normalized };
}

function getBusinessProfileForGet(settings) {
  const raw = getRawBusinessProfile(settings);
  const hasAnyStored = BP_FIELD_KEYS.some((k) => {
    const v = raw[k];
    return typeof v === "string" && v.trim().length > 0;
  });
  const defaultsApplied = !hasAnyStored;
  const businessProfile = normalizeBusinessProfileForStorage(raw);
  return {
    businessProfile,
    defaultsApplied,
    source: "tenant.settings.businessProfile",
  };
}

function hasNonEmptyProfile(p) {
  if (!p || typeof p !== "object") return false;
  return BP_FIELD_KEYS.some((k) => {
    const v = p[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/**
 * @param {import("@prisma/client").Tenant | { settings?: unknown }} tenant
 * @returns {string|null}
 */
function buildBusinessProfileInstruction(tenant) {
  const raw = getRawBusinessProfile(tenant?.settings);
  const p = normalizeBusinessProfileForStorage(raw);
  if (!hasNonEmptyProfile(p)) return null;

  const lines = [];
  if (p.businessName) lines.push(`- Business name: ${p.businessName}`);
  if (p.shortDescription) lines.push(`- Description: ${p.shortDescription}`);
  if (p.services) lines.push(`- Services: ${p.services}`);
  if (p.serviceAreas) lines.push(`- Service areas: ${p.serviceAreas}`);
  const contactBits = [];
  if (p.address) contactBits.push(`Address: ${p.address}`);
  if (p.phone) contactBits.push(`Phone: ${p.phone}`);
  if (p.email) contactBits.push(`Email: ${p.email}`);
  if (p.website) contactBits.push(`Website: ${p.website}`);
  if (contactBits.length) lines.push(`- Contact: ${contactBits.join(" · ")}`);
  if (p.hours) lines.push(`- Hours: ${p.hours}`);
  if (p.afterHoursMessage) lines.push(`- After hours: ${p.afterHoursMessage}`);
  if (p.bookingUrl) lines.push(`- Booking URL: ${p.bookingUrl}`);
  if (p.escalationContact) lines.push(`- Escalation contact: ${p.escalationContact}`);
  if (p.policies) lines.push(`- Policies / important rules: ${p.policies}`);

  if (!lines.length) return null;

  let text =
    "Tenant business profile (factual business context for visitors; does not override platform safety, policy, voice guide, or legal requirements):\n" +
    lines.join("\n");
  if (text.length > MAX_BUSINESS_PROFILE_INSTRUCTION_CHARS) {
    text = text.slice(0, MAX_BUSINESS_PROFILE_INSTRUCTION_CHARS) + "\n[…truncated]";
  }
  return text;
}

module.exports = {
  BP_FIELD_KEYS,
  LIMITS,
  defaultBusinessProfilePayload,
  getRawBusinessProfile,
  getBusinessProfileForGet,
  validateAndNormalizeBusinessProfilePatch,
  mergeBusinessProfileIncoming,
  buildBusinessProfileInstruction,
};
