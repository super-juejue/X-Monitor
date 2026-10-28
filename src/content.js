/**
 * Isolated-world content script.
 *
 * 1. Relays captured GraphQL payloads from the page hook to the worker.
 * 2. Reads the logged-in handle/name/avatar off the page chrome, which is the
 *    one thing the payloads do not reliably tell us on every page.
 */
(() => {
  'use strict';

  const host = location.hostname.replace(/^www\./, '');
  if (host !== 'x.com' && host !== 'twitter.com') return;

  const send = (message) => {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Extension was reloaded; the page must be refreshed.
    }
  };

  // ------------------------------------------------------------------ bridge
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.__xmonitor !== true || data.kind !== 'graphql') return;
    send({
      type: 'CAPTURE',
      op: data.op || '',
      url: data.url || '',
      pageUrl: location.href,
      status: data.status || 0,
      payload: data.payload ?? null,
    });
  });

  // ----------------------------------------------------------- account detect
  let lastHint = { handle: '', name: '', avatar: '', at: 0 };
  let lastDetectAt = 0;

  function readSwitcher() {
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (!switcher) return { handle: '', name: '', avatar: '' };

    const text = switcher.innerText || switcher.textContent || '';
    const match = text.match(/@([A-Za-z0-9_]{1,15})/);
    const handle = match ? match[1] : '';
    const img = switcher.querySelector('img');
    const avatar = img?.src || '';

    let name = '';
    if (handle) {
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      const handleLine = lines.find((line) => line.startsWith('@'));
      name = lines.filter((line) => line !== handleLine).join(' ').trim();
      if (name.includes('@')) name = name.split('@')[0].trim();
    }
    return { handle, name, avatar };
  }

  function detectSelf(force = false) {
    const now = Date.now();
    if (!force && now - lastDetectAt < 800) return;
    lastDetectAt = now;

    let hint = readSwitcher();

    if (!hint.handle) {
      // Fallbacks for layouts without the account switcher: the profile tab,
      // or the "edit profile" button on your own profile page.
      const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      const href = profileLink?.getAttribute('href') || '';
      const fromLink = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      if (fromLink) hint = { ...hint, handle: fromLink[1] };

      if (!hint.handle && document.querySelector('[data-testid="editProfileButton"]')) {
        const fromPath = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
        if (fromPath) hint = { ...hint, handle: fromPath[1] };
      }
    }

    if (!hint.handle) return;

    const changed = hint.handle.toLowerCase() !== lastHint.handle.toLowerCase();
    if (!force && !changed && now - lastHint.at < 5 * 60_000) return;
    if (changed) lastHint = { handle: hint.handle, name: '', avatar: '', at: 0 };

    const nextName = hint.name || lastHint.name;
    const nextAvatar = hint.avatar || lastHint.avatar;
    if (!changed && !nextName && !nextAvatar) return;

    lastHint = { handle: hint.handle, name: nextName, avatar: nextAvatar, at: now };
    send({ type: 'SELF_HINT', self: { handle: hint.handle, name: nextName, avatar: nextAvatar } });
  }

  // The side nav renders early; watch the first paint, then fall back to a slow
  // poll so a long-lived tab still notices an account switch.
  const earlyObserver = new MutationObserver(() => detectSelf());
  if (document.documentElement) {
    earlyObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  setTimeout(() => detectSelf(true), 1200);
  setTimeout(() => detectSelf(true), 4000);
  setTimeout(() => earlyObserver.disconnect(), 45_000);
  setInterval(() => detectSelf(), 45_000);

  // X is a SPA: the switcher persists, but the profile page changes.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      detectSelf();
    }
  }, 2000);
})();
