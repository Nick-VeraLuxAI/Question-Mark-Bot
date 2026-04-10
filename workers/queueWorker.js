const http = require("http");
const { Worker } = require("bullmq");
const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const { getBullmqConnection, quitRedisClients } = require("../utils/redis");
const { sendGenericWebhook } = require("../utils/webhook");
const { sendLeadNotificationMail } = require("../services/leadEmailDelivery");
const { TENANT_EMAIL_SELECT } = require("../services/leadEmailQueue");
const { materializeTenantSecrets } = require("../utils/tenantSecrets");
const { writeSystemAudit } = require("../utils/audit");
const {
  assertLeadEligibleForNotificationEmail,
  markLeadNotificationEmailSent,
} = require("../services/leadEmailIdempotency");
const {
  logEvent,
  logSuccess,
  logError,
} = require("../adminClient");
const {
  validateWorkerProductionBoot,
  logProductionBootWarnings,
  logRuntimeModeHint,
} = require("../utils/bootValidate");

if (process.env.NODE_ENV !== "production") {
  logRuntimeModeHint();
}
validateWorkerProductionBoot();
logProductionBootWarnings();

const prisma = new PrismaClient();

const WORKER_CONCURRENCY = Math.max(1, Number(process.env.EVENTS_WORKER_CONCURRENCY || 5));
const LOCK_MS = Math.max(30_000, Number(process.env.EVENTS_WORKER_LOCK_MS || 120_000));

async function processJob(job) {
  if (job.name === "admin-log") {
    const { url, body, headers } = job.data;
    await axios.post(url, body, { headers, timeout: 5000 });
    return;
  }

  if (job.name === "integration-webhook") {
    const { endpoint, secret, body } = job.data;
    await sendGenericWebhook(String(endpoint), body, String(secret || ""));
    return;
  }

  if (job.name === "lead-webhook") {
    const { endpoint, payload, secret } = job.data;
    await sendGenericWebhook(String(endpoint), payload, String(secret || ""));
    return;
  }

  if (job.name === "lead-notification-email") {
    const { tenantId, leadId, name, email, phone, tags, text } = job.data;

    const gate = await assertLeadEligibleForNotificationEmail(prisma, leadId, tenantId);
    if (!gate.ok) {
      throw new Error(gate.error || "lead_email_gate_failed");
    }
    if (gate.skip) {
      return;
    }

    const row = await prisma.tenant.findFirst({
      where: { id: tenantId },
      select: TENANT_EMAIL_SELECT,
    });
    if (!row) {
      throw new Error("tenant_not_found_for_lead_email");
    }
    const tenant = materializeTenantSecrets(row);
    const result = await sendLeadNotificationMail(tenant, {
      name,
      email,
      phone,
      tags,
      text,
      tenantName: row.name,
    });
    if (result.skipped) return;
    if (!result.ok) {
      throw new Error(result.error || "lead_email_send_failed");
    }
    await markLeadNotificationEmailSent(prisma, leadId);
    console.log("Lead notification email sent (queued):", result.response);
    await Promise.all([
      logSuccess(tenantId).catch(() => {}),
      logEvent("server", `Captured new lead: ${name}, ${email}, ${phone}`, tenantId).catch(() => {}),
      logEvent("ai", "AI replied with: consultation confirmation", tenantId).catch(() => {}),
    ]);
    return;
  }

  if (job.name === "persist-outbox-success") {
    await prisma.outboxJob.update({
      where: { id: job.data.outboxId },
      data: { status: "completed" },
    });
  }
}

const connection = getBullmqConnection();
let worker = null;
let healthServer = null;

if (!connection) {
  console.error("queue worker: REDIS_URL is not set; cannot run BullMQ worker.");
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
  process.exit(0);
}

worker = new Worker("events", processJob, {
  connection,
  concurrency: WORKER_CONCURRENCY,
  lockDuration: LOCK_MS,
  stalledInterval: Math.min(60_000, LOCK_MS),
  maxStalledCount: 2,
});

worker.on("failed", (job, err) => {
  if (job?.name !== "lead-notification-email") return;
  // Intermediate retries also emit `failed`; only audit after permanent failure (finishedOn set).
  if (!job.finishedOn) return;
  const tid = job.data?.tenantId;
  if (!tid) return;
  const msg = err?.message || String(err);
  console.error("lead-notification-email job failed permanently:", msg);
  logError("Email", `Lead email failed after retries: ${msg}`, tid).catch(() => {});
  writeSystemAudit(prisma, tid, {
    action: "lead.email.failed",
    resource: "lead_notification",
    resourceId: job.data?.leadId || undefined,
    outcome: "fail",
    details: {
      error: msg,
      attemptsMade: job.attemptsMade,
    },
  });
});

worker.on("error", (err) => {
  console.error("events worker error:", err?.message || err);
});

const healthPort = Number(process.env.WORKER_HEALTH_PORT || 0);
if (healthPort > 0) {
  healthServer = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", role: "events-worker", queue: "events" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  healthServer.listen(healthPort, "0.0.0.0", () => {
    console.log(`events worker health on :${healthPort} (/health, /ready)`);
  });
}

async function shutdown(signal) {
  console.log(`events worker ${signal}: closing…`);
  try {
    await worker?.close();
  } catch (e) {
    console.warn("worker.close:", e?.message);
  }
  try {
    await prisma.$disconnect();
  } catch (e) {
    console.warn("prisma disconnect:", e?.message);
  }
  if (healthServer) {
    await new Promise((resolve) => healthServer.close(() => resolve()));
  }
  await quitRedisClients();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
