const test = require("node:test");
const assert = require("node:assert/strict");
const { hasPermission } = require("../../middleware/rbac");

test("tenants:provision allowed for operator", () => {
  assert.equal(hasPermission("operator", "tenants:provision"), true);
});

test("tenants:provision denied for viewer", () => {
  assert.equal(hasPermission("viewer", "tenants:provision"), false);
});

test("tenants:provision denied for analyst", () => {
  assert.equal(hasPermission("analyst", "tenants:provision"), false);
});

test("owner has tenants:provision via full admin", () => {
  assert.equal(hasPermission("owner", "tenants:provision"), true);
});
