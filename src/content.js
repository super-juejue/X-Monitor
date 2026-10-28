/**
 * Isolated-world content script.
 *
 * 1. Relays captured GraphQL payloads from the page hook to the worker.
 * 2. Reads the logged-in handle/name/avatar off the page chrome.
 * 3. Reads the counts off your own profile header, because X caches its API
 *    responses: a revisit can refresh the page without any request the hook
 *    could see.
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
      payload: data.payload ?? null,
    });
  });

  // ------------------------------------------------------------------ numbers

  /** "1,284" / "12.3K" / "1.2万" -> 1284 / 12300 / 12000 */
  function parseCount(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const match = text.match(/([\d.,]+)\s*(K|M|B|万|亿)?/i);
    if (!match) return null;
    let value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    const suffix = (match[2] || '').toUpperCase();
    if (suffix === 'K') value *= 1_000;
    else if (suffix === 'M') value *= 1_000_000;
    else if (suffix === 'B') value *= 1_000_000_000;
    else if (suffix === '万') value *= 10_000;
    else if (suffix === '亿') value *= 100_000_000;
    return Math.round(value);
  }

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

  /** The profile being viewed, if the page proves it belongs to you. */
  function ownProfileHandle() {
    const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (!match) return '';
    const onPage = match[1];
    // The edit button only renders on your own profile.
    if (document.querySelector('[data-testid="editProfileButton"]')) return onPage;
    const known = readSwitcher().handle;
    if (known && known.toLowerCase() === onPage.toLowerCase()) return onPage;
    return '';
  }

  /**
   * Follower counts are links in the profile header; the post count is a line
   * of text above the bio. Both are laid out differently per language, so the
   * text match stays deliberately loose.
   */
  function readProfileCounts(handle) {
    const followersLink = document.querySelector('a[href$="/followers"], a[href$="/verified_followers"]');
    const followingLink = document.querySelector(`a[href="/${handle}/following"], a[href$="/following"]`);
    const followers = followersLink ? parseCount(followersLink.innerText || followersLink.textContent) : null;
    const following = followingLink ? parseCount(followingLink.innerText || followingLink.textContent) : null;

    let posts = null;
    const scope = followersLink?.closest('div')?.parentElement
      || document.querySelector('[data-testid="primaryColumn"]')
      || document.body;
    if (scope) {
      const pattern = /^([\d.,]+\s*(?:K|M|B|万|亿)?)\s*(?:posts?|帖子|貼文|推文)$/i;
      for (const el of scope.querySelectorAll('div, span')) {
        if (el.children.length > 2) continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 28) continue;
        const match = text.match(pattern);
        if (!match) continue;
        posts = parseCount(match[1]);
        if (posts !== null) break;
      }
    }

    const counts = {};
    if (followers !== null) counts.followers = followers;
    if (following !== null) counts.following = following;
    if (posts !== null) counts.tweets = posts;
    return Object.keys(counts).length ? counts : null;
  }

  /** Name and handle as rendered on the profile page. */
  function readProfileIdentity() {
    const nameBlock = document.querySelector('[data-testid="UserName"]');
    const text = nameBlock?.innerText || nameBlock?.textContent || '';
    const handleMatch = text.match(/@([A-Za-z0-9_]{1,15})/);
    const handle = handleMatch ? handleMatch[1] : '';
    let name = '';
    if (handle) {
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      const handleLine = lines.find((line) => line.startsWith('@'));
      name = lines.filter((line) => line !== handleLine).join(' ').trim();
    }
    const avatar = document.querySelector('[data-testid="primaryColumn"] img[src*="profile_images"]')?.src || '';
    return { handle, name, avatar };
  }

  let lastProfileSent = '';
  function reportOwnProfile(force = false) {
    const onPage = ownProfileHandle();
    if (!onPage) return;
    const identity = readProfileIdentity();
    const counts = readProfileCounts(onPage);
    if (!counts) return;
    const payload = JSON.stringify({ onPage, counts });
    if (!force && payload === lastProfileSent) return;
    lastProfileSent = payload;
    send({
      type: 'PROFILE_HINT',
      hint: {
        handle: onPage,
        name: identity.handle && identity.handle.toLowerCase() === onPage.toLowerCase() ? identity.name : '',
        verified: Boolean(document.querySelector('[data-testid="editProfileButton"]')),
        counts,
      },
    });
  }

  // ----------------------------------------------------------- account detect
  let lastHint = { handle: '', name: '', avatar: '', at: 0 };
  let lastDetectAt = 0;

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

      if (!hint.handle) {
        const onPage = ownProfileHandle();
        if (onPage) hint = { ...hint, ...readProfileIdentity(), handle: onPage };
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

  function scan() {
    detectSelf();
    reportOwnProfile();
  }

  // The side nav renders early; watch the first paint, then fall back to a slow
  // poll so a long-lived tab still notices an account switch.
  const earlyObserver = new MutationObserver(() => scan());
  if (document.documentElement) {
    earlyObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  setTimeout(() => { detectSelf(true); reportOwnProfile(true); }, 1200);
  setTimeout(() => { detectSelf(true); reportOwnProfile(true); }, 4000);
  setTimeout(() => earlyObserver.disconnect(), 45_000);
  setInterval(() => scan(), 45_000);

  // X is a SPA. A cached profile can paint without any request the hook sees,
  // so poll briefly after every navigation.
  let lastHref = location.href;
  let settleTimer = null;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    detectSelf();
    const ticks = [600, 1400, 2600, 4200];
    for (const delay of ticks) setTimeout(() => reportOwnProfile(), delay);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => reportOwnProfile(true), 6000);
  }, 1000);
})();
