const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPromptBundle } = require("../../utils/promptManager");

test("loadPromptBundle falls back when no active versions", async () => {
  const prisma = {
    promptVersion: { findMany: async () => [] },
  };
  const bundle = await loadPromptBundle(prisma, "tenant1", {
    system: "sys",
    policy: "pol",
    voice: "voi",
  });
  assert.deepEqual(bundle, { system: "sys", policy: "pol", voice: "voi" });
});
