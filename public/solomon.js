(() => {
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
  const fromStore = localStorage.getItem('tenant') || '';
  const TENANT = fromUrl || fromStore || '';
  if (TENANT && !fromUrl) {
    qs.set('tenant', TENANT);
    history.replaceState(null, '', location.pathname + '?' + qs.toString());
  }
  if (TENANT) localStorage.setItem('tenant', TENANT);

  async function sendMessage(text) {
    const u = new URL('/message', location.origin);
    if (TENANT) u.searchParams.set('tenant', TENANT);
    const res = await fetch(u.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(TENANT ? { 'X-Tenant': TENANT } : {})
      },
      body: JSON.stringify({ message: text })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const $ = (id) => document.getElementById(id);
  const box    = $('chat-box');
  const scroll = $('canvas-scroll');
  const form   = $('chat-form');
  const input  = $('user-input');
  const typing = $('typing');
  const intro  = $('intro-card');

  function dismissIntro() {
    if (intro && !intro.hidden) {
      intro.hidden = true;
      intro.setAttribute('aria-hidden', 'true');
    }
  }

  function scrollCanvasToEnd() {
    if (!scroll) return;
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
    });
  }

  function addBubble(text, who) {
    if (who !== 'user') dismissIntro();
    const div = document.createElement('div');
    div.className = 'message ' + (who === 'user' ? 'user' : 'bot') + ' is-entering';
    div.textContent = text;
    div.addEventListener('animationend', () => div.classList.remove('is-entering'), { once: true });
    box.appendChild(div);
    scrollCanvasToEnd();
  }

  document.querySelectorAll('.intro-pill[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-prompt') || '';
      if (p) input.value = p;
      input.focus();
      if (typeof input.setSelectionRange === 'function') {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = (input.value || '').trim();
    if (!text) return;

    addBubble(text, 'user');
    input.value = '';
    typing.style.display = 'block';
    scrollCanvasToEnd();

    try {
      const data = await sendMessage(text);
      typing.style.display = 'none';
      addBubble(data.reply || 'No reply received.', 'bot');
    } catch (err) {
      typing.style.display = 'none';
      console.error('Send failed:', err);
      addBubble('⚠️ Network error. Please try again.', 'bot');
    }
  });
})();
