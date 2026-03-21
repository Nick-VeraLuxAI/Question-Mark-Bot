const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseModel } = require("../../utils/modelPolicy");

test("chooseModel uses default model", () => {
  const tenant = { settings: { modelPolicy: { defaultModel: "gpt-4o-mini" } }, plan: "basic" };
  assert.equal(chooseModel(tenant, "short"), "gpt-4o-mini");
});

test("chooseModel upgrades long enterprise prompts", () => {
  const tenant = { settings: { modelPolicy: { defaultModel: "gpt-4o-mini", premiumModel: "gpt-4o" } }, plan: "enterprise" };
  assert.equal(chooseModel(tenant, "x".repeat(2000)), "gpt-4o");
});
