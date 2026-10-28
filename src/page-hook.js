/**
 * Runs in the page's MAIN world at document_start.
 *
 * X loads everything through /i/api/graphql. We passively observe the responses
 * the logged-in browser already receives and forward the ones that describe an
 * account. No extra requests, no bearer token, no API key.
 *
 * Three kinds of response matter:
 *   Viewer*            who is logged in (the only authoritative source)
 *   UserByScreenName*  a profile, with its counts
 *   Followers/Following  the list owner also carries counts, but the payload is
 *                        huge, so only the owner is forwarded
 *
 * Everything else is ignored — nothing is stored from tweets or people lists.
 */
(() => {
  'use strict';

  if (window.__xMonitorHooked) return;
  window.__xMonitorHooked = true;

  function opFromUrl(url) {
    try {
      const parts = new URL(url, location.origin).pathname.split('/').filter(Boolean);
      const i = parts.indexOf('graphql');
      return i >= 0 ? parts[i + 2] || '' : '';
    } catch {
      return '';
    }
  }

  /** Which payload shape an operation produces, or '' to ignore it. */
  function kindOf(op) {
    if (op.startsWith('Viewer')) return 'viewer';
    if (op.startsWith('UserByScreenName') || op === 'UserByRestId' || op === 'UsersByRestIds') return 'profile';
    if (op === 'Followers' || op === 'Following' || op === 'BlueVerifiedFollowers') return 'owner';
    return '';
  }

  function shouldCapture(url) {
    if (!url || !String(url).includes('/i/api/graphql/')) return false;
    return Boolean(kindOf(opFromUrl(url)));
  }

  const COUNT_KEYS = [
    'followers_count',
    'friends_count',
    'statuses_count',
    'favourites_count',
    'media_count',
    'listed_count',
    'screen_name',
    'name',
    'profile_image_url_https',
  ];

  /**
   * A followers timeline is megabytes of people we do not use. Keep only the
   * owner's identity and counts so postMessage stays cheap.
   */
  function ownerOnly(payload) {
    const root = payload?.data ?? payload;
    const result = root?.user?.result ?? root?.user_result?.result;
    if (!result || typeof result !== 'object') return null;
    const src = result.__typename === 'UserWithVisibilityResults' ? result.user : result;
    if (!src || typeof src !== 'object') return null;

    const legacy = src.legacy && typeof src.legacy === 'object' ? src.legacy : {};
    const slimLegacy = {};
    for (const key of COUNT_KEYS) {
      if (legacy[key] !== undefined) slimLegacy[key] = legacy[key];
    }
    return {
      data: {
        user: {
          result: {
            __typename: src.__typename || 'User',
            rest_id: src.rest_id || null,
            core: src.core && typeof src.core === 'object' ? src.core : null,
            avatar: src.avatar && typeof src.avatar === 'object' ? src.avatar : null,
            is_blue_verified: Boolean(src.is_blue_verified),
            legacy: slimLegacy,
          },
        },
      },
    };
  }

  function post(url, payload) {
    try {
      window.postMessage(
        {
          __xmonitor: true,
          kind: 'graphql',
          op: opFromUrl(url),
          url: String(url),
          payload,
        },
        location.origin,
      );
    } catch {
      // Structured clone can fail on exotic payloads; ignore.
    }
  }

  function handleResponse(url, status, readJson) {
    if (status < 200 || status >= 300) return;
    const kind = kindOf(opFromUrl(url));
    if (!kind) return;
    readJson()
      .then((payload) => {
        if (kind !== 'owner') {
          post(url, payload);
          return;
        }
        const trimmed = ownerOnly(payload);
        if (trimmed) post(url, trimmed);
      })
      .catch(() => {});
  }

  // --- fetch ---------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function xMonitorFetch(input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : input?.url || String(input);
      } catch {
        url = '';
      }
      const promise = originalFetch.apply(this, arguments);
      if (url && shouldCapture(url)) {
        promise
          .then((response) => {
            try {
              const contentType = response.headers.get('content-type') || '';
              if (!/json/i.test(contentType)) return;
              handleResponse(url, response.status, () => response.clone().json());
            } catch {
              // ignore
            }
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  // --- XMLHttpRequest (older clients) --------------------------------------
  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto) {
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    xhrProto.open = function xMonitorOpen(method, url) {
      try {
        this.__xMonitorUrl = url;
      } catch {
        // ignore
      }
      return originalOpen.apply(this, arguments);
    };
    xhrProto.send = function xMonitorSend() {
      try {
        const url = this.__xMonitorUrl;
        if (url && shouldCapture(url)) {
          this.addEventListener('load', () => {
            try {
              handleResponse(url, this.status, () => Promise.resolve(JSON.parse(this.responseText)));
            } catch {
              // ignore
            }
          });
        }
      } catch {
        // ignore
      }
      return originalSend.apply(this, arguments);
    };
  }
})();
