(function () {
  const $ = (id) => document.getElementById(id);
  const tenantInput = $("tenant-slug");
  const authBanner = $("auth-banner");
  const statsGrid = $("stats-grid");
  const configLine = $("config-line");
  const whEvents = $("wh-events");
  const whTbody = $("wh-tbody");
  const brandingStatus = $("branding-status");

  const TENANT_KEY = "solomon_dashboard_tenant";
  const TOKEN_KEY = "solomon_dashboard_bearer";

  let csrfToken = null;

  function tenantSlug() {
    const q = new URLSearchParams(location.search).get("tenant");
    const fromInput = (tenantInput.value || "").trim();
    return fromInput || q || localStorage.getItem(TENANT_KEY) || "default";
  }

  function authHeaders() {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return { Authorization: "Bearer " + t.trim() };
    return {};
  }

  async function ensureCsrf() {
    if (localStorage.getItem(TOKEN_KEY)) {
      csrfToken = null;
      return;
    }
    const slug = tenantSlug();
    const url =
      "/api/security/csrf-token?tenant=" + encodeURIComponent(slug);
    const res = await fetch(url, { credentials: "include", headers: { ...authHeaders() } });
    if (!res.ok) {
      csrfToken = null;
      return;
    }
    try {
      const b = await res.json();
      csrfToken = b.csrfToken || null;
    } catch {
      csrfToken = null;
    }
  }

  async function api(path, opts = {}) {
    const method = String(opts.method || "GET").toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      await ensureCsrf();
    }
    const slug = tenantSlug();
    const url = path + (path.includes("?") ? "&" : "?") + "tenant=" + encodeURIComponent(slug);
    const headers = {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...opts.headers,
    };
    if (csrfToken && !localStorage.getItem(TOKEN_KEY)) {
      headers["X-CSRF-Token"] = csrfToken;
    }
    const res = await fetch(url, {
      credentials: "include",
      headers,
      ...opts,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  }

  function showAuth(msg, isError) {
    authBanner.hidden = false;
    authBanner.textContent = msg;
    authBanner.className = "banner" + (isError ? " error" : "");
  }

  function hideAuth() {
    authBanner.hidden = true;
  }

  async function loadStatsAndConfig() {
    hideAuth();
    const [st, cfg] = await Promise.all([api("/api/stats"), api("/api/config")]);
    if (st.status === 401 || cfg.status === 401) {
      showAuth(
        "Not signed in. Open your platform portal, launch Solomon (SSO), or save a Bearer token under Developer below.",
        true
      );
      statsGrid.innerHTML = "";
      configLine.textContent = "";
      return;
    }
    if (!st.ok) {
      showAuth("Stats failed: " + (st.body?.error || st.status), true);
      return;
    }
    if (!cfg.ok) {
      showAuth("Config failed: " + (cfg.body?.error || cfg.status), true);
    }
    const s = st.body;
    statsGrid.innerHTML = [
      ["Conversations", s.conversations],
      ["Leads", s.leads],
      ["Messages", s.messages],
      ["API calls (30d)", s.usage30d?.requests ?? "—"],
      ["Tokens in (30d)", s.usage30d?.promptTokens ?? "—"],
      ["Cost (30d)", s.usage30d?.cost != null ? "$" + Number(s.usage30d.cost).toFixed(4) : "—"],
    ]
      .map(
        ([lbl, val]) =>
          `<div class="stat"><div class="val">${val}</div><div class="lbl">${lbl}</div></div>`
      )
      .join("");
    const c = cfg.ok ? cfg.body : null;
    configLine.textContent = c
      ? `${c.name || ""} · subdomain ${c.subdomain || "—"} · OpenAI ${c.hasOpenAIKey ? "on" : "off"} · SMTP ${c.hasSmtpConfig ? "on" : "off"}`
      : "";
  }

  let eventTypes = [];

  async function loadWebhookMeta() {
    const { ok, body } = await api("/api/integrations/webhooks/meta");
    if (!ok || !body?.eventTypes) return;
    eventTypes = body.eventTypes;
    whEvents.innerHTML = eventTypes
      .map(
        (ev) =>
          `<label><input type="checkbox" name="ev" value="${ev.replace(/"/g, "&quot;")}" /> ${ev}</label>`
      )
      .join("");
  }

  async function loadWebhooks() {
    const { ok, status, body } = await api("/api/integrations/webhooks");
    if (status === 401) return;
    if (!ok) {
      whTbody.innerHTML = `<tr><td colspan="4" class="muted">Could not load webhooks (${body?.error || status})</td></tr>`;
      return;
    }
    const rows = body.webhooks || [];
    if (!rows.length) {
      whTbody.innerHTML = `<tr><td colspan="4" class="muted">No webhooks yet.</td></tr>`;
      return;
    }
    whTbody.innerHTML = rows
      .map((w) => {
        const ev =
          !w.events || !w.events.length ? "<em>all</em>" : w.events.map((e) => `<span class="mono">${e}</span>`).join(", ");
        return `<tr>
          <td class="mono">${w.endpoint}</td>
          <td>${w.enabled ? "yes" : "no"}</td>
          <td>${ev}</td>
          <td><button type="button" class="danger" data-del="${w.id}">Remove</button></td>
        </tr>`;
      })
      .join("");
    whTbody.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this webhook?")) return;
        const id = btn.getAttribute("data-del");
        const r = await api("/api/integrations/webhooks/" + id, { method: "DELETE" });
        if (!r.ok && r.status !== 204) alert(r.body?.error || r.status);
        loadWebhooks();
      });
    });
  }

  function val(id) {
    const el = $(id);
    return el ? el.value.trim() : "";
  }

  function setBrandingField(id, v) {
    const el = $(id);
    if (el) el.value = v == null || v === "" ? "" : String(v);
  }

  async function loadBranding() {
    if (!brandingStatus) return;
    brandingStatus.textContent = "";
    const { ok, status, body } = await api("/api/integrations/branding");
    if (status === 401) return;
    if (!ok) {
      brandingStatus.textContent = "Could not load branding: " + (body?.error || status);
      return;
    }
    const ap = body.appearance || {};
    const th = $("br-theme");
    if (th) th.value = ap.theme === "light" || ap.theme === "dark" ? ap.theme : "auto";
    setBrandingField("br-brand", body.brandColor);
    setBrandingField("br-brand-hover", body.brandHover);
    setBrandingField("br-bot-bg", body.botBg);
    setBrandingField("br-bot-text", body.botText);
    setBrandingField("br-user-bg", body.userBg);
    setBrandingField("br-user-text", body.userText);
    setBrandingField("br-glass-bg", body.glassBg);
    setBrandingField("br-glass-top", body.glassTop);
    setBrandingField("br-blur", body.blurPx);
    setBrandingField("br-font", body.fontFamily);
    setBrandingField("br-watermark", body.watermarkUrl);
    setBrandingField("br-header-glow", body.headerGlow);
  }

  async function saveBranding() {
    if (!brandingStatus) return;
    const themeEl = $("br-theme");
    const payload = {
      appearance: { theme: (themeEl && themeEl.value) || "auto" },
    };
    const pairs = [
      ["br-brand", "brandColor"],
      ["br-brand-hover", "brandHover"],
      ["br-bot-bg", "botBg"],
      ["br-bot-text", "botText"],
      ["br-user-bg", "userBg"],
      ["br-user-text", "userText"],
      ["br-glass-bg", "glassBg"],
      ["br-glass-top", "glassTop"],
      ["br-blur", "blurPx"],
      ["br-font", "fontFamily"],
      ["br-watermark", "watermarkUrl"],
      ["br-header-glow", "headerGlow"],
    ];
    for (const [id, key] of pairs) {
      const s = val(id);
      if (s) payload[key] = s;
    }
    const r = await api("/api/integrations/branding", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      brandingStatus.textContent = "Save failed: " + (r.body?.error || r.status);
      return;
    }
    brandingStatus.textContent = "Saved. Embed clients may take up to ~1 minute to pick up theme (CDN/browser cache).";
  }

  function selectedEvents() {
    const boxes = whEvents.querySelectorAll('input[name="ev"]:checked');
    return Array.from(boxes).map((b) => b.value);
  }

  async function addWebhook() {
    const endpoint = $("wh-endpoint").value.trim();
    const secret = $("wh-secret").value.trim();
    const events = selectedEvents();
    const payload = { endpoint, enabled: true, events };
    if (secret) payload.secret = secret;
    const r = await api("/api/integrations/webhooks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      alert(r.body?.error || r.status);
      return;
    }
    $("wh-endpoint").value = "";
    $("wh-secret").value = "";
    whEvents.querySelectorAll('input[name="ev"]').forEach((x) => (x.checked = false));
    loadWebhooks();
  }

  async function rotateKey() {
    const r = await api("/api/keys/rotate", { method: "POST", body: "{}" });
    const box = $("key-reveal");
    if (!r.ok) {
      box.hidden = false;
      box.textContent = "Error: " + (r.body?.error || r.status);
      return;
    }
    box.hidden = false;
    box.textContent = r.body.apiKey || "";
  }

  function init() {
    const stored = localStorage.getItem(TENANT_KEY);
    const q = new URLSearchParams(location.search).get("tenant");
    tenantInput.value = q || stored || "default";

    const tok = localStorage.getItem(TOKEN_KEY);
    if (tok) $("dev-token").value = tok;

    tenantInput.addEventListener("change", () => {
      localStorage.setItem(TENANT_KEY, tenantInput.value.trim() || "default");
      loadAll();
    });

    $("btn-reload").addEventListener("click", loadAll);
    $("btn-rotate-key").addEventListener("click", rotateKey);
    $("btn-add-webhook").addEventListener("click", addWebhook);
    const btnBr = $("btn-save-branding");
    if (btnBr) btnBr.addEventListener("click", saveBranding);
    $("btn-save-token").addEventListener("click", () => {
      const v = $("dev-token").value.trim();
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
      loadAll();
    });
    $("btn-clear-token").addEventListener("click", () => {
      localStorage.removeItem(TOKEN_KEY);
      $("dev-token").value = "";
      loadAll();
    });

    loadAll();
  }

  function loadAll() {
    loadStatsAndConfig();
    loadBranding();
    loadWebhookMeta().then(loadWebhooks);
  }

  init();
})();
