const test = require("node:test");
const assert = require("node:assert/strict");
const { hasPermission, hasClientTenantPermission, resolveTenantScopedRole } = require("../../middleware/rbac");

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

test("client tenant role: operator never gets tenants:provision", () => {
  assert.equal(hasClientTenantPermission("operator", "tenants:provision"), false);
  assert.equal(hasClientTenantPermission("operator", "config:write"), true);
});

test("client tenant role: owner gets config write but not provision check passes write", () => {
  assert.equal(hasClientTenantPermission("owner", "config:write"), true);
  assert.equal(hasClientTenantPermission("owner", "tenants:provision"), false);
});

test("resolveTenantScopedRole prefers effective tenant role over platform role", () => {
  const req = {
    platformUser: { role: "viewer" },
    effectiveTenantRole: "operator",
  };
  assert.equal(resolveTenantScopedRole(req), "operator");
});

test("resolveTenantScopedRole falls back to platform role", () => {
  const req = { platformUser: { role: "admin" } };
  assert.equal(resolveTenantScopedRole(req), "admin");
});
