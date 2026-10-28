/**
 * Isolated-world content script.
 *
 * 1. Relays GraphQL payloads from the page hook to the background worker.
 * 2. Detects which X account is logged in from the page chrome.
 * 3. Drives the auto-scroll used by "sync" (kept in the foreground because X
 *    loads more rows only when the tab is visible).
 */
(() => {
  'use strict';

  const host = location.hostname.replace(/^www\./, '');
  if (host !== 'x.com' && host !== 'twitter.com') return;

  /**
   * When this document was created (epoch ms). The worker uses it to tell the
   * reloaded page apart from the stale one it replaced: a scan must never
   * inherit the old page's rows.
   */
  const docStartedAt = () => Math.round(performance.timeOrigin || Date.now());

  const send = (message) => {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Extension was reloaded; the page must be refreshed.
    }
  };

  // ---------------------------------------------------------------- bridge
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

  // -------------------------------------------------------- account detect
  let lastHint = { handle: '', name: '', avatar: '', at: 0 };
  let lastDetectAt = 0;

  function detectSelf(force = false) {
    const now = Date.now();
    if (!force && now - lastDetectAt < 800) return;
    lastDetectAt = now;

    let handle = '';
    let name = '';
    let avatar = '';

    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (switcher) {
      const text = switcher.innerText || switcher.textContent || '';
      const match = text.match(/@([A-Za-z0-9_]{1,15})/);
      if (match) handle = match[1];
      const img = switcher.querySelector('img');
      if (img && img.src) avatar = img.src;
      if (handle) {
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        const handleLine = lines.find((line) => line.startsWith('@'));
        name = lines.filter((line) => line !== handleLine).join(' ').trim();
        if (name.includes('@')) name = name.split('@')[0].trim();
      }
    }

    if (!handle) {
      const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      const href = profileLink?.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      if (match) handle = match[1];
    }

    if (!handle) {
      const editButton = document.querySelector('[data-testid="editProfileButton"]');
      if (editButton) {
        const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
        if (match) handle = match[1];
      }
    }

    if (!handle) return;
    const changed = handle.toLowerCase() !== lastHint.handle.toLowerCase();
    if (!force && !changed && now - lastHint.at < 5 * 60_000) return;
    if (changed) {
      lastHint = { handle, name: '', avatar: '', at: 0 };
    }
    const nextName = name || lastHint.name;
    const nextAvatar = avatar || lastHint.avatar;
    if (!changed && !nextName && !nextAvatar) return;
    lastHint = { handle, name: nextName, avatar: nextAvatar, at: now };
    send({ type: 'SELF_HINT', self: { handle, name: nextName, avatar: nextAvatar } });
  }

  // Watch the first render (side nav appears early), then fall back to a slow
  // poll so long-lived tabs still pick up account switches.
  const earlyObserver = new MutationObserver(() => detectSelf());
  if (document.documentElement) {
    earlyObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  setTimeout(() => detectSelf(true), 1400);
  setTimeout(() => detectSelf(true), 5000);
  setTimeout(() => earlyObserver.disconnect(), 45_000);
  setInterval(() => detectSelf(), 45_000);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      detectSelf();
    }
  }, 2000);

  // ------------------------------------------------------------- auto scroll
  let scrollSession = null;
  let syncPort = null;
  let cachedScroller = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    if (message.type === 'PING') {
      sendResponse({ ok: true, href: location.href, path: pathOf(location.href), docStartedAt: docStartedAt() });
      return undefined;
    }
    if (message.type === 'SYNC_START') {
      startScroll(message);
      sendResponse({ ok: true });
      return undefined;
    }
    if (message.type === 'SYNC_STOP') {
      if (scrollSession && (!message.sessionId || message.sessionId === scrollSession.sessionId)) {
        finishScroll('stopped', false);
      }
      sendResponse({ ok: true });
      return undefined;
    }
    return undefined;
  });

  function pathOf(raw) {
    try {
      return new URL(raw, location.origin).pathname.replace(/\/+$/, '').toLowerCase();
    } catch {
      return '';
    }
  }

  function isLoginPath() {
    return /\/i\/flow\/login|\/i\/flow\/signup|\/login/.test(location.pathname);
  }

  function collectVisibleHandles() {
    const handles = new Set();
    for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
      for (const link of cell.querySelectorAll('a[href^="/"]')) {
        const match = (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
        if (match) {
          handles.add(match[1].toLowerCase());
          break;
        }
      }
    }
    return [...handles];
  }

  function startScroll(options) {
    if (scrollSession) {
      if (scrollSession.sessionId === options.sessionId) return;
      finishScroll('replaced', false);
    }
    const session = {
      sessionId: options.sessionId,
      kind: options.kind || 'followers',
      expectedPath: pathOf(options.url || location.href),
      tickMs: Math.min(3000, Math.max(400, Number(options.tickMs) || 900)),
      maxTicks: Math.min(4000, Math.max(4, Number(options.maxTicks) || 400)),
      startedAt: Date.now(),
      ticks: 0,
      stable: 0,
      hiddenTicks: 0,
      lastHeight: 0,
      lastTop: 0,
      seeded: false,
      timer: null,
      finished: false,
    };
    scrollSession = session;
    cachedScroller = null;

    try {
      syncPort = chrome.runtime.connect({ name: 'x-monitor-sync' });
      syncPort.onDisconnect.addListener(() => {
        if (scrollSession === session && !session.finished) {
          finishScroll('disconnected', false, true);
        }
      });
      syncPort.postMessage({
        type: 'hello',
        sessionId: session.sessionId,
        href: location.href,
        hidden: document.hidden,
      });
    } catch {
      syncPort = null;
    }

    seedVisibleRows(session);
    postProgress(session);
    session.timer = setTimeout(() => tickScroll(session), 500);
  }

  /**
   * A reused tab has already loaded rows before the sync started. Those people
   * were captured earlier, so the worker does not know this scan saw them; tell
   * it explicitly or they look like fresh unfollows.
   */
  function seedVisibleRows(session) {
    if (!syncPort || !session || session.seeded) return;
    const handles = collectVisibleHandles();
    session.seeded = true;
    if (!handles.length) return;
    try {
      syncPort.postMessage({
        type: 'seed',
        sessionId: session.sessionId,
        docStartedAt: docStartedAt(),
        handles,
      });
    } catch {
      // ignore
    }
  }

  function postProgress(session) {
    if (!syncPort || !session) return;
    try {
      syncPort.postMessage({
        type: 'progress',
        sessionId: session.sessionId,
        ticks: session.ticks,
        stable: session.stable,
        href: location.href,
        hidden: document.hidden,
        usersInDom: document.querySelectorAll('[data-testid="UserCell"]').length,
      });
    } catch {
      // ignore
    }
  }

  function getScroller() {
    if (cachedScroller && cachedScroller.isConnected) return cachedScroller;
    let best = document.scrollingElement || document.documentElement;
    let node = document.querySelector('[data-testid="primaryColumn"]');
    while (node && node !== document.body) {
      try {
        const style = getComputedStyle(node);
        const overflow = `${style.overflowY} ${style.overflow}`;
        if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight + 80) {
          best = node;
          break;
        }
      } catch {
        // ignore
      }
      node = node.parentElement;
    }
    cachedScroller = best;
    return best;
  }

  function scrollToBottom(scroller) {
    const doc = document.scrollingElement || document.documentElement;
    const target = Math.max(scroller.scrollHeight || 0, doc.scrollHeight || 0);
    try {
      if (scroller === doc || scroller === document.documentElement || scroller === document.body) {
        window.scrollTo(0, target);
      } else {
        scroller.scrollTop = target;
      }
    } catch {
      // ignore
    }
  }

  function currentMetrics(scroller) {
    const doc = document.scrollingElement || document.documentElement;
    const height = Math.max(scroller.scrollHeight || 0, doc.scrollHeight || 0);
    const top = scroller === doc ? window.scrollY || doc.scrollTop || 0 : scroller.scrollTop || 0;
    return { height, top };
  }

  function tickScroll(session) {
    if (scrollSession !== session || session.finished) return;
    if (isLoginPath()) {
      finishScroll('login_required', false);
      return;
    }
    if (pathOf(location.href) !== session.expectedPath) {
      finishScroll('navigated', false);
      return;
    }

    // Keep scrolling even when the tab is in the background: browsers throttle
    // hidden tabs but they still scroll and still load. Skipping the scroll
    // entirely would leave the scan stuck until the watchdog fires.
    const hidden = document.hidden;
    const scroller = getScroller();
    scrollToBottom(scroller);
    session.ticks += 1;
    session.hiddenTicks = hidden ? session.hiddenTicks + 1 : session.hiddenTicks;
    postProgress(session);
    const wait = hidden ? Math.max(session.tickMs, 1200) : session.tickMs;
    session.timer = setTimeout(() => afterScroll(session, scroller), wait);
  }

  function afterScroll(session, scroller) {
    if (scrollSession !== session || session.finished) return;
    const { height, top } = currentMetrics(scroller);
    const grew = height > session.lastHeight + 4;
    const moved = Math.abs(top - session.lastTop) > 4;
    if (!grew && !moved) session.stable += 1;
    else session.stable = 0;
    if (height > session.lastHeight) session.lastHeight = height;
    session.lastTop = top;

    postProgress(session);

    if (session.kind !== 'tweets' && session.stable >= 4 && session.stable % 4 === 0) {
      // Scroll up a little so X re-evaluates the loader. At the real end this
      // provokes the empty-cursor response the background waits for.
      try {
        const up = Math.max(0, top - 400);
        if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
          window.scrollTo(0, up);
        } else {
          scroller.scrollTop = up;
        }
      } catch {
        // ignore
      }
    }

    if (session.ticks >= session.maxTicks) {
      finishScroll('max_ticks', false);
      return;
    }
    // A timeline that stops growing for a while is the practical end of the
    // list; the background decides whether that is trustworthy enough to
    // treat the scan as complete.
    const stallLimit = session.kind === 'tweets' ? 8 : 12;
    if (session.stable >= stallLimit) {
      // The timeline stopped growing after nudging, which is the DOM-level
      // "end of list" signal. A scan that stalled while the tab was hidden is
      // not trustworthy: X pauses loading in background tabs, so the stall may
      // simply mean "throttled", not "finished".
      finishScroll('stalled', !document.hidden);
      return;
    }
    session.timer = setTimeout(() => tickScroll(session), 120);
  }

  function finishScroll(reason, endReached, silent = false) {
    const session = scrollSession;
    if (!session || session.finished) return;
    session.finished = true;
    scrollSession = null;
    if (session.timer) clearTimeout(session.timer);
    if (!silent && syncPort) {
      try {
        syncPort.postMessage({
          type: 'finish',
          sessionId: session.sessionId,
          reason,
          endReached: Boolean(endReached),
          ticks: session.ticks,
          href: location.href,
        });
      } catch {
        // ignore
      }
    }
    const port = syncPort;
    syncPort = null;
    setTimeout(() => {
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
    }, 250);
  }
})();
