const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreLead } = require("../../utils/leadScoring");

test("scoreLead returns qualified for high-intent contact", () => {
  const out = scoreLead({
    message: "I need a remodel quote this week",
    source: "contact",
    hasEmail: true,
    hasPhone: true,
    tags: ["budget", "kitchen"],
  });
  assert.equal(out.status, "qualified");
  assert.ok(out.score >= 75);
});

test("scoreLead returns new for weak signals", () => {
  const out = scoreLead({
    message: "hello",
    source: "chat",
    hasEmail: false,
    hasPhone: false,
    tags: [],
  });
  assert.equal(out.status, "new");
});
