import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const person = (id) => ({ id: String(id), handle: `user${id}`, name: `User ${id}` });
const page = (requestCursor, people, { bottomCursor = '', reachedEnd = false, ...rest } = {}) => ({
  owner: 'testuser', ownerId: '42', requestCursor, people, bottomCursor,
  reachedEnd, expected: 2, valid: true, ...rest,
});

function boot(path = '/testuser/followers') {
  let listener;
  let bridge;
  const messages = [];
  const location = { hostname: 'x.com', origin: 'https://x.com', pathname: path, href: `https://x.com${path}` };
  const window = {
    innerHeight: 800,
    scrollTo() {},
    dispatchEvent() {},
    addEventListener(_name, fn) { bridge = fn; },
  };
  vm.runInNewContext(source, {
    window, location, Event,
    document: {
      documentElement: { scrollHeight: 1000 },
      body: { scrollHeight: 1000 },
      querySelector: () => null,
    },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage(message) { messages.push(structuredClone(message)); return Promise.resolve({ ok: true }); },
    } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(fn, delay) { return delay <= 650 ? setTimeout(fn, 1) : 0; },
    clearTimeout,
    setInterval() {},
  });
  const emit = (data) => bridge({
    source: window, origin: location.origin, data: { __xmonitor: true, kind: 'followers-page', ...data },
  });
  const start = (overrides = {}) => {
    let answer;
    const ret = listener({
      type: 'FOLLOWERS_COLLECT', handle: 'testuser', accountId: '42',
      since: Date.now() - 100, captureId: 'capture-1', ...overrides,
    }, {}, (value) => { answer = structuredClone(value); });
    return { ret, answer };
  };
  const result = async () => {
    for (let n = 0; n < 100; n += 1) {
      const found = messages.find((message) => message.type === 'FOLLOWERS_RESULT');
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('content script did not report a result');
  };
  return { emit, start, result, messages, location };
}

test('start is acknowledged immediately and retries of the same run are idempotent', async () => {
  const content = boot();
  content.emit(page('', [person(1)], { bottomCursor: 'next' }));
  const first = content.start();
  assert.equal(first.answer.ok, true, 'the answer does not wait for scrolling');
  assert.equal(first.ret, undefined, 'the message channel does not stay open');
  assert.equal(content.start().answer.ok, true, 'retry is the same run, not BUSY');
  assert.equal(content.start({ captureId: 'other' }).answer.error, 'BUSY');
  content.emit(page('next', [person(2)], { reachedEnd: true }));
  const result = await content.result();
  assert.equal(result.reachedEnd, true);
  assert.deepEqual(result.entries.map((entry) => entry.id), ['1', '2']);
  assert.equal(content.messages.filter((message) => message.type === 'FOLLOWERS_RESULT').length, 1);
});

test('a pagination gap cannot look like a complete list', async () => {
  const content = boot();
  content.emit(page('missing-first-page', [person(2)], { reachedEnd: true }));
  content.start();
  const result = await content.result();
  assert.equal(result.reachedEnd, false);
  assert.deepEqual(result.entries, []);
});

test('wrong owners and suggested DOM cells cannot enter the snapshot', async () => {
  const content = boot();
  content.emit(page('', [person(9)], { owner: 'stranger', reachedEnd: true }));
  content.emit(page('', [person(1), person(2)], { reachedEnd: true }));
  content.start();
  const result = await content.result();
  assert.deepEqual(result.entries.map((entry) => entry.id), ['1', '2']);
});

test('an owner id mismatch or unsupported page fails closed', async () => {
  for (const extra of [{ ownerId: '999' }, { valid: false }]) {
    const content = boot();
    content.emit(page('', [person(1)], { reachedEnd: true, ...extra }));
    content.start();
    assert.equal((await content.result()).reachedEnd, false);
  }
});

test('changing counters during pagination does not produce a trusted list', async () => {
  const content = boot();
  content.emit(page('', [person(1)], { bottomCursor: 'next', expected: 2 }));
  content.emit(page('next', [person(2)], { reachedEnd: true, expected: 3 }));
  content.start();
  assert.equal((await content.result()).reachedEnd, false);
});

test('a capture cannot start on another page or an old document', () => {
  assert.equal(boot('/home').start().answer.error, 'NO_ANSWER');
  assert.equal(boot().start({ since: Date.now() + 1000 }).answer.error, 'NO_ANSWER');
});

test('navigating away while scrolling makes the capture incomplete', async () => {
  const content = boot();
  content.emit(page('', [person(1)], { bottomCursor: 'next' }));
  content.start();
  content.location.pathname = '/home';
  assert.equal((await content.result()).reachedEnd, false);
});
