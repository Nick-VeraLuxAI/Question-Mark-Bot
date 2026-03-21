const Redis = require("ioredis");

let client = null;

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

module.exports = { getRedis };
