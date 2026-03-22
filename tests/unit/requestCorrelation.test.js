const test = require("node:test");
const assert = require("node:assert/strict");
const { requestCorrelationMiddleware } = require("../../middleware/requestCorrelation");

test("requestCorrelation sets X-Request-Id and req.requestId", (t, done) => {
  const req = { get: () => "" };
  const headers = {};
  const res = { setHeader(k, v) { headers[k] = v; } };
  requestCorrelationMiddleware(req, res, () => {
    assert.ok(typeof req.requestId === "string" && req.requestId.length > 8);
    assert.equal(headers["X-Request-Id"], req.requestId);
    done();
  });
});

test("requestCorrelation honors incoming X-Request-Id when safe", (t, done) => {
  const req = { get: (h) => (h === "x-request-id" ? "trace-abc-123" : "") };
  const res = { setHeader() {} };
  requestCorrelationMiddleware(req, res, () => {
    assert.equal(req.requestId, "trace-abc-123");
    done();
  });
});
