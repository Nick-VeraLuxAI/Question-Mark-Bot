const { Queue } = require("bullmq");
const { getBullmqConnection } = require("./redis");

const queues = new Map();

function getQueue(name = "default") {
  if (queues.has(name)) return queues.get(name);
  const connection = getBullmqConnection();
  if (!connection) return null;
  const queue = new Queue(name, { connection });
  queues.set(name, queue);
  return queue;
}

async function enqueue(queueName, jobName, payload, opts = {}) {
  const queue = getQueue(queueName);
  if (!queue) return false;
  const addOpts = {
    attempts: opts.attempts ?? 4,
    backoff: opts.backoff ?? { type: "exponential", delay: 2000 },
    removeOnComplete: opts.removeOnComplete ?? 500,
    removeOnFail: opts.removeOnFail ?? 500,
    delay: opts.delay ?? 0,
  };
  if (opts.jobId) addOpts.jobId = opts.jobId;
  try {
    await queue.add(jobName, payload, addOpts);
    return true;
  } catch (err) {
    const msg = String(err?.message || err);
    // BullMQ rejects duplicate jobId while an instance exists — treat as already queued.
    if (/job id|already exists|duplicate/i.test(msg)) {
      console.warn("enqueue: duplicate jobId skipped", jobName, opts.jobId);
      return true;
    }
    console.error("enqueue failed:", msg);
    return false;
  }
}

async function closeAllQueues() {
  const closing = [...queues.values()].map((q) => q.close().catch(() => {}));
  await Promise.all(closing);
  queues.clear();
}

module.exports = { enqueue, getQueue, closeAllQueues };
