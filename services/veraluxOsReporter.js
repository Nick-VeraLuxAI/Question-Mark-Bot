/**
 * Push aggregate telemetry to VeraLux OS (Phase 1).
 * Never throws to caller; logs and backs off on failure.
 */

const { randomUUID } = require("crypto");

const ENABLED =
  String(process.env.VERALUX_OS_REPORTING_ENABLED || "")
    .trim()
    .toLowerCase() === "true";

const BASE_URL = (process.env.VERALUX_OS_URL || "").replace(/\/+$/, "");
const API_KEY = String(process.env.VERALUX_OS_API_KEY || "").trim();
const DEPLOYMENT_ID = String(process.env.VERALUX_DEPLOYMENT_ID || "").trim();
const PRODUCT_TYPE = String(
  process.env.VERALUX_PRODUCT_TYPE || "solomon",
).toLowerCase();
const ENVIRONMENT = String(
  process.env.VERALUX_DEPLOYMENT_ENV ||
    process.env.NODE_ENV ||
    "development",
).slice(0, 64);
const PUBLIC_URL = String(
  process.env.VERALUX_DEPLOYMENT_PUBLIC_URL || "",
).trim();

const HEARTBEAT_MS = Math.min(
  Math.max(Number(process.env.VERALUX_OS_HEARTBEAT_INTERVAL_MS || 180000), 60000),
  300000,
);
const METRICS_MS = Math.min(
  Math.max(Number(process.env.VERALUX_OS_METRICS_INTERVAL_MS || 3600000), 300000),
  86400000,
);

let heartbeatTimer = null;
let metricsTimer = null;
let consecutiveFailures = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextBackoffMs() {
  const base = 2000;
  const cap = 120000;
  const exp = Math.min(cap, base * 2 ** Math.min(consecutiveFailures, 6));
  return exp + Math.floor(Math.random() * 1000);
}

async function postJson(path, body) {
  if (!BASE_URL || !API_KEY) return { ok: false, skipped: true };
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veralux-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data, text };
}

function validateConfigOrWarn() {
  if (!ENABLED) return false;
  if (PRODUCT_TYPE !== "solomon" && PRODUCT_TYPE !== "receptionist") {
    console.warn(
      "[veralux-os-reporting] VERALUX_PRODUCT_TYPE must be solomon or receptionist; disabling.",
    );
    return false;
  }
  if (!DEPLOYMENT_ID) {
    console.warn("[veralux-os-reporting] VERALUX_DEPLOYMENT_ID missing; disabling.");
    return false;
  }
  if (!BASE_URL) {
    console.warn("[veralux-os-reporting] VERALUX_OS_URL missing; disabling.");
    return false;
  }
  if (!API_KEY) {
    console.warn("[veralux-os-reporting] VERALUX_OS_API_KEY missing; disabling.");
    return false;
  }
  return true;
}

async function fetchLocalReady() {
  const port = process.env.PORT || 8080;
  const url = `http://127.0.0.1:${port}/api/ready`;
  try {
    const res = await fetch(url, { method: "GET" });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: { error: e instanceof Error ? e.message : "fetch_failed" },
    };
  }
}

async function sendHeartbeat() {
  const ready = await fetchLocalReady();
  const readinessStatus =
    ready.ok && ready.data && ready.data.status === "ready" ? "ready" : "not_ready";
  const slim = {};
  if (ready.data && typeof ready.data === "object") {
    const d = ready.data;
    if ("status" in d) slim.status = d.status;
    if ("checks" in d) slim.checks = d.checks;
    if ("version" in d) slim.version = d.version;
    if ("hints" in d && Array.isArray(d.hints)) slim.hintCount = d.hints.length;
  }
  const body = {
    schemaVersion: "1.0",
    sourceProduct: PRODUCT_TYPE,
    deploymentId: DEPLOYMENT_ID,
    environment: ENVIRONMENT,
    eventType: "telemetry.heartbeat",
    severity: "info",
    timestamp: new Date().toISOString(),
    correlationId: randomUUID(),
    idempotencyKey: `hb:${DEPLOYMENT_ID}:${Math.floor(Date.now() / HEARTBEAT_MS)}`,
    piiLevel: "none",
    payload: {
      readinessStatus,
      checks: {
        local_ready_http: ready.status,
        ready: slim,
      },
      version:
        (ready.data && typeof ready.data.version === "string" && ready.data.version) ||
        undefined,
      publicUrl: PUBLIC_URL || undefined,
    },
  };
  const r = await postJson("/api/internal/product-telemetry/v1/heartbeat", body);
  if (!r.ok && !r.skipped) {
    consecutiveFailures += 1;
    console.warn(
      `[veralux-os-reporting] heartbeat failed status=${r.status} body=${(r.text || "").slice(0, 200)}`,
    );
    await sleep(nextBackoffMs());
  } else {
    consecutiveFailures = 0;
  }
}

async function sendMetrics(prisma) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [conversations, leads, messages, usage] = await Promise.all([
    prisma.conversation.count(),
    prisma.lead.count(),
    prisma.message.count(),
    prisma.usage.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { cost: true, promptTokens: true, completionTokens: true },
      _count: true,
    }),
  ]);

  const cost = Number(usage._sum.cost || 0);
  const pt = Number(usage._sum.promptTokens || 0);
  const ct = Number(usage._sum.completionTokens || 0);
  const rawCount = usage._count;
  const usageRows =
    typeof rawCount === "number"
      ? rawCount
      : rawCount && typeof rawCount === "object" && "_all" in rawCount
        ? Number(rawCount._all) || 0
        : 0;

  const metrics = [
    { name: "conversations_total", value: conversations, dimensions: {} },
    { name: "leads_total", value: leads, dimensions: {} },
    { name: "messages_total", value: messages, dimensions: {} },
    { name: "usage_rows_24h", value: usageRows, dimensions: {} },
    { name: "usage_cost_sum_24h", value: cost, dimensions: {} },
    { name: "usage_prompt_tokens_sum_24h", value: pt, dimensions: {} },
    { name: "usage_completion_tokens_sum_24h", value: ct, dimensions: {} },
  ];

  const body = {
    schemaVersion: "1.0",
    sourceProduct: PRODUCT_TYPE,
    deploymentId: DEPLOYMENT_ID,
    environment: ENVIRONMENT,
    eventType: "telemetry.metrics.batch",
    severity: "info",
    timestamp: new Date().toISOString(),
    correlationId: randomUUID(),
    idempotencyKey: `metrics:${DEPLOYMENT_ID}:${new Date().toISOString().slice(0, 13)}`,
    piiLevel: "none",
    payload: {
      metrics,
      publicUrl: PUBLIC_URL || undefined,
    },
  };

  const r = await postJson("/api/internal/product-telemetry/v1/metrics", body);
  if (!r.ok && !r.skipped) {
    consecutiveFailures += 1;
    console.warn(
      `[veralux-os-reporting] metrics failed status=${r.status} body=${(r.text || "").slice(0, 200)}`,
    );
    await sleep(nextBackoffMs());
  } else {
    consecutiveFailures = 0;
  }
}

function scheduleTimers(prisma) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (metricsTimer) clearInterval(metricsTimer);

  void sendHeartbeat().catch((e) =>
    console.warn("[veralux-os-reporting] initial heartbeat error:", e?.message || e),
  );

  heartbeatTimer = setInterval(() => {
    void sendHeartbeat().catch((e) =>
      console.warn("[veralux-os-reporting] heartbeat error:", e?.message || e),
    );
  }, HEARTBEAT_MS);

  metricsTimer = setInterval(() => {
    void sendMetrics(prisma).catch((e) =>
      console.warn("[veralux-os-reporting] metrics error:", e?.message || e),
    );
  }, METRICS_MS);

  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  if (typeof metricsTimer.unref === "function") metricsTimer.unref();
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 */
function startVeraluxOsReporting(prisma) {
  try {
    if (typeof fetch !== "function") {
      console.warn("[veralux-os-reporting] fetch unavailable; reporting disabled.");
      return;
    }
    if (!validateConfigOrWarn()) return;
    console.log(
      `[veralux-os-reporting] enabled deployment=${DEPLOYMENT_ID} heartbeat=${HEARTBEAT_MS}ms metrics=${METRICS_MS}ms`,
    );
    scheduleTimers(prisma);
  } catch (e) {
    console.warn("[veralux-os-reporting] failed to start:", e?.message || e);
  }
}

module.exports = { startVeraluxOsReporting };
