const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { app } = require("../../server");

test("GET /api/health returns ok", async () => {
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("GET /healthz returns minimal liveness JSON", async () => {
  const res = await request(app).get("/healthz");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, "solomon");
  assert.match(res.body.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(typeof res.body.version === "string" && res.body.version.length > 0);
});

test("GET /auth requires platform auth", async () => {
  const res = await request(app).get("/auth");
  assert.equal(res.status, 401);
});
