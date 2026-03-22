const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const sharedEnv = {
  NODE_ENV: "production",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  LEAD_EMAIL_USER: process.env.LEAD_EMAIL_USER,
  LEAD_EMAIL_PASS: process.env.LEAD_EMAIL_PASS,
  LEAD_EMAIL_TO: process.env.LEAD_EMAIL_TO,
  TENANT: process.env.TENANT,
  ADMIN_KEY: process.env.ADMIN_KEY,
  BRAND_COLOR: process.env.BRAND_COLOR,
  BRAND_HOVER: process.env.BRAND_HOVER,
  BOT_BG: process.env.BOT_BG,
  BOT_TEXT: process.env.BOT_TEXT,
  USER_BG: process.env.USER_BG,
  USER_TEXT: process.env.USER_TEXT,
};

module.exports = {
  apps: [
    {
      name: "solomon",
      script: "server.js",
      cwd: __dirname,
      watch: false,
      env: {
        ...sharedEnv,
        PORT: process.env.PORT || 10000,
      },
    },
    {
      name: "solomon-worker",
      script: "workers/queueWorker.js",
      cwd: __dirname,
      watch: false,
      env: {
        ...sharedEnv,
        WORKER_HEALTH_PORT: process.env.WORKER_HEALTH_PORT || "",
        EVENTS_WORKER_CONCURRENCY: process.env.EVENTS_WORKER_CONCURRENCY || "",
        EVENTS_WORKER_LOCK_MS: process.env.EVENTS_WORKER_LOCK_MS || "",
      },
    },
  ],
};
