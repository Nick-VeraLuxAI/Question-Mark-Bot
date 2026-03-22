/**
 * Fail fast in production when required configuration is missing.
 */
function validateProductionBoot() {
  if (process.env.NODE_ENV !== "production") return;

  const missing = [];
  if (!String(process.env.DATABASE_URL || "").trim()) {
    missing.push("DATABASE_URL");
  }

  if (missing.length) {
    console.error(`[boot] Missing required env in production: ${missing.join(", ")}`);
    process.exit(1);
  }

  if (!String(process.env.REDIS_URL || "").trim()) {
    console.warn(
      "[boot] REDIS_URL is not set: BullMQ queues are disabled; lead notification emails use a single in-process send attempt."
    );
  }
}

module.exports = { validateProductionBoot };
