/**
 * Shared tenant provisioning for CLI and admin API (Prisma + KMS + prompt files).
 */
const path = require("path");
const fsp = require("fs").promises;
const { randomBytes, createHash } = require("crypto");
const { encrypt, hasKey } = require("../utils/kms");

const RESERVED_SLUGS = new Set([
  "www",
  "admin",
  "localhost",
  "127.0.0.1",
  "::1",
  "api",
  "_",
]);

function repoRoot() {
  return path.join(__dirname, "..");
}

function sanitizeTenantSlug(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return s.slice(0, 64);
}

function maybeEncryptOpenAiKey(plaintext) {
  if (plaintext == null || plaintext === "") return null;
  if (hasKey()) return encrypt(String(plaintext));
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "KMS_MASTER_KEY is required in production to store OpenAI keys."
    );
  }
  return String(plaintext);
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} opts
 * @returns {Promise<{ ok: true, tenantId: string, created: boolean, updated: boolean, integrationKeyPlain: string|null } | { ok: false, error: string, code?: string }>}
 */
async function provisionTenant(prisma, opts) {
  const slug = sanitizeTenantSlug(opts.slug);
  const name = String(opts.name || "").trim();
  const plan = String(opts.plan || "basic").trim() || "basic";
  const force = Boolean(opts.force);
  const skipIntegrationKey = Boolean(opts.skipIntegrationKey);
  const rotateIntegration = Boolean(opts.rotateIntegrationKey);
  const useGlobalOpenai = Boolean(opts.useGlobalOpenai);
  const openaiRaw = useGlobalOpenai
    ? ""
    : String(opts.openaiKey || opts.openaiKeyPlain || "").trim();

  if (!slug) {
    return { ok: false, error: "slug_required", code: "validation" };
  }
  if (!name) {
    return { ok: false, error: "name_required", code: "validation" };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, error: "slug_reserved", code: "validation" };
  }

  const existing = await prisma.tenant.findFirst({
    where: { OR: [{ id: slug }, { subdomain: slug }] },
    select: { id: true, subdomain: true, name: true, apiKeyHash: true },
  });

  if (existing && !force) {
    return {
      ok: false,
      error: "tenant_already_exists",
      code: "conflict",
    };
  }

  let openaiKeyToStore = null;
  if (openaiRaw) {
    try {
      openaiKeyToStore = maybeEncryptOpenAiKey(openaiRaw);
    } catch (e) {
      return { ok: false, error: e.message || "openai_encrypt_failed", code: "kms" };
    }
  }

  let integrationKeyPlain = null;
  let apiKeyHash;
  let apiKeyLast4;
  let apiKeyRotatedAt;

  const shouldIssueIntegrationKey =
    !skipIntegrationKey &&
    (!existing || !existing.apiKeyHash || (existing && force && rotateIntegration));

  if (shouldIssueIntegrationKey) {
    integrationKeyPlain = `qmb_${randomBytes(24).toString("hex")}`;
    apiKeyHash = createHash("sha256").update(integrationKeyPlain).digest("hex");
    apiKeyLast4 = integrationKeyPlain.slice(-4);
    apiKeyRotatedAt = new Date();
  }

  const data = {
    name,
    subdomain: slug,
    plan,
    ...(openaiKeyToStore != null ? { openaiKey: openaiKeyToStore } : {}),
  };

  if (existing && force) {
    const updateData = {
      name: data.name,
      subdomain: slug,
      plan: data.plan,
      ...(openaiKeyToStore != null ? { openaiKey: openaiKeyToStore } : {}),
    };
    if (apiKeyHash) {
      updateData.apiKeyHash = apiKeyHash;
      updateData.apiKeyLast4 = apiKeyLast4;
      updateData.apiKeyRotatedAt = apiKeyRotatedAt;
    }
    await prisma.tenant.update({
      where: { id: existing.id },
      data: updateData,
    });
    return {
      ok: true,
      tenantId: existing.id,
      created: false,
      updated: true,
      integrationKeyPlain,
    };
  }

  try {
    await prisma.tenant.create({
      data: {
        id: slug,
        ...data,
        ...(apiKeyHash ? { apiKeyHash, apiKeyLast4, apiKeyRotatedAt } : {}),
        settings: {},
        prompts: {},
        branding: {},
      },
    });
  } catch (e) {
    if (e && e.code === "P2002") {
      return {
        ok: false,
        error: "unique_constraint",
        code: "conflict",
      };
    }
    throw e;
  }

  return {
    ok: true,
    tenantId: slug,
    created: true,
    updated: false,
    integrationKeyPlain,
  };
}

async function listTenantsForAdmin(prisma) {
  const rows = await prisma.tenant.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      subdomain: true,
      plan: true,
      createdAt: true,
      openaiKey: true,
      apiKeyHash: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    subdomain: r.subdomain,
    plan: r.plan,
    createdAt: r.createdAt,
    hasOpenaiKey: Boolean(r.openaiKey),
    hasIntegrationKey: Boolean(r.apiKeyHash),
  }));
}

/**
 * @param {object} [envHints]
 * @param {boolean} [envHints.globalOpenaiConfigured] — server has OPENAI_API_KEY
 * @param {boolean} [envHints.openaiBootOptional] — OPENAI_BOOT_OPTIONAL=1
 */
async function verifyTenantForAdmin(prisma, slugRaw, root = repoRoot(), envHints = {}) {
  const slug = sanitizeTenantSlug(slugRaw);
  if (!slug) {
    return { ok: false, error: "slug_required" };
  }

  const row = await prisma.tenant.findFirst({
    where: { OR: [{ id: slug }, { subdomain: slug }] },
    select: {
      id: true,
      name: true,
      subdomain: true,
      plan: true,
      openaiKey: true,
      apiKeyHash: true,
      settings: true,
      prompts: true,
    },
  });

  if (!row) {
    return { ok: false, error: "tenant_not_found" };
  }

  const hasDbPrompts = Boolean(
    row.prompts &&
      typeof row.prompts === "object" &&
      (row.prompts.system || row.prompts.policy || row.prompts.voice)
  );
  const promptsDir = path.join(root, "prompts", "tenants", row.subdomain || row.id);
  let hasFsPrompts = false;
  try {
    await fsp.access(path.join(promptsDir, "systemprompt.md"));
    hasFsPrompts = true;
  } catch {
    /* optional */
  }

  let promptsSummary = "inherit_default";
  if (hasDbPrompts) promptsSummary = "database_json";
  else if (hasFsPrompts) promptsSummary = "filesystem";

  const settingsKeys =
    row.settings && typeof row.settings === "object" ? Object.keys(row.settings) : [];

  const globalOpenai = Boolean(envHints.globalOpenaiConfigured);
  const openaiOptional = Boolean(envHints.openaiBootOptional);
  const hasTenantOpenai = Boolean(row.openaiKey);
  const readyForChat = hasTenantOpenai || globalOpenai || openaiOptional;

  /** @type {{ code: string, message: string, severity: string }[]} */
  const warnings = [];
  if (!hasTenantOpenai && !globalOpenai && !openaiOptional) {
    warnings.push({
      code: "no_openai",
      severity: "error",
      message:
        "Chat will fail: this tenant has no stored OpenAI key and the server has no OPENAI_API_KEY (and OPENAI_BOOT_OPTIONAL is not set).",
    });
  } else if (!hasTenantOpenai && globalOpenai) {
    warnings.push({
      code: "uses_global_openai",
      severity: "info",
      message:
        "This tenant relies on the server-wide OPENAI_API_KEY. Ensure it stays configured in your deployment environment.",
    });
  }
  if (!row.apiKeyHash) {
    warnings.push({
      code: "no_integration_key",
      severity: "warn",
      message:
        "Inbound integration routes (/api/integrations/v1/…) require an integration API key. Create a tenant with a key or rotate one from this dashboard.",
    });
  }

  const badges = {
    chat: readyForChat ? "ready" : "blocked",
    integrations: row.apiKeyHash ? "ready" : "missing",
    prompts:
      promptsSummary === "inherit_default"
        ? "default"
        : promptsSummary === "database_json"
          ? "db"
          : "files",
  };

  return {
    ok: true,
    tenant: {
      id: row.id,
      name: row.name,
      subdomain: row.subdomain,
      plan: row.plan,
      openai: row.openaiKey ? "per_tenant" : "global_or_unset",
      integrationKey: row.apiKeyHash ? "configured" : "missing",
      prompts: promptsSummary,
      promptsPath: hasFsPrompts ? promptsDir : null,
      settingsKeys,
    },
    readyForChat,
    badges,
    warnings,
    serverHints: {
      globalOpenaiConfigured: globalOpenai,
      openaiBootOptional: openaiOptional,
    },
  };
}

async function bootstrapPromptsForTenant(prisma, slugRaw, root = repoRoot()) {
  const slug = sanitizeTenantSlug(slugRaw);
  if (!slug) {
    return { ok: false, error: "slug_required", files: [] };
  }

  const row = await prisma.tenant.findFirst({
    where: { OR: [{ id: slug }, { subdomain: slug }] },
    select: { id: true, subdomain: true },
  });
  if (!row) {
    return { ok: false, error: "tenant_not_found", files: [] };
  }

  const sub = row.subdomain || row.id;
  const srcDir = path.join(root, "prompts", "tenants", "default");
  const destDir = path.join(root, "prompts", "tenants", sub);
  await fsp.mkdir(destDir, { recursive: true });

  const files = ["systemprompt.md", "policy.md", "voice.md"];
  const out = [];
  for (const f of files) {
    const dest = path.join(destDir, f);
    try {
      await fsp.access(dest);
      out.push({ file: f, status: "skipped_exists" });
    } catch {
      const text = await fsp.readFile(path.join(srcDir, f), "utf8");
      await fsp.writeFile(dest, text, "utf8");
      out.push({ file: f, status: "created" });
    }
  }
  return { ok: true, tenantId: row.id, files: out };
}

/**
 * @returns {Promise<{ ok: true, apiKey: string } | { ok: false, error: string }>}
 */
async function rotateTenantIntegrationKey(prisma, slugRaw) {
  const slug = sanitizeTenantSlug(slugRaw);
  if (!slug) return { ok: false, error: "slug_required" };

  const row = await prisma.tenant.findFirst({
    where: { OR: [{ id: slug }, { subdomain: slug }] },
    select: { id: true },
  });
  if (!row) return { ok: false, error: "tenant_not_found" };

  const clearKey = `qmb_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(clearKey).digest("hex");
  await prisma.tenant.update({
    where: { id: row.id },
    data: {
      apiKeyHash: hash,
      apiKeyLast4: clearKey.slice(-4),
      apiKeyRotatedAt: new Date(),
    },
  });
  return { ok: true, apiKey: clearKey, tenantId: row.id };
}

module.exports = {
  RESERVED_SLUGS,
  repoRoot,
  sanitizeTenantSlug,
  provisionTenant,
  listTenantsForAdmin,
  verifyTenantForAdmin,
  bootstrapPromptsForTenant,
  rotateTenantIntegrationKey,
};
