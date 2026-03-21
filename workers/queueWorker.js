const { Worker } = require("bullmq");
const { PrismaClient } = require("@prisma/client");
const axios = require("axios");
const { getRedis } = require("../utils/redis");
const { sendGenericWebhook } = require("../utils/webhook");

const prisma = new PrismaClient();

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

  if (job.name === "persist-outbox-success") {
    await prisma.outboxJob.update({
      where: { id: job.data.outboxId },
      data: { status: "completed" },
    });
  }
}

const connection = getRedis();
if (connection) {
  new Worker("events", processJob, { connection });
}
