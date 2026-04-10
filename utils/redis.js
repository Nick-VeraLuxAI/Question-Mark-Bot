const Redis = require("ioredis");

let client = null;
let bullmqClient = null;

function getRedis() {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  client.on("error", (err) => {
    console.warn("Redis unavailable:", err.message);
  });
  return client;
}

/**
 * Dedicated client for BullMQ. Must use maxRetriesPerRequest: null per BullMQ docs.
 * @see https://docs.bullmq.io/guide/connections
 */
function getBullmqConnection() {
  if (bullmqClient) return bullmqClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  bullmqClient = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 24) return null;
      return Math.min(times * 150, 4000);
    },
  });
  bullmqClient.on("error", (err) => {
    console.warn("[redis-bullmq]", err.message);
  });
  return bullmqClient;
}

async function quitRedisClients() {
  const tasks = [];
  if (client) {
    const c = client;
    client = null;
    tasks.push(c.quit().catch(() => c.disconnect()));
  }
  if (bullmqClient) {
    const b = bullmqClient;
    bullmqClient = null;
    tasks.push(b.quit().catch(() => b.disconnect()));
  }
  await Promise.all(tasks);
}

/**
 * Liveness for the shared rate-limit Redis client (same REDIS_URL as BullMQ).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
async function pingRedisForReadiness(timeoutMs = 2000) {
  const redisClient = getRedis();
  if (!redisClient) {
    return { ok: false, reason: "redis_not_configured" };
  }
  try {
    const pong = await Promise.race([
      redisClient.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("redis_timeout")), timeoutMs)
      ),
    ]);
    if (pong !== "PONG") {
      return { ok: false, reason: "redis_ping_unexpected" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

module.exports = { getRedis, getBullmqConnection, quitRedisClients, pingRedisForReadiness };
