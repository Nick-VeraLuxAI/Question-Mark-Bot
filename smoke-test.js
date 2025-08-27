// smoke-test.js
const fetch = require("node-fetch"); // npm install node-fetch@2 if not already
const BASE = "http://localhost:3000/api/portal/log?tenant=test";

async function post(type, body) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...body })
  });
  const data = await res.json();
  console.log(`POST ${type}:`, data);
}

(async () => {
  try {
    await post("event", { role: "sys", message: "🚀 Smoke test event fired" });
    await post("error", { user: "tester", message: "Simulated error" });
    await post("usage", {
      usage: {
        model: "gpt-test",
        prompt_tokens: 123,
        completion_tokens: 456,
        cached_tokens: 0,
        user: "tester",
        costUSD: 0.000987
      }
    });
    await post("metric", { metricType: "latency", value: 123 });
    await post("metric", { metricType: "success", value: 1 });
    await post("conversation", {
      sessionId: "sess-001",
      data: {
        messages: [
          { role: "user", content: "Hello!", at: Date.now() },
          { role: "ai", content: "Hi, test reply here.", at: Date.now() }
        ]
      }
    });
    console.log("✅ Smoke test complete. Open /portal?tenant=test to view.");
  } catch (err) {
    console.error("❌ Smoke test failed:", err);
  }
})();
