const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { app } = require("../../server");

test("GET /api/health returns ok", async () => {
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("GET /auth requires platform auth", async () => {
  const res = await request(app).get("/auth");
  assert.equal(res.status, 401);
});
