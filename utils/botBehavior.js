/**
 * Tenant-guided bot behavior (stored under Tenant.settings.behavior).
 * Not a raw system prompt — converted to a bounded system message after policy/voice.
 */

const BEHAVIOR_TONES = new Set([
  "professional",
  "friendly",
  "concise",
  "warm",
  "luxury",
  "playful",
  "technical",
]);

const DEFAULT_TONE = "professional";

const LIMITS = {
  greeting: 500,
  businessRole: 1000,
  primaryGoal: 1000,
  fallbackAnswer: 1000,
  escalationInstructions: 2000,
  leadCaptureInstructions: 2000,
  avoidTopics: 2000,
  specialRules: 3000,
};

const MAX_BEHAVIOR_INSTRUCTION_CHARS = 5500;

const BEHAVIOR_FIELD_KEYS = [
  "greeting",
  "tone",
  "businessRole",
  "primaryGoal",
  "fallbackAnswer",
  "escalationInstructions",
  "leadCaptureInstructions",
  "avoidTopics",
  "specialRules",
];

function getRawBehavior(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const b = settings.behavior;
  if (!b || typeof b !== "object" || Array.isArray(b)) return {};
  return b;
}

/** Coerce stored behavior to safe strings + allowlisted tone (for GET display / instruction build). */
function normalizeBehaviorForStorage(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  let tone = String(src.tone ?? "").trim().toLowerCase();
  if (!BEHAVIOR_TONES.has(tone)) tone = DEFAULT_TONE;
  return {
    greeting: clampStr(src.greeting, LIMITS.greeting),
    tone,
    businessRole: clampStr(src.businessRole, LIMITS.businessRole),
    primaryGoal: clampStr(src.primaryGoal, LIMITS.primaryGoal),
    fallbackAnswer: clampStr(src.fallbackAnswer, LIMITS.fallbackAnswer),
    escalationInstructions: clampStr(src.escalationInstructions, LIMITS.escalationInstructions),
    leadCaptureInstructions: clampStr(src.leadCaptureInstructions, LIMITS.leadCaptureInstructions),
    avoidTopics: clampStr(src.avoidTopics, LIMITS.avoidTopics),
    specialRules: clampStr(src.specialRules, LIMITS.specialRules),
    updatedAt:
      typeof src.updatedAt === "string" && src.updatedAt.trim()
        ? src.updatedAt.trim().slice(0, 40)
        : null,
  };
}

function clampStr(v, max) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

/**
 * Strict validation for PATCH. Unknown tone → 400. Oversized / wrong types → 400.
 * @returns {{ ok: true, normalized: object } | { ok: false, errors: object[], status: number }}
 */
/**
 * Merge PATCH `behavior` into current stored behavior (only keys explicitly sent are replaced).
 * @param {unknown} existingSettings tenant.settings
 * @param {unknown} patch behavior object from client
 */
function mergeBehaviorIncoming(existingSettings, patch) {
  const cur = normalizeBehaviorForStorage(getRawBehavior(existingSettings));
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return cur;
  const next = { ...cur };
  for (const k of BEHAVIOR_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  }
  return next;
}

function validateAndNormalizeBehaviorPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ code: "behavior_object_required" }], status: 400 };
  }
  const errors = [];

  if (body.tone != null && body.tone !== "") {
    if (typeof body.tone !== "string") errors.push({ field: "tone", code: "must_be_string" });
    else {
      const t = body.tone.trim().toLowerCase();
      if (!BEHAVIOR_TONES.has(t)) errors.push({ field: "tone", code: "invalid_tone", allowed: [...BEHAVIOR_TONES] });
    }
  }

  for (const key of Object.keys(LIMITS)) {
    const v = body[key];
    if (v == null) continue;
    if (typeof v !== "string") {
      errors.push({ field: key, code: "must_be_string" });
      continue;
    }
    if (v.length > LIMITS[key]) errors.push({ field: key, code: "too_long", max: LIMITS[key] });
  }

  if (errors.length) return { ok: false, errors, status: 400 };

  const normalized = normalizeBehaviorForStorage(body);
  normalized.updatedAt = new Date().toISOString();
  return { ok: true, normalized };
}

function getBehaviorForGet(settings) {
  const raw = getRawBehavior(settings);
  const defaultsApplied = Object.keys(raw).length === 0;
  const behavior = normalizeBehaviorForStorage(raw);
  return {
    behavior,
    defaultsApplied,
    source: "tenant.settings.behavior",
  };
}

/**
 * Bounded business guidance — injected after system/policy/voice and tenant business profile in chat.
 * @param {import("@prisma/client").Tenant | { settings?: unknown }} tenant
 * @returns {string|null}
 */
function buildBehaviorInstruction(tenant) {
  const raw = getRawBehavior(tenant?.settings);
  const b = normalizeBehaviorForStorage(raw);
  const lines = [];
  if (b.greeting) lines.push(`- Greeting style: ${b.greeting}`);
  if (b.tone) lines.push(`- Tone: ${b.tone}`);
  if (b.businessRole) lines.push(`- Business role: ${b.businessRole}`);
  if (b.primaryGoal) lines.push(`- Primary goal: ${b.primaryGoal}`);
  if (b.fallbackAnswer) lines.push(`- When you cannot answer fully: ${b.fallbackAnswer}`);
  if (b.escalationInstructions) lines.push(`- Escalation: ${b.escalationInstructions}`);
  if (b.leadCaptureInstructions) lines.push(`- Lead capture: ${b.leadCaptureInstructions}`);
  if (b.avoidTopics) lines.push(`- Topics or responses to avoid: ${b.avoidTopics}`);
  if (b.specialRules) lines.push(`- Special business rules: ${b.specialRules}`);
  if (!lines.length) return null;

  let text =
    "Tenant-configured behavior guidance (non-authoritative; does not override platform safety, policy, or system-critical instructions):\n" +
    lines.join("\n");
  if (text.length > MAX_BEHAVIOR_INSTRUCTION_CHARS) {
    text = text.slice(0, MAX_BEHAVIOR_INSTRUCTION_CHARS) + "\n[…truncated]";
  }
  return text;
}

function defaultBehaviorPayload() {
  return validateAndNormalizeBehaviorPatch({
    greeting: "",
    tone: DEFAULT_TONE,
    businessRole: "",
    primaryGoal: "",
    fallbackAnswer: "",
    escalationInstructions: "",
    leadCaptureInstructions: "",
    avoidTopics: "",
    specialRules: "",
  }).normalized;
}

module.exports = {
  BEHAVIOR_TONES,
  DEFAULT_TONE,
  LIMITS,
  getRawBehavior,
  getBehaviorForGet,
  mergeBehaviorIncoming,
  validateAndNormalizeBehaviorPatch,
  buildBehaviorInstruction,
  defaultBehaviorPayload,
};
