/**
 * Fail fast in production when required configuration is missing.
 */

function logProductionBootWarnings() {
  if (process.env.NODE_ENV !== "production") return;
  const lines = [];
  if (process.env.ALLOW_EMPTY_CORS_IN_PRODUCTION === "1") {
    lines.push("ALLOW_EMPTY_CORS_IN_PRODUCTION=1 — browser CORS may reject origins unless you rely on non-browser clients only.");
  }
  if (process.env.SKIP_KMS_MASTER_KEY === "1") {
    lines.push("SKIP_KMS_MASTER_KEY=1 — encrypted tenant fields (OAuth tokens, etc.) cannot be stored safely; use only if you accept that limitation.");
  }
  if (process.env.OPENAI_BOOT_OPTIONAL === "1") {
    lines.push("OPENAI_BOOT_OPTIONAL=1 — API will start without OPENAI_API_KEY; every tenant used for chat must have openaiKey in the database.");
  }
  if (lines.length) {
    console.warn(`[boot] Production configuration notes (escape hatches / optional modes):\n  - ${lines.join("\n  - ")}`);
  }
}

/** One-line hint when not in production (managed operators sometimes mis-set NODE_ENV). */
function logRuntimeModeHint() {
  const env = process.env.NODE_ENV || "";
  if (!env || env === "development") {
    console.info(
      "[boot] NODE_ENV is not production — strict readiness checks and some validations are relaxed. Use NODE_ENV=production for managed deployments."
    );
  }
}

function validateProductionBoot() {
  if (process.env.NODE_ENV !== "production") return;

  const missing = [];

  if (!String(process.env.DATABASE_URL || "").trim()) {
    missing.push("DATABASE_URL");
  }

  if (!String(process.env.REDIS_URL || "").trim()) {
    missing.push("REDIS_URL");
  }

  const openai = String(process.env.OPENAI_API_KEY || "").trim();
  if (!openai && process.env.OPENAI_BOOT_OPTIONAL !== "1") {
    missing.push(
      "OPENAI_API_KEY (or set OPENAI_BOOT_OPTIONAL=1 if every tenant has openaiKey in the database)"
    );
  }

  const kms = String(process.env.KMS_MASTER_KEY || "").trim();
  if (!kms && process.env.SKIP_KMS_MASTER_KEY !== "1") {
    missing.push(
      "KMS_MASTER_KEY (or set SKIP_KMS_MASTER_KEY=1 only if you will not use encrypted tenant secrets)"
    );
  }

  const cors = String(process.env.CORS_ORIGINS || "").trim();
  if (!cors && process.env.ALLOW_EMPTY_CORS_IN_PRODUCTION !== "1") {
    missing.push(
      "CORS_ORIGINS (comma-separated browser origins, or ALLOW_EMPTY_CORS_IN_PRODUCTION=1 — unsafe for browsers)"
    );
  }

  if (missing.length) {
    console.error(
      `[boot] Missing or invalid required env in production:\n  - ${missing.join("\n  - ")}`
    );
    process.exit(1);
  }

  console.info("[boot] Production configuration validation passed (DATABASE_URL, REDIS_URL, OpenAI/KMS/CORS rules).");
}

/** Worker process: database + Redis required in production (queues). */
function validateWorkerProductionBoot() {
  if (process.env.NODE_ENV !== "production") return;

  const missing = [];
  if (!String(process.env.DATABASE_URL || "").trim()) {
    missing.push("DATABASE_URL");
  }
  if (!String(process.env.REDIS_URL || "").trim()) {
    missing.push("REDIS_URL");
  }

  if (missing.length) {
    console.error(`[worker boot] Missing required env in production: ${missing.join(", ")}`);
    process.exit(1);
  }
}

module.exports = {
  validateProductionBoot,
  validateWorkerProductionBoot,
  logProductionBootWarnings,
  logRuntimeModeHint,
};
