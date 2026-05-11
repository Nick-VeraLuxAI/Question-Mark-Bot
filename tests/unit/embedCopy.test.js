"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPublicEmbedCopy } = require("../../utils/embedCopy");

test("client profile uses Assistant when seeded default tenant name is generic", () => {
  const out = buildPublicEmbedCopy({
    uiProfileEnv: "client",
    publicProductLabelEnv: "",
    tenant: { id: "default", name: "Default", settings: {} },
  });
  assert.equal(out.uiProfile, "client");
  assert.equal(out.headerTitle, "Assistant");
  assert.ok(out.starters.length >= 2);
});

test("internal profile keeps Solomon defaults", () => {
  const out = buildPublicEmbedCopy({
    uiProfileEnv: "internal",
    tenant: null,
  });
  assert.equal(out.uiProfile, "internal");
  assert.equal(out.headerTitle, "Solomon");
  assert.match(out.welcomeTitle, /Solomon/);
});

test("appearance.embed overrides welcome copy", () => {
  const out = buildPublicEmbedCopy({
    uiProfileEnv: "client",
    tenant: {
      id: "acme",
      name: "Acme Corp",
      settings: {
        appearance: {
          embed: {
            welcomeTitle: "Hi there",
            starters: [{ label: "Pricing", prompt: "Price for " }],
          },
        },
      },
    },
  });
  assert.equal(out.headerTitle, "Acme Corp");
  assert.equal(out.welcomeTitle, "Hi there");
  assert.equal(out.starters.length, 1);
  assert.equal(out.starters[0].label, "Pricing");
});
