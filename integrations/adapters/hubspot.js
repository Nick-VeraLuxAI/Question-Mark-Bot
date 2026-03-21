const { EventType } = require("../domain");

/**
 * Maps common HubSpot contact / form shapes into canonical profile/context.
 * Extend fieldMap via tenant.settings.integrations.hubspot.fieldMap
 */
function normalize(body, settings = {}) {
  const map = settings?.integrations?.hubspot?.fieldMap || {};
  const props =
    (body && body.properties) ||
    (body && body.contact && body.contact.properties) ||
    body ||
    {};

  const get = (key, ...aliases) => {
    if (map[key] && props[map[key]] != null) return props[map[key]];
    for (const a of [key, ...aliases]) {
      if (props[a] != null) return props[a];
    }
    return undefined;
  };

  const profile = {
    email: get("email", "email_address"),
    firstName: get("firstName", "firstname", "first_name"),
    lastName: get("lastName", "lastname", "last_name"),
    phone: get("phone", "phone_number", "mobilephone"),
    company: get("company", "company_name"),
    externalId: get("hs_object_id", "id"),
  };

  const cleaned = Object.fromEntries(
    Object.entries(profile).filter(([, v]) => v !== undefined && v !== "")
  );

  return {
    type: EventType.PROFILE_UPDATED,
    payload: { profile: cleaned, source: "hubspot", rawProperties: props },
    provider: "hubspot",
  };
}

module.exports = { normalize };
