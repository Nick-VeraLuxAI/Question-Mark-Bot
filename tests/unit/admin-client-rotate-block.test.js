const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("client portal: resolveApiPath returns null for /api/keys/rotate so api() never fetches", () => {
  const p = path.join(__dirname, "..", "..", "public", "admin", "admin.js");
  const src = fs.readFileSync(p, "utf8");
  assert.ok(src.includes("function resolveApiPath("), "resolveApiPath present");
  assert.ok(
    src.includes("if (/^\\/api\\/keys\\/rotate$/.test(pathOnly)) return null"),
    "rotate path blocked in client mode"
  );
  assert.ok(
    src.includes("if (realPath === null)") && src.includes("operator_action_not_available"),
    "api() short-circuits when resolveApiPath is null"
  );
});
