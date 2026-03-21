const test = require("node:test");
const assert = require("node:assert/strict");
const { webhookSubscribesToEvent, EventType } = require("../../integrations/domain");

test("webhookSubscribesToEvent: empty / missing = all", () => {
  assert.equal(webhookSubscribesToEvent(undefined, EventType.LEAD_CREATED), true);
  assert.equal(webhookSubscribesToEvent(null, EventType.CAMPAIGN_LAUNCHED), true);
  assert.equal(webhookSubscribesToEvent([], EventType.LEAD_CREATED), true);
});

test("webhookSubscribesToEvent: * = all", () => {
  assert.equal(webhookSubscribesToEvent(["*"], "anything.emit"), true);
});

test("webhookSubscribesToEvent: listed types only", () => {
  assert.equal(webhookSubscribesToEvent(["lead.created"], EventType.LEAD_CREATED), true);
  assert.equal(webhookSubscribesToEvent(["lead.created"], EventType.CAMPAIGN_LAUNCHED), false);
});
