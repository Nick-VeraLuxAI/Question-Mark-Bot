(() => {
  const THEME_KEY = "solomon_theme_user"; // '' | light | dark | auto (empty = follow tenant + system)
  const qs = new URLSearchParams(location.search);
  const envCss = document.createElement("link");
  envCss.id = "env-css";
  envCss.rel = "stylesheet";
  envCss.href =
    "/env.css" +
    (qs.get("tenant") ? "?tenant=" + encodeURIComponent(qs.get("tenant")) : "") +
    "&v=1.0.1";
  document.head.appendChild(envCss);

  const fromUrl = qs.get("tenant");
  const fromStore = localStorage.getItem("tenant") || "";
  const TENANT = fromUrl || fromStore || "";
  if (TENANT && !fromUrl) {
    qs.set("tenant", TENANT);
    history.replaceState(null, "", location.pathname + "?" + qs.toString());
  }
  if (TENANT) localStorage.setItem("tenant", TENANT);

  let tenantDefaultTheme = "auto";

  function effectiveTheme() {
    const user = localStorage.getItem(THEME_KEY);
    if (user === "light" || user === "dark") return user;
    if (tenantDefaultTheme === "light" || tenantDefaultTheme === "dark") return tenantDefaultTheme;
    return "auto";
  }

  function applyThemeToDom() {
    const mode = effectiveTheme();
    const root = document.documentElement;
    if (mode === "light") root.setAttribute("data-theme", "light");
    else if (mode === "dark") root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
  }

  function themeToggleLabel(mode) {
    if (mode === "light") return { glyph: "☀", title: "Light theme (click for dark)" };
    if (mode === "dark") return { glyph: "☾", title: "Dark theme (click for system)" };
    return { glyph: "◐", title: "Match system (click for light)" };
  }

  function refreshThemeToggle(btn) {
    if (!btn) return;
    const { glyph, title } = themeToggleLabel(effectiveTheme());
    btn.textContent = glyph;
    btn.title = title;
  }

  function applyEmbedCopy(data) {
    if (!data || typeof data !== "object") return;
    if (data.headerTitle) {
      const ht = document.getElementById("header-title");
      if (ht) ht.textContent = data.headerTitle;
      document.title = data.headerTitle + " · Chat";
    }
    const wt = document.getElementById("welcome-title");
    if (wt && data.welcomeTitle) wt.textContent = data.welcomeTitle;
    const ws = document.getElementById("welcome-subtitle");
    if (ws && data.welcomeSubtitle) ws.textContent = data.welcomeSubtitle;
    const actions = document.getElementById("intro-actions");
    if (!actions || !Array.isArray(data.starters)) return;
    actions.innerHTML = "";
    data.starters.forEach((s) => {
      if (!s || typeof s !== "object") return;
      const label = String(s.label || "").trim();
      if (!label) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "intro-pill";
      btn.setAttribute("data-prompt", s.prompt == null ? "" : String(s.prompt));
      btn.textContent = label;
      actions.appendChild(btn);
    });
  }

  (async function loadEmbedConfig() {
    try {
      const u = new URL("/api/public/embed-config", location.origin);
      if (TENANT) u.searchParams.set("tenant", TENANT);
      const res = await fetch(u.toString(), { credentials: "omit" });
      if (!res.ok) return;
      const data = await res.json();
      if (data && (data.theme === "light" || data.theme === "dark" || data.theme === "auto")) {
        tenantDefaultTheme = data.theme;
      }
      applyEmbedCopy(data);
    } catch (_) {}
    applyThemeToDom();
    refreshThemeToggle(document.getElementById("theme-toggle"));
  })();

  async function sendMessage(text) {
    const u = new URL("/message", location.origin);
    if (TENANT) u.searchParams.set("tenant", TENANT);
    const res = await fetch(u.toString(), {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(TENANT ? { "X-Tenant": TENANT } : {}),
      },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  const $ = (id) => document.getElementById(id);
  const box = $("chat-box");
  const scroll = $("canvas-scroll");
  const form = $("chat-form");
  const input = $("user-input");
  const typing = $("typing");
  const intro = $("intro-card");
  const themeBtn = $("theme-toggle");

  const introActions = $("intro-actions");
  if (introActions && input) {
    introActions.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest("button.intro-pill");
      if (!btn || !introActions.contains(btn)) return;
      const p = btn.getAttribute("data-prompt") || "";
      if (p) input.value = p;
      input.focus();
      if (typeof input.setSelectionRange === "function") {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    });
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const u = localStorage.getItem(THEME_KEY);
      if (u === "light") localStorage.setItem(THEME_KEY, "dark");
      else if (u === "dark") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, "light");
      applyThemeToDom();
      refreshThemeToggle(themeBtn);
    });
  }

  function dismissIntro() {
    if (intro && !intro.hidden) {
      intro.hidden = true;
      intro.setAttribute("aria-hidden", "true");
    }
  }

  function scrollCanvasToEnd() {
    if (!scroll) return;
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
    });
  }

  function addBubble(text, who) {
    if (who !== "user") dismissIntro();
    const div = document.createElement("div");
    div.className = "message " + (who === "user" ? "user" : "bot") + " is-entering";
    div.textContent = text;
    div.addEventListener("animationend", () => div.classList.remove("is-entering"), { once: true });
    box.appendChild(div);
    scrollCanvasToEnd();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = (input.value || "").trim();
    if (!text) return;

    addBubble(text, "user");
    input.value = "";
    typing.style.display = "block";
    scrollCanvasToEnd();

    try {
      const data = await sendMessage(text);
      typing.style.display = "none";
      addBubble(data.reply || "No reply received.", "bot");
    } catch (err) {
      typing.style.display = "none";
      console.error("Send failed:", err);
      addBubble("⚠️ Network error. Please try again.", "bot");
    }
  });
})();
