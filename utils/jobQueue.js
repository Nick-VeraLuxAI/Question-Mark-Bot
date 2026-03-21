const { Queue } = require("bullmq");
const { getRedis } = require("./redis");

const queues = new Map();

function getQueue(name = "default") {
  if (queues.has(name)) return queues.get(name);
  const connection = getRedis();
  if (!connection) return null;
  const queue = new Queue(name, { connection });
  queues.set(name, queue);
  return queue;
}

async function enqueue(queueName, jobName, payload, opts = {}) {
  const queue = getQueue(queueName);
  if (!queue) return false;
  await queue.add(jobName, payload, {
    attempts: opts.attempts ?? 4,
    backoff: opts.backoff ?? { type: "exponential", delay: 2000 },
    removeOnComplete: opts.removeOnComplete ?? 500,
    removeOnFail: opts.removeOnFail ?? 500,
    delay: opts.delay ?? 0,
  });
  return true;
}

module.exports = { enqueue, getQueue };
