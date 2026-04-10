// smoke-readiness.js
// Lightweight post-deploy checks for health/readiness and key guardrails.

const BASE_URL = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const TENANT = process.env.SMOKE_TENANT || '';
/** Skip POST /message (avoids OpenAI usage on every ./scripts/start.sh). */
const SMOKE_LITE = process.env.SMOKE_LITE === '1';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'GET' });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { res, data, text };
}

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { res, data, text };
}

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable. Use Node 18+ for this smoke test.');
  }

  console.log(`Smoke target: ${BASE_URL}`);

  // 1) Liveness
  const health = await getJson('/api/health');
  assert(health.res.status === 200, `health status expected 200, got ${health.res.status}`);
  assert(health.data?.status === 'ok', `health payload invalid: ${health.text}`);
  console.log('OK  /api/health');

  // 2) Readiness (DB reachable)
  const ready = await getJson('/api/ready');
  assert(ready.res.status === 200, `ready status expected 200, got ${ready.res.status}`);
  assert(ready.data?.status === 'ready', `ready payload invalid: ${ready.text}`);
  console.log('OK  /api/ready');

  // 3) Rate limiting smoke for /message
  // Requires a valid tenant in DB if you want this check enforced.
  if (SMOKE_LITE) {
    console.log('SKIP /message (SMOKE_LITE=1 — set SMOKE_LITE=0 and SMOKE_TENANT for a live OpenAI chat check)');
  } else if (TENANT) {
    const path = `/message?tenant=${encodeURIComponent(TENANT)}`;
    const first = await postJson(path, { message: 'smoke test', source: 'contact' });
    assert(first.res.status !== 500, `unexpected 500 from /message: ${first.text}`);
    if (first.res.status === 200) {
      assert(typeof first.data?.reply === "string" && first.data.reply.length > 0, "message response missing reply");
    }
    console.log(`OK  /message first response (${first.res.status})`);
  } else {
    console.log('SKIP /message check (set SMOKE_TENANT to enable)');
  }

  console.log('All smoke checks passed.');
}

main().catch((err) => {
  console.error(`Smoke check failed: ${err.message}`);
  process.exit(1);
});
