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

  /**
   * Identifies this document for as long as it lives, starting with the moment
   * it was created. A refresh only accepts numbers from a document born after
   * it started: the page being replaced keeps a few timers alive, and its last
   * report carries the numbers that are already on screen.
   */
  const DOC = `${Date.now()}~${Math.random().toString(36).slice(2, 8)}`;

  const send = (message) => {
    try {
      const result = chrome.runtime.sendMessage({ ...message, doc: DOC });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Extension was reloaded; the page must be refreshed.
    }
  };

  // ------------------------------------------------------------------ bridge
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.__xmonitor !== true) return;

    if (data.kind === 'followers-page') {
      bufferPage(data);
      return;
    }

    if (data.kind !== 'graphql') return;
    send({
      type: 'CAPTURE',
      op: data.op || '',
      url: data.url || '',
      pageUrl: location.href,
      payload: data.payload ?? null,
    });
  });

  // ------------------------------------------------------------- follower list

  // A capture always gets a fresh document. Buffer its first response, which
  // can arrive before the worker's start message, but never mix different lists.
  const pages = new Map();
  const MAX_BUFFERED = 30_000;
  const MAX_PAGES = 400;
  let run = null;
  let overflow = false;
  let buffered = 0;

  function onFollowersPage(handle) {
    const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/followers\/?$/i);
    return Boolean(match && (!handle || match[1].toLowerCase() === handle.toLowerCase()));
  }

  function bufferPage(page) {
    if (!onFollowersPage() || !page || !Array.isArray(page.people)) return;
    if (page.owner && !onFollowersPage(page.owner)) return;
    const cursor = String(page.requestCursor || '');
    if (pages.has(cursor)) return;
    if (pages.size >= MAX_PAGES || buffered + page.people.length > MAX_BUFFERED) {
      overflow = true;
      return;
    }
    buffered += page.people.length;
    pages.set(cursor, page);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A small nudge retriggers loading when the last scroll hit a busy loader. */
  async function scrollToBottom() {
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const scroller = column && column.scrollHeight > column.clientHeight ? column : null;
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 160);
    window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - window.innerHeight - 160));
    await sleep(50);
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      // Chrome can defer native scroll events in an inactive tab. Notify the
      // page's loader as well, without fetching or clicking anything ourselves.
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    window.dispatchEvent(new Event('scroll'));
  }

  /** Only pages linked all the way from the first cursor belong to this run. */
  function readList(handle, accountId) {
    const people = new Map();
    const visited = new Set();
    let cursor = '';
    let reachedEnd = false;
    let expected = null;
    let valid = !overflow;
    let ownerId = accountId;
    let reason = '';

    while (pages.has(cursor) && !visited.has(cursor)) {
      visited.add(cursor);
      const page = pages.get(cursor);
      // On a fresh /handle/followers document, the initial request supplies
      // the owner id even when the response contains only timeline data.
      if (!ownerId && page.ownerId) ownerId = String(page.ownerId);
      const ownerMatches = page.owner
        ? page.owner.toLowerCase() === handle.toLowerCase()
        : Boolean(ownerId && page.ownerId === ownerId);
      if (!ownerMatches || (ownerId && page.ownerId && page.ownerId !== ownerId)) {
        valid = false;
        reason ||= 'OWNER';
      }
      if (page.valid !== true) {
        valid = false;
        reason ||= 'FORMAT';
      }
      if (Number.isSafeInteger(page.expected) && page.expected >= 0) {
        if (expected !== null && expected !== page.expected) {
          valid = false;
          reason ||= 'COUNT_CHANGED';
        }
        expected = page.expected;
      }
      for (const person of page.people) {
        if (!person?.id) {
          valid = false;
          reason ||= 'FORMAT';
          continue;
        }
        people.set(String(person.id), person);
        if (people.size > MAX_BUFFERED) {
          return { entries: [], reachedEnd: false, tooLarge: true, pages: visited.size, expected };
        }
      }
      if (page.reachedEnd) {
        reachedEnd = true;
        break;
      }
      if (!page.bottomCursor || page.bottomCursor === cursor) break;
      cursor = page.bottomCursor;
    }
    return {
      entries: [...people.values()],
      reachedEnd: valid && reachedEnd,
      tooLarge: overflow,
      pages: visited.size,
      expected,
      ownerId,
      reason: reason || (visited.size === 0 ? 'NO_PAGES' : reachedEnd ? '' : 'CURSOR_GAP'),
    };
  }

  /**
   * Walk the whole follower list. Resolves once X stops serving new people, and
   * says whether it actually reached the end, because a capture that stopped
   * early must never be compared with the previous one.
   */
  async function collectFollowers(current) {
    const deadline = Date.now() + 45_000;
    let idle = 0;
    let lastSize = -1;
    let lastProgress = 0;
    let list = readList(current.handle, current.accountId);

    while (Date.now() < deadline) {
      if (!onFollowersPage(current.handle)) break;
      if (list.reachedEnd || list.tooLarge || ['OWNER', 'FORMAT', 'COUNT_CHANGED'].includes(list.reason)) break;
      await scrollToBottom();
      await sleep(650);
      list = readList(current.handle, current.accountId);
      idle = list.entries.length === lastSize ? idle + 1 : 0;
      lastSize = list.entries.length;
      if (Date.now() - lastProgress >= 2000) {
        lastProgress = Date.now();
        // Also keeps the service worker alive during a long, slow scroll.
        send({
          type: 'FOLLOWERS_PROGRESS',
          captureId: current.id,
          handle: current.handle,
          captured: lastSize,
          pages: list.pages,
        });
      }
      if (list.pages >= MAX_PAGES || idle >= 8) break;
    }

    return {
      ...list,
      handle: current.handle,
      captureId: current.id,
      reachedEnd: onFollowersPage(current.handle) && list.reachedEnd,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'FOLLOWERS_COLLECT') return undefined;

    const handle = String(message.handle || '').replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || !onFollowersPage(handle)
      || !message.captureId || Number(message.since) > documentStart()) {
      sendResponse({ ok: false, error: 'NO_ANSWER' });
      return undefined;
    }
    if (run?.id === message.captureId) {
      sendResponse({ ok: true, doc: DOC });
      return undefined;
    }
    if (run) {
      sendResponse({ ok: false, error: 'BUSY' });
      return undefined;
    }
    run = { id: message.captureId, handle, accountId: String(message.accountId || '') };
    // Acknowledge before scrolling. Holding this response open let retries
    // start a second run and report BUSY while the first one was still working.
    sendResponse({ ok: true, doc: DOC });
    collectFollowers(run)
      .then((result) => send({ type: 'FOLLOWERS_RESULT', ...result }))
      .catch(() => send({
        type: 'FOLLOWERS_RESULT',
        captureId: run.id,
        handle,
        entries: [],
        reachedEnd: false,
      }));
    return undefined;
  });

  function documentStart() {
    return Number(DOC.split('~')[0]);
  }

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
    const counter = readFollowerCounter(followersLink);
    const followers = counter.value;
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
    return Object.keys(counts).length ? { counts, followersExact: counter.exact } : null;
  }

  /** A tooltip can carry the exact number while the visible label says "1.2K". */
  function readFollowerCounter(link) {
    if (!link) return { value: null, exact: false };
    const labels = [
      link.getAttribute('title'),
      link.querySelector('[title]')?.getAttribute('title'),
      link.getAttribute('aria-label'),
      link.innerText || link.textContent,
    ];
    let fallback = { value: null, exact: false };
    for (const label of labels) {
      const value = parseCount(label);
      if (value === null) continue;
      const match = String(label).match(/([\d.,]+)\s*(K|M|B|万|亿)?/i);
      if (match && !match[2] && Number.isSafeInteger(Number(match[1].replace(/,/g, '')))) {
        return { value, exact: true };
      }
      if (fallback.value === null) fallback = { value, exact: false };
    }
    return fallback;
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
    const reading = readProfileCounts(onPage);
    if (!reading) return;
    const { counts, followersExact } = reading;
    const payload = JSON.stringify({ onPage, counts, followersExact });
    if (!force && payload === lastProfileSent) return;
    lastProfileSent = payload;
    send({
      type: 'PROFILE_HINT',
      hint: {
        handle: onPage,
        name: identity.handle && identity.handle.toLowerCase() === onPage.toLowerCase() ? identity.name : '',
        verified: Boolean(document.querySelector('[data-testid="editProfileButton"]')),
        counts,
        followersExact,
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
