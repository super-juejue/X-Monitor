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
 *                        huge, so only identity is forwarded. A Followers page
 *                        additionally yields the people on that page, because a
 *                        snapshot has to know who is in the list.
 *
 * Everything else is ignored — nothing is stored from tweets.
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

  /**
   * One page of a followers timeline, reduced to the parts a snapshot needs:
   * who is on it, whether this is the end, and the cursor for the next page.
   *
   * Cursors for the next page live in a cursor entry, not in the people, so the
   * caller that wants a full list knows whether to keep scrolling.
   */
  function followersPage(payload, request) {
    const root = payload?.data ?? payload;
    const raw = root?.user?.result ?? root?.user_result?.result;
    const result = raw?.__typename === 'UserWithVisibilityResults' ? raw.user : raw;
    if (!result || typeof result !== 'object') return null;

    const instructions = result.timeline?.timeline?.instructions || result.timeline_v2?.timeline?.instructions;
    const people = [];
    const seen = new Set();
    let bottomCursor = '';
    let bottomSeen = false;
    let recognized = false;
    let terminal = false;
    let entryCount = 0;
    let valid = Array.isArray(instructions) && !payload?.errors?.length;

    const add = (raw) => {
      const src = raw?.__typename === 'UserWithVisibilityResults' ? raw.user : raw;
      if (!src || typeof src !== 'object') return;
      if (src.__typename === 'UserUnavailable') {
        valid = false;
        return;
      }
      const id = src.rest_id || src.id_str ? String(src.rest_id || src.id_str) : '';
      const handle = (src.core?.screen_name || src.legacy?.screen_name || '').trim();
      if (!id) {
        valid = false;
        return;
      }
      const key = id || handle.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      people.push({
        id,
        handle,
        name: String(src.core?.name || src.legacy?.name || handle).slice(0, 60),
      });
    };

    const readEntries = (entries) => {
      for (const entry of Array.isArray(entries) ? entries : []) {
        entryCount += 1;
        const content = entry?.content;
        if (content?.promotedMetadata || /who-to-follow|suggest|recommend|promoted/i.test(entry?.entryId || '')) continue;
        if (content?.itemContent?.user_results?.result) {
          add(content.itemContent.user_results.result);
        }
        for (const sub of Array.isArray(content?.items) ? content.items : []) {
          const item = sub?.item?.itemContent;
          if (item?.user_results?.result) add(item.user_results.result);
        }
        if (content?.entryType === 'TimelineTimelineCursor' || content?.cursorType) {
          const type = String(content.cursorType || '').toLowerCase();
          if (type === 'bottom') {
            bottomSeen = true;
            bottomCursor = String(content.value || '');
          }
        }
      }
    };

    for (const instruction of Array.isArray(instructions) ? instructions : []) {
      if (Array.isArray(instruction?.entries) || instruction?.entry) {
        recognized = true;
        readEntries(instruction.entries);
        if (instruction.entry) readEntries([instruction.entry]);
      }
      if (instruction?.type === 'TimelineTerminateTimeline' && String(instruction.direction).toLowerCase() === 'bottom') {
        terminal = true;
        recognized = true;
      }
    }

    valid = valid && recognized;
    const expected = result.legacy?.followers_count;
    return {
      owner: String(result.core?.screen_name || result.legacy?.screen_name || ''),
      ownerId: String(result.rest_id || request.userId || ''),
      requestCursor: request.cursor || '',
      people,
      bottomCursor,
      expected: Number.isSafeInteger(expected) && expected >= 0 ? expected : null,
      valid,
      reachedEnd: valid && (terminal
        || (people.length > 0 && !bottomSeen)
        || (bottomSeen && Boolean(request.cursor) && bottomCursor === request.cursor)
        || (people.length === 0 && (bottomSeen || entryCount === 0))),
    };
  }

  function requestVariables(url, body) {
    try {
      const query = new URL(url, location.origin).searchParams.get('variables');
      let variables = query ? JSON.parse(query) : typeof body === 'string' ? JSON.parse(body).variables : {};
      if (typeof variables === 'string') variables = JSON.parse(variables);
      return {
        cursor: typeof variables?.cursor === 'string' ? variables.cursor : '',
        userId: variables?.userId == null ? '' : String(variables.userId),
      };
    } catch {
      return {};
    }
  }

  function handleResponse(url, status, readJson, request = {}) {
    if (status < 200 || status >= 300) return;
    const kind = kindOf(opFromUrl(url));
    if (!kind) return;
    readJson()
      .then(async (payload) => {
        if (kind !== 'owner') {
          post(url, payload);
          return;
        }
        const trimmed = ownerOnly(payload);
        if (!trimmed) return;

        if (opFromUrl(url) !== 'Followers') {
          post(url, trimmed);
          return;
        }

        // The owner keeps the counts path working exactly as before; the people
        // travel alongside it so the shape other readers expect is unchanged.
        const page = followersPage(payload, await request);
        if (!page) {
          post(url, trimmed);
          return;
        }
        post(url, trimmed);
        window.postMessage(
          {
            __xmonitor: true,
            kind: 'followers-page',
            op: 'Followers',
            url: String(url),
            ...page,
          },
          location.origin,
        );
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
      const capture = url && shouldCapture(url);
      let request = {};
      if (capture && opFromUrl(url) === 'Followers') {
        try {
          request = requestVariables(url, init?.body);
          if (!init?.body && typeof input?.clone === 'function' && input.method !== 'GET') {
            request = input.clone().text().then((body) => requestVariables(url, body)).catch(() => ({}));
          }
        } catch {
          // Observing a used Request must never break the page's fetch.
        }
      }
      const promise = originalFetch.apply(this, arguments);
      if (capture) {
        promise
          .then((response) => {
            try {
              const contentType = response.headers.get('content-type') || '';
              if (!/json/i.test(contentType)) return;
              handleResponse(url, response.status, () => response.clone().json(), request);
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
              handleResponse(url, this.status, () => Promise.resolve(JSON.parse(this.responseText)),
                requestVariables(url, arguments[0]));
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
