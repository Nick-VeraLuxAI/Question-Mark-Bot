#!/usr/bin/env node
/**
 * Operator CLI: create, list, verify tenants; copy default prompt files.
 * Core logic: services/tenantProvisioning.js
 */
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { PrismaClient } = require("@prisma/client");
const {
  sanitizeTenantSlug,
  provisionTenant,
  listTenantsForAdmin,
  verifyTenantForAdmin,
  bootstrapPromptsForTenant,
} = require("../services/tenantProvisioning");

const prisma = new PrismaClient();

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usage() {
  console.log(`
Usage:
  node scripts/tenant-cli.js create --slug <slug> --name "<display name>" [options]
  node scripts/tenant-cli.js list
  node scripts/tenant-cli.js verify --slug <slug>
  node scripts/tenant-cli.js bootstrap-prompts --slug <slug>

create options:
  --plan <plan>              default: basic
  --openai-key <key>         tenant-specific OpenAI key (or set env OPENAI_KEY_FOR_TENANT)
  --skip-integration-key     do not generate qmb_* integration API key
  --force                    if tenant exists, update name/plan (and openai if --openai-key)
  --rotate-integration-key   with --force, issue a new integration key (or create one if missing)

verify / bootstrap-prompts:
  --slug <slug>              tenant id/subdomain (required)

npm examples:
  npm run tenant:create -- --slug acme --name "Acme Corp"
  npm run tenant:verify -- --slug acme
`);
}

async function cmdCreate(flags) {
  const openaiRaw = flags["openai-key"] || process.env.OPENAI_KEY_FOR_TENANT || "";

  const result = await provisionTenant(prisma, {
    slug: flags.slug,
    name: flags.name,
    plan: flags.plan,
    useGlobalOpenai: !openaiRaw,
    openaiKey: openaiRaw,
    skipIntegrationKey: Boolean(flags["skip-integration-key"]),
    force: Boolean(flags.force),
    rotateIntegrationKey: Boolean(flags["rotate-integration-key"]),
  });

  if (!result.ok) {
    if (result.error === "tenant_already_exists") {
      console.error(
        `tenant-cli: tenant already exists. Use --force to update metadata and optional keys.`
      );
    } else if (result.error === "slug_required") {
      console.error("tenant-cli: --slug is required");
    } else if (result.error === "name_required") {
      console.error("tenant-cli: --name is required");
    } else if (result.error === "slug_reserved") {
      console.error("tenant-cli: slug is reserved; pick another.");
    } else if (result.error === "unique_constraint") {
      console.error(
        "tenant-cli: unique constraint failed — id or subdomain already used by another tenant."
      );
    } else {
      console.error("tenant-cli:", result.error);
    }
    process.exit(1);
  }

  if (result.updated) console.log(`tenant-cli: updated tenant id=${result.tenantId}`);
  else console.log(`tenant-cli: created tenant id=${result.tenantId}`);

  if (result.integrationKeyPlain) {
    console.log("");
    console.log("Integration API key (save once; used for inbound integrations + X-Api-Key):");
    console.log(result.integrationKeyPlain);
    console.log("");
  } else {
    console.log("No integration API key generated (--skip-integration-key).");
  }

  if (!openaiRaw) {
    console.log(
      "Note: no per-tenant OpenAI key set; chat uses OPENAI_API_KEY from environment unless you add openaiKey later."
    );
  }
}

async function cmdList() {
  const rows = await listTenantsForAdmin(prisma);
  if (!rows.length) {
    console.log("(no tenants)");
    return;
  }
  console.log("id\tsubdomain\tplan\topenai?\tintegration_key?\tname");
  for (const r of rows) {
    console.log(
      `${r.id}\t${r.subdomain || ""}\t${r.plan}\t${r.hasOpenaiKey ? "yes" : "no"}\t${r.hasIntegrationKey ? "yes" : "no"}\t${r.name}`
    );
  }
}

async function cmdVerify(flags) {
  const slug = sanitizeTenantSlug(flags.slug);
  if (!slug) {
    console.error("tenant-cli: verify requires --slug <slug>");
    process.exit(1);
  }

  const envHints = {
    globalOpenaiConfigured: Boolean(String(process.env.OPENAI_API_KEY || "").trim()),
    openaiBootOptional: process.env.OPENAI_BOOT_OPTIONAL === "1",
  };
  const v = await verifyTenantForAdmin(prisma, slug, undefined, envHints);
  if (!v.ok) {
    console.error(`tenant-cli: no tenant for slug/id "${slug}"`);
    process.exit(1);
  }

  const t = v.tenant;
  console.log(`Tenant: ${t.name} (id=${t.id}, subdomain=${t.subdomain || "—"}, plan=${t.plan})`);
  console.log(`Prompts: ${t.prompts}${t.promptsPath ? " (" + t.promptsPath + ")" : ""}`);
  console.log(`OpenAI: ${t.openai}`);
  console.log(`Integration key: ${t.integrationKey}`);
  if (v.badges) {
    console.log(
      `Readiness: chat=${v.badges.chat} · integrations=${v.badges.integrations} · prompts=${v.badges.prompts}`
    );
  }
  if (t.settingsKeys.length)
    console.log("Tenant.settings keys:", t.settingsKeys.join(", "));
  else console.log("Tenant.settings: empty (OK for basic chat).");
  if (v.warnings && v.warnings.length) {
    console.log("Notes:");
    for (const w of v.warnings) {
      console.log(`  [${w.severity}] ${w.message}`);
    }
  }
  if (v.readyForChat === false) {
    console.error("tenant-cli: verify finished with chat blocked (see notes above).");
    process.exit(2);
  }
  console.log("Verify OK.");
}

async function cmdBootstrapPrompts(flags) {
  const slug = sanitizeTenantSlug(flags.slug);
  if (!slug) {
    console.error("tenant-cli: bootstrap-prompts requires --slug <slug>");
    process.exit(1);
  }

  const out = await bootstrapPromptsForTenant(prisma, slug);
  if (!out.ok) {
    console.error(`tenant-cli: ${out.error === "tenant_not_found" ? "no tenant — run create first." : out.error}`);
    process.exit(1);
  }

  for (const f of out.files) {
    console.log(`${f.status}: prompts/tenants/${out.tenantId}/${f.file}`);
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const { flags } = parseArgs(rest);

  if (!command || flags.help || flags.h) {
    usage();
    process.exit(command ? 0 : 1);
  }

  try {
    switch (command) {
      case "help":
        usage();
        process.exit(0);
        break;
      case "create":
        await cmdCreate(flags);
        break;
      case "list":
        await cmdList();
        break;
      case "verify":
        await cmdVerify(flags);
        break;
      case "bootstrap-prompts":
        await cmdBootstrapPrompts(flags);
        break;
      default:
        console.error("Unknown command:", command);
        usage();
        process.exit(1);
    }
  } catch (e) {
    console.error("tenant-cli error:", e.message || e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
