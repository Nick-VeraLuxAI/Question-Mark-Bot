const { getRedis } = require("./redis");

function getClientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.ip || req.socket?.remoteAddress || "unknown";
}

function createDistributedRateLimiter({ windowMs, max, keyPrefix, resolveTenant }) {
  const localStore = new Map();

  return async (req, res, next) => {
    const tenant = resolveTenant(req);
    const key = `${keyPrefix}:${getClientIp(req)}:${tenant}`;
    const ttlSec = Math.max(1, Math.ceil(windowMs / 1000));
    const redis = getRedis();

    if (redis) {
      try {
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, ttlSec);
        if (count > max) {
          const ttl = await redis.ttl(key);
          res.set("Retry-After", String(Math.max(1, ttl)));
          return res.status(429).json({ error: "rate_limit_exceeded" });
        }
        return next();
      } catch (err) {
        console.warn("Rate limiter redis fallback:", err.message);
      }
    }

    // Fallback if Redis is unavailable.
    const now = Date.now();
    const current = localStore.get(key);
    if (!current || now >= current.resetAt) {
      localStore.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (current.count >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "rate_limit_exceeded" });
    }
    current.count += 1;
    return next();
  };
}

module.exports = { createDistributedRateLimiter, getClientIp };
