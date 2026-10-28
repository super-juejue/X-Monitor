/**
 * Runs in the page's MAIN world at document_start.
 *
 * X loads everything it needs through /i/api/graphql. We passively observe the
 * responses the logged-in browser already receives and forward the useful ones
 * to the isolated content script. No extra network requests, no bearer token,
 * no API keys.
 */
(() => {
  'use strict';

  if (window.__xMonitorHooked) return;
  window.__xMonitorHooked = true;

  const OPS = new Set([
    'UserByScreenName',
    'UserByScreenNameV2',
    'Followers',
    'Following',
    'UserTweets',
    'UserTweetsAndReplies',
    'UserMedia',
    'Viewer',
  ]);

  function opFromUrl(url) {
    try {
      const parts = new URL(url, location.origin).pathname.split('/').filter(Boolean);
      const i = parts.indexOf('graphql');
      return i >= 0 ? parts[i + 2] || '' : '';
    } catch {
      return '';
    }
  }

  function shouldCapture(url) {
    if (!url || !String(url).includes('/i/api/graphql/')) return false;
    const op = opFromUrl(url);
    return OPS.has(op) || op.startsWith('UserByScreenName') || op.startsWith('UserTweets');
  }

  function post(url, status, payload) {
    try {
      window.postMessage(
        {
          __xmonitor: true,
          kind: 'graphql',
          op: opFromUrl(url),
          url: String(url),
          status,
          payload,
        },
        location.origin,
      );
    } catch {
      // Structured clone can fail on exotic payloads; ignore.
    }
  }

  function handleResponse(url, status, readJson) {
    if (!shouldCapture(url)) return;
    try {
      if (status === 429) {
        post(url, status, null);
        return;
      }
      if (status < 200 || status >= 300) return;
      readJson()
        .then((payload) => post(url, status, payload))
        .catch(() => {});
    } catch {
      // Never let monitoring break the page.
    }
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
